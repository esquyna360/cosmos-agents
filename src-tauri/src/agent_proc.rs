//! Headless Claude Code processes behind the native chat.
//!
//! A chat runner is `claude -p` speaking stream-json over plain pipes: one
//! JSON object per line in both directions. This module is deliberately a
//! pipe, not a protocol implementation — every stdout line is numbered,
//! retained, and forwarded to the webview untouched, and whatever the webview
//! sends is written to stdin as-is. The protocol lives in TypeScript
//! (`src/lib/claudeProtocol.ts`), where it can be iterated on and mocked.
//!
//! The one thing read here is the line's `type`, to keep the same
//! `runner-status` events flowing that PTY runners emit, so the sidebar,
//! notifications and the remote plane don't care which kind of runner it is.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{anyhow, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::status_fsm::Status;

/// Retained stdout, so a reloaded webview can rebuild the conversation
/// without re-reading the transcript from disk.
const LOG_CAP_BYTES: usize = 24 * 1024 * 1024;
const STDERR_TAIL_LINES: usize = 40;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentLine {
    pub runner_id: String,
    pub seq: u64,
    pub line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentExit {
    runner_id: String,
    code: Option<i32>,
    stderr: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunnerStatusEvent {
    project_id: String,
    runner_id: String,
    status: Status,
}

struct Log {
    lines: VecDeque<(u64, String)>,
    bytes: usize,
}

struct ProcInner {
    id: String,
    project_id: String,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    log: Mutex<Log>,
    seq: AtomicU64,
    status: Mutex<Status>,
    stderr_tail: Mutex<VecDeque<String>>,
    app: AppHandle,
}

pub struct AgentSupervisor {
    procs: Mutex<HashMap<String, Arc<ProcInner>>>,
}

pub struct SpawnSpec {
    pub id: String,
    pub project_id: String,
    pub project_slug: String,
    pub cwd: String,
    pub program: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

impl AgentSupervisor {
    pub fn new() -> Self {
        Self {
            procs: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.procs.lock().unwrap().contains_key(id)
    }

    pub fn list(&self) -> Vec<String> {
        self.procs.lock().unwrap().keys().cloned().collect()
    }

    pub fn status(&self, id: &str) -> Option<Status> {
        let procs = self.procs.lock().unwrap();
        procs.get(id).map(|p| *p.status.lock().unwrap())
    }

    pub fn spawn(self: &Arc<Self>, app: AppHandle, spec: SpawnSpec) -> Result<()> {
        if self.is_live(&spec.id) {
            return Err(anyhow!("agent `{}` already running", spec.id));
        }

        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::no_console(&mut cmd);
        // Cosmos itself may have been launched from inside a Claude Code
        // session; its markers would make the child think it is nested.
        for (k, _) in std::env::vars_os() {
            let key = k.to_string_lossy();
            if key == "CLAUDECODE" || key.starts_with("CLAUDE_CODE_") {
                cmd.env_remove(&k);
            }
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        if !spec.project_id.is_empty() {
            cmd.env("COSMOS_PROJECT_ID", &spec.project_id);
        }
        if !spec.project_slug.is_empty() {
            cmd.env("COSMOS_PROJECT_SLUG", &spec.project_slug);
        }
        if let Some(home) = crate::pty_supervisor::home_dir() {
            cmd.env("COSMOS_SOCKET", crate::ipc::default_socket_path(&home));
        }
        if let Some(path) = crate::pty_supervisor::path_with_cli_dir() {
            cmd.env("PATH", path);
        }

        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;

        let inner = Arc::new(ProcInner {
            id: spec.id.clone(),
            project_id: spec.project_id,
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            log: Mutex::new(Log {
                lines: VecDeque::new(),
                bytes: 0,
            }),
            seq: AtomicU64::new(0),
            status: Mutex::new(Status::Idle),
            stderr_tail: Mutex::new(VecDeque::new()),
            app,
        });
        self.procs
            .lock()
            .unwrap()
            .insert(spec.id.clone(), Arc::clone(&inner));

        let inner_err = Arc::clone(&inner);
        thread::Builder::new()
            .name(format!("agent-stderr-{}", spec.id))
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
                    let mut tail = inner_err.stderr_tail.lock().unwrap();
                    tail.push_back(line);
                    while tail.len() > STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                }
            })?;

        let inner_out = Arc::clone(&inner);
        let sup = Arc::clone(self);
        thread::Builder::new()
            .name(format!("agent-stdout-{}", spec.id))
            .spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
                    // The login shell that execs claude may print before the
                    // exec; only protocol lines go through.
                    if !line.starts_with('{') {
                        continue;
                    }
                    inner_out.accept(line);
                }
                let code = inner_out
                    .child
                    .lock()
                    .unwrap()
                    .wait()
                    .ok()
                    .and_then(|s| s.code());
                // A kill() already took the entry out; only a process that
                // ended on its own still needs removing.
                sup.procs.lock().unwrap().remove(&inner_out.id);
                let stderr = inner_out
                    .stderr_tail
                    .lock()
                    .unwrap()
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
                let _ = inner_out.app.emit(
                    "agent-exit",
                    AgentExit {
                        runner_id: inner_out.id.clone(),
                        code,
                        stderr,
                    },
                );
                inner_out.set_status(Status::Exited);
            })?;

        inner.set_status(Status::Idle);
        Ok(())
    }

    /// Everything retained for this runner with `seq > after`.
    pub fn snapshot(&self, id: &str, after: u64) -> Vec<AgentLine> {
        let procs = self.procs.lock().unwrap();
        let Some(inner) = procs.get(id).cloned() else {
            return Vec::new();
        };
        drop(procs);
        let log = inner.log.lock().unwrap();
        log.lines
            .iter()
            .filter(|(seq, _)| *seq > after)
            .map(|(seq, line)| AgentLine {
                runner_id: id.to_string(),
                seq: *seq,
                line: line.clone(),
            })
            .collect()
    }

    pub fn send(&self, id: &str, line: &str) -> Result<()> {
        let procs = self.procs.lock().unwrap();
        let inner = procs
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no agent `{id}`"))?;
        drop(procs);
        let mut guard = inner.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or_else(|| anyhow!("stdin closed"))?;
        stdin.write_all(line.as_bytes())?;
        if !line.ends_with('\n') {
            stdin.write_all(b"\n")?;
        }
        stdin.flush()?;
        drop(guard);
        inner.note_outgoing(line);
        Ok(())
    }

    pub fn kill(&self, id: &str) {
        let removed = self.procs.lock().unwrap().remove(id);
        if let Some(inner) = removed {
            inner.stdin.lock().unwrap().take();
            let _ = inner.child.lock().unwrap().kill();
        }
    }

    pub fn kill_project(&self, project_id: &str) {
        let ids: Vec<String> = self
            .procs
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, p)| p.project_id == project_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.kill(&id);
        }
    }
}

