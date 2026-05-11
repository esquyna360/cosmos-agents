use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

use crate::status_fsm::{Status, StatusFsm};

const BUFFER_CAP: usize = 1_000_000;
const TICK_INTERVAL: Duration = Duration::from_millis(400);

#[derive(Serialize, Clone)]
struct StatusEvent {
    id: String,
    status: Status,
}

struct AgentInner {
    id: String,
    buffer: Mutex<Vec<u8>>,
    channel: Mutex<Option<Channel<InvokeResponseBody>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    fsm: Mutex<StatusFsm>,
    app: AppHandle,
}

pub struct PtySupervisor {
    agents: Mutex<HashMap<String, Arc<AgentInner>>>,
}

impl PtySupervisor {
    pub fn new() -> Self {
        Self {
            agents: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self) -> Vec<String> {
        self.agents.lock().unwrap().keys().cloned().collect()
    }

    pub fn status(&self, id: &str) -> Option<Status> {
        let agents = self.agents.lock().unwrap();
        let inner = agents.get(id).cloned()?;
        drop(agents);
        let s = inner.fsm.lock().unwrap().state();
        Some(s)
    }

    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        cwd: String,
        program: String,
        args: Vec<String>,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        if self.agents.lock().unwrap().contains_key(&id) {
            return Err(anyhow!("pty id `{id}` already exists"));
        }

        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(program);
        for a in args {
            cmd.arg(a);
        }
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let writer = pair.master.take_writer()?;
        let mut reader = pair.master.try_clone_reader()?;

        let inner = Arc::new(AgentInner {
            id: id.clone(),
            buffer: Mutex::new(Vec::with_capacity(64 * 1024)),
            channel: Mutex::new(None),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            fsm: Mutex::new(StatusFsm::new()),
            app,
        });

        self.agents
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::clone(&inner));

        // Reader thread: append to ring, forward to attached channel, update FSM.
        let inner_r = Arc::clone(&inner);
        thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let chunk = &buf[..n];
                            {
                                let mut b = inner_r.buffer.lock().unwrap();
                                b.extend_from_slice(chunk);
                                if b.len() > BUFFER_CAP {
                                    let drop_n = b.len() - BUFFER_CAP;
                                    b.drain(..drop_n);
                                }
                            }
                            let ch = inner_r.channel.lock().unwrap().clone();
                            if let Some(ch) = ch {
                                let _ = ch.send(InvokeResponseBody::Raw(chunk.to_vec()));
                            }
                            let next = inner_r.fsm.lock().unwrap().on_chunk(chunk);
                            if let Some(s) = next {
                                emit_status(&inner_r.app, &inner_r.id, s);
                            }
                        }
                        Err(_) => break,
                    }
                }
            })?;

        // Per-agent tick thread: exits when the agent's strong refs are dropped.
        let inner_tick = Arc::downgrade(&inner);
        thread::Builder::new()
            .name(format!("pty-tick-{id}"))
            .spawn(move || loop {
                thread::sleep(TICK_INTERVAL);
                let Some(inner) = inner_tick.upgrade() else {
                    return;
                };
                let next = inner.fsm.lock().unwrap().on_tick();
                if let Some(s) = next {
                    emit_status(&inner.app, &inner.id, s);
                }
            })?;

        // Initial state push so UI doesn't show stale info before first transition.
        emit_status(&inner.app, &inner.id, inner.fsm.lock().unwrap().state());

        Ok(())
    }

    pub fn attach(&self, id: &str, channel: Channel<InvokeResponseBody>) -> Result<()> {
        let agents = self.agents.lock().unwrap();
        let inner = agents
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no agent `{id}`"))?;
        drop(agents);

        let snapshot = inner.buffer.lock().unwrap().clone();
        if !snapshot.is_empty() {
            channel.send(InvokeResponseBody::Raw(snapshot))?;
        }
        *inner.channel.lock().unwrap() = Some(channel);
        Ok(())
    }

    pub fn detach(&self, id: &str) -> Result<()> {
        let agents = self.agents.lock().unwrap();
        if let Some(inner) = agents.get(id) {
            *inner.channel.lock().unwrap() = None;
        }
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let agents = self.agents.lock().unwrap();
        let inner = agents
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no agent `{id}`"))?;
        drop(agents);
        let mut w = inner.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let agents = self.agents.lock().unwrap();
        let inner = agents
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no agent `{id}`"))?;
        drop(agents);
        inner.master.lock().unwrap().resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        let removed = self.agents.lock().unwrap().remove(id);
        if let Some(inner) = removed {
            *inner.channel.lock().unwrap() = None;
            let mut child = inner.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }
}

impl Default for PtySupervisor {
    fn default() -> Self {
        Self::new()
    }
}

fn emit_status(app: &AppHandle, id: &str, status: Status) {
    let _ = app.emit(
        "agent-status",
        StatusEvent {
            id: id.to_string(),
            status,
        },
    );
}
