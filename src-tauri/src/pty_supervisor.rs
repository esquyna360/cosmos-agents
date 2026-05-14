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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunnerKind {
    Agent,
    Shell,
}

impl RunnerKind {
    pub fn from_str(s: &str) -> Self {
        match s {
            "shell" => RunnerKind::Shell,
            _ => RunnerKind::Agent,
        }
    }
}

/// Legacy event — keyed by runner_id only (because before Step 1 there was no
/// project_id). Frontend keeps consuming this through Steps 1-3 so the UI
/// doesn't break while the new event rolls out in parallel.
#[derive(Serialize, Clone)]
struct StatusEvent {
    id: String,
    status: Status,
}

/// New event — carries project_id so the frontend can route without a
/// runner-id → project-id lookup. Emitted only when project_id is non-empty.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunnerStatusEvent {
    project_id: String,
    runner_id: String,
    status: Status,
}

struct RunnerInner {
    id: String,
    project_id: String,
    kind: RunnerKind,
    buffer: Mutex<Vec<u8>>,
    channel: Mutex<Option<Channel<InvokeResponseBody>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    fsm: Mutex<Option<StatusFsm>>,
    app: AppHandle,
}

pub struct PtySupervisor {
    runners: Mutex<HashMap<String, Arc<RunnerInner>>>,
}

impl PtySupervisor {
    pub fn new() -> Self {
        Self {
            runners: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self) -> Vec<String> {
        self.runners.lock().unwrap().keys().cloned().collect()
    }

    pub fn status(&self, id: &str) -> Option<Status> {
        let runners = self.runners.lock().unwrap();
        let inner = runners.get(id).cloned()?;
        drop(runners);
        let fsm = inner.fsm.lock().unwrap();
        match fsm.as_ref() {
            Some(fsm) => Some(fsm.state()),
            // Shells (no FSM) — alive in the map means running.
            None => Some(Status::Running),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        project_id: String,
        kind: RunnerKind,
        cwd: String,
        program: String,
        args: Vec<String>,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        if self.runners.lock().unwrap().contains_key(&id) {
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

        let fsm = match kind {
            RunnerKind::Agent => Some(StatusFsm::new()),
            RunnerKind::Shell => None,
        };

        let inner = Arc::new(RunnerInner {
            id: id.clone(),
            project_id,
            kind,
            buffer: Mutex::new(Vec::with_capacity(64 * 1024)),
            channel: Mutex::new(None),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            fsm: Mutex::new(fsm),
            app,
        });

        self.runners
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::clone(&inner));

        // Reader thread: append to ring, forward to attached channel, update
        // FSM if present. Emits `Exited` (for both kinds) when the read loop
        // ends — the frontend uses this to flip status dots out of "alive".
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
                            let next = {
                                let mut fsm = inner_r.fsm.lock().unwrap();
                                fsm.as_mut().and_then(|f| f.on_chunk(chunk))
                            };
                            if let Some(s) = next {
                                emit_status(&inner_r, s);
                            }
                        }
                        Err(_) => break,
                    }
                }
                emit_status(&inner_r, Status::Exited);
            })?;

        // Per-runner tick thread: exits when strong refs are dropped. No-op for
        // shells (FSM = None).
        let inner_tick = Arc::downgrade(&inner);
        thread::Builder::new()
            .name(format!("pty-tick-{id}"))
            .spawn(move || loop {
                thread::sleep(TICK_INTERVAL);
                let Some(inner) = inner_tick.upgrade() else {
                    return;
                };
                let next = {
                    let mut fsm = inner.fsm.lock().unwrap();
                    fsm.as_mut().and_then(|f| f.on_tick())
                };
                if let Some(s) = next {
                    emit_status(&inner, s);
                }
            })?;

        // Initial state push so UI doesn't show stale info before first
        // transition. For shells (no FSM) we publish Running directly.
        let initial = match kind {
            RunnerKind::Agent => inner
                .fsm
                .lock()
                .unwrap()
                .as_ref()
                .map(|f| f.state())
                .unwrap_or(Status::Idle),
            RunnerKind::Shell => Status::Running,
        };
        emit_status(&inner, initial);

        Ok(())
    }

    pub fn attach(&self, id: &str, channel: Channel<InvokeResponseBody>) -> Result<()> {
        let runners = self.runners.lock().unwrap();
        let inner = runners
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no runner `{id}`"))?;
        drop(runners);

        let snapshot = inner.buffer.lock().unwrap().clone();
        if !snapshot.is_empty() {
            channel.send(InvokeResponseBody::Raw(snapshot))?;
        }
        *inner.channel.lock().unwrap() = Some(channel);
        Ok(())
    }

    pub fn detach(&self, id: &str) -> Result<()> {
        let runners = self.runners.lock().unwrap();
        if let Some(inner) = runners.get(id) {
            *inner.channel.lock().unwrap() = None;
        }
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let runners = self.runners.lock().unwrap();
        let inner = runners
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no runner `{id}`"))?;
        drop(runners);
        let mut w = inner.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let runners = self.runners.lock().unwrap();
        let inner = runners
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no runner `{id}`"))?;
        drop(runners);
        inner.master.lock().unwrap().resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        let removed = self.runners.lock().unwrap().remove(id);
        if let Some(inner) = removed {
            *inner.channel.lock().unwrap() = None;
            let mut child = inner.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    /// Kill every runner attached to a given project. Used when a project is
    /// closed — avoids an N-roundtrip from the frontend to kill each runner.
    pub fn kill_project(&self, project_id: &str) -> Result<()> {
        let to_kill: Vec<Arc<RunnerInner>> = {
            let mut map = self.runners.lock().unwrap();
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, v)| v.project_id == project_id)
                .map(|(k, _)| k.clone())
                .collect();
            ids.into_iter().filter_map(|id| map.remove(&id)).collect()
        };
        for inner in to_kill {
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

fn emit_status(inner: &RunnerInner, status: Status) {
    let _ = inner.app.emit(
        "agent-status",
        StatusEvent {
            id: inner.id.clone(),
            status,
        },
    );
    if !inner.project_id.is_empty() {
        let _ = inner.app.emit(
            "runner-status",
            RunnerStatusEvent {
                project_id: inner.project_id.clone(),
                runner_id: inner.id.clone(),
                status,
            },
        );
    }
    // Silence unused-field warnings on `kind` even though we don't branch on
    // it in this fn — the field is read in spawn() and at runtime.
    let _ = inner.kind;
}