impl ProcInner {
    fn accept(&self, line: String) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(next) = status_after(&line) {
            self.set_status(next);
        }
        // Token deltas are superseded by the full assistant message that
        // follows them, so they are forwarded live but never retained.
        if !line.starts_with("{\"type\":\"stream_event\"") {
            let mut log = self.log.lock().unwrap();
            log.bytes += line.len();
            log.lines.push_back((seq, line.clone()));
            while log.bytes > LOG_CAP_BYTES {
                match log.lines.pop_front() {
                    Some((_, old)) => log.bytes -= old.len(),
                    None => break,
                }
            }
        }
        let _ = self.app.emit(
            "agent-line",
            AgentLine {
                runner_id: self.id.clone(),
                seq,
                line,
            },
        );
    }

    /// A user turn starts work; an answered permission resumes it.
    fn note_outgoing(&self, line: &str) {
        if line.contains("\"type\":\"user\"") || line.contains("\"type\":\"control_response\"") {
            self.set_status(Status::Streaming);
        }
    }

    fn set_status(&self, next: Status) {
        {
            let mut cur = self.status.lock().unwrap();
            if *cur == next {
                return;
            }
            *cur = next;
        }
        if self.project_id.is_empty() {
            return;
        }
        let _ = self.app.emit(
            "runner-status",
            RunnerStatusEvent {
                project_id: self.project_id.clone(),
                runner_id: self.id.clone(),
                status: next,
            },
        );
    }
}

#[derive(serde::Deserialize)]
struct LineHead {
    #[serde(rename = "type")]
    kind: String,
    request: Option<RequestHead>,
}

#[derive(serde::Deserialize)]
struct RequestHead {
    subtype: String,
}

/// Status implied by one protocol line, if any. Token deltas are matched on
/// their raw prefix; everything else is parsed, because the CLI does not
/// always write `type` first (`result` lines don't).
fn status_after(line: &str) -> Option<Status> {
    if line.starts_with("{\"type\":\"stream_event\"") {
        return Some(Status::Streaming);
    }
    let head: LineHead = serde_json::from_str(line).ok()?;
    match head.kind.as_str() {
        "assistant" => Some(Status::Streaming),
        "user" => Some(Status::ToolRunning),
        "result" => Some(Status::Idle),
        "control_request" if head.request.is_some_and(|r| r.subtype == "can_use_tool") => {
            Some(Status::AwaitingInput)
        }
        _ => None,
    }
}
