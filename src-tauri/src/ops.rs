//! What the desktop window, the `cosmos` CLI and the web UI all do to a
//! runner, written once. Each of those three is a thin port over this module,
//! so a spawn from the phone resumes the same session, on the same model and
//! provider, as a spawn from the app.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_proc::AgentSupervisor;
use crate::claude_session;
use crate::master::MASTER_NAME;
use crate::projects::{self, ProjectRecord, RunnerRecord};
use crate::providers;
use crate::pty_supervisor::{PtySupervisor, RunnerKind};
use crate::router::{self, AgentView, ProjectView, Suggestion};
use crate::store::Store;

const SPAWN_COLS: u16 = 120;
const SPAWN_ROWS: u16 = 32;
const PEEK_TAIL_BYTES: u64 = 512 * 1024;
const STATUS_TAIL_BYTES: u64 = 96 * 1024;

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn home_of(app: &AppHandle) -> Result<PathBuf> {
    app.path().home_dir().map_err(|e| anyhow!(e.to_string()))
}

/// Env a runner's process gets on top of the usual `COSMOS_*`: its own id (so
/// what it spawns knows who asked) and, off Anthropic, the provider's endpoint
/// and key.
pub fn launch_env(home: &Path, rec: &RunnerRecord) -> Result<Vec<(String, String)>> {
    let mut env: Vec<(String, String)> = rec.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    env.push(("COSMOS_RUNNER_ID".into(), rec.id.clone()));
    if rec.kind == "agent" {
        env.extend(providers::env_for(home, &rec.provider, &rec.model)?);
    }
    Ok(env)
}

/// Brings a runner's PTY up from its row: resumes the session when there is
/// one, on the row's model and provider. `prompt` becomes Claude Code's
/// opening message. A no-op when the PTY is already alive.
pub fn spawn_pty(app: &AppHandle, project: &ProjectRecord, rec: &RunnerRecord, prompt: &str) -> Result<()> {
    let supervisor = app.state::<PtySupervisor>();
    if supervisor.status(&rec.id).is_some() {
        return Ok(());
    }
    let home = home_of(app)?;
    let cwd = projects::runner_cwd(project, rec);
    let args = projects::spawn_args_for(&home, rec, &cwd);
    let args = projects::with_project_memory(args, &home, &project.slug, rec);
    let args = projects::with_initial_prompt(args, rec, prompt);
    supervisor.spawn_with_slug(
        app.clone(),
        rec.id.clone(),
        project.id.clone(),
        project.slug.clone(),
        RunnerKind::from_str(&rec.kind),
        cwd,
        rec.program.clone(),
        args,
        launch_env(&home, rec)?,
        SPAWN_COLS,
        SPAWN_ROWS,
    )
}

pub fn project_of(app: &AppHandle, rec: &RunnerRecord) -> Result<ProjectRecord> {
    let store = app.state::<Store>();
    let row = store
        .projects_get(&rec.project_id)?
        .ok_or_else(|| anyhow!("runner `{}` has no project", rec.name))?;
    projects::row_to_record(row)
}

/// `(live, status)` for a runner, whichever supervisor owns its process.
pub fn liveness(app: &AppHandle, rec: &RunnerRecord) -> (bool, String) {
    let status = app
        .state::<PtySupervisor>()
        .status(&rec.id)
        .or_else(|| app.state::<Arc<AgentSupervisor>>().status(&rec.id));
    match status {
        Some(s) => (
            true,
            serde_json::to_value(s)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_else(|| "running".into()),
        ),
        // A chat without a process is between messages, not gone.
        None if rec.kind == "agent" && rec.mode == "chat" => (false, "idle".into()),
        None => (false, "exited".into()),
    }
}

/// Hands `message` to an agent as if a person typed it. A stopped terminal
/// agent is woken up on its old session with the message as its prompt, which
/// is what lets the Hub route to an agent nobody has open.
pub fn send(app: &AppHandle, target: &RunnerRecord, message: &str) -> Result<Value> {
    let message = message.trim();
    if message.is_empty() {
        anyhow::bail!("a mensagem está vazia");
    }
    if target.kind != "agent" {
        anyhow::bail!("`{}` é um terminal, não um agente", target.name);
    }
    if target.mode == "chat" {
        // The stream-json protocol lives in the webview, which also starts
        // the process when there is none.
        app.emit("agent-task", json!({ "runnerId": target.id, "text": message }))?;
        return Ok(json!({ "sent": target.id, "via": "chat" }));
    }
    let pty = app.state::<PtySupervisor>();
    if pty.status(&target.id).is_none() {
        if !projects::is_claude_command(&target.args) {
            anyhow::bail!("`{}` está parado e não é Claude Code: abra no Cosmos primeiro", target.name);
        }
        let project = project_of(app, target)?;
        spawn_pty(app, &project, target, message)?;
        touch(app, target);
        let _ = app.emit(
            "runners-changed",
            json!({ "reason": "ops.send.wake", "projectId": project.id }),
        );
        return Ok(json!({ "sent": target.id, "via": "tty", "woke": true }));
    }
    pty.write(&target.id, message.replace('\n', " ").as_bytes())?;
    // The TUI reads a burst that ends in CR as a paste; the pause makes the
    // CR a keypress.
    std::thread::sleep(Duration::from_millis(60));
    pty.write(&target.id, b"\r")?;
    touch(app, target);
    Ok(json!({ "sent": target.id, "via": "tty", "woke": false }))
}

fn touch(app: &AppHandle, rec: &RunnerRecord) {
    let mut rec = rec.clone();
    rec.last_active = now_unix();
    if let Ok(row) = projects::runner_record_to_row(&rec) {
        let _ = app.state::<Store>().runners_upsert(&row);
    }
}

/// Changes what a runner runs on. Takes effect on its next start: a live CLI
/// already holds its model and endpoint.
pub fn set_model(app: &AppHandle, target: &RunnerRecord, provider: &str, model: &str) -> Result<RunnerRecord> {
    if !projects::is_claude_command(&target.args) {
        anyhow::bail!("`{}` não roda o Claude Code", target.name);
    }
    let home = home_of(app)?;
    let (provider, model) = providers::resolve(&home, provider, model)?;
    let mut rec = target.clone();
    rec.provider = provider;
    rec.model = model;
    app.state::<Store>().runners_upsert(&projects::runner_record_to_row(&rec)?)?;
    let _ = app.emit(
        "runners-changed",
        json!({ "reason": "ops.set_model", "projectId": rec.project_id }),
    );
    Ok(rec)
}

/// Records that `from` handed work to `target`, which is what the canvas
/// draws a line for. An answer going back up the chain is not a delegation,
/// and nobody delegates to the hub.
pub fn delegated(app: &AppHandle, target: RunnerRecord, from: &str) -> Result<RunnerRecord> {
    if from.is_empty() || from == target.id || from == target.parent_id {
        return Ok(target);
    }
    let store = app.state::<Store>();
    let Some(sender) = store.runners_get(from)? else { return Ok(target) };
    let to_hub = project_of(app, &target).is_ok_and(|p| is_master_project(&p))
        && target.name.eq_ignore_ascii_case(MASTER_NAME);
    if sender.parent_id == target.id || to_hub {
        return Ok(target);
    }
    let mut rec = target;
    rec.parent_id = from.to_string();
    store.runners_upsert(&projects::runner_record_to_row(&rec)?)?;
    let _ = app.emit(
        "runners-changed",
        json!({ "reason": "ops.delegated", "projectId": rec.project_id }),
    );
    Ok(rec)
}

/* ------------------------------ transcript ------------------------------ */

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Turn {
    pub role: String,
    pub text: String,
}

fn tail(path: &Path, bytes: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(bytes);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    // A tail that starts mid-file starts mid-line.
    Some(if start > 0 {
        text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default()
    } else {
        text
    })
}

fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{cut}…")
}

/// What one transcript line says, as plain text. Tool calls collapse to
/// `[Edit src/App.tsx]`; tool results and machine reminders are dropped.
fn turn_of(line: &str) -> Option<Turn> {
    let v: Value = serde_json::from_str(line).ok()?;
    let role = v.get("type")?.as_str()?;
    if role != "user" && role != "assistant" {
        return None;
    }
    if v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false)
        || v.get("isMeta").and_then(Value::as_bool).unwrap_or(false)
    {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let mut parts: Vec<String> = Vec::new();
    match content {
        Value::String(s) => parts.push(s.clone()),
        Value::Array(blocks) => {
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            parts.push(t.to_string());
                        }
                    }
                    Some("tool_use") => {
                        let name = b.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let input = b.get("input");
                        let arg = ["file_path", "command", "description", "pattern", "url", "prompt"]
                            .iter()
                            .find_map(|k| input.and_then(|i| i.get(*k)).and_then(Value::as_str))
                            .unwrap_or("");
                        parts.push(format!("[{name} {}]", clip(arg, 80)).replace(" ]", "]"));
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    let text = parts.join("\n");
    let text = text.trim();
    if text.is_empty() || text.starts_with("<system-reminder>") || text.starts_with("<local-command") {
        return None;
    }
    Some(Turn { role: role.to_string(), text: text.to_string() })
}

fn turns_in(text: &str, last: usize) -> Vec<Turn> {
    let mut out: Vec<Turn> = text.lines().rev().filter_map(turn_of).take(last).collect();
    out.reverse();
    out
}

fn transcript(app: &AppHandle, project: &ProjectRecord, rec: &RunnerRecord) -> Option<PathBuf> {
    if rec.session_id.is_empty() {
        return None;
    }
    let home = home_of(app).ok()?;
    let path = claude_session::transcript_path(&home, &projects::runner_cwd(project, rec), &rec.session_id);
    path.exists().then_some(path)
}

/// The last `turns` things said in an agent's conversation, so whoever
/// delegated can read the answer without opening the terminal.
pub fn peek(app: &AppHandle, target: &RunnerRecord, turns: usize) -> Result<Value> {
    let project = project_of(app, target)?;
    let (live, status) = liveness(app, target);
    let found = transcript(app, &project, target)
        .and_then(|p| tail(&p, PEEK_TAIL_BYTES))
        .map(|t| turns_in(&t, turns.clamp(1, 40)))
        .unwrap_or_default();
    Ok(json!({
        "name": target.name,
        "id": target.id,
        "project": project.slug,
        "status": status,
        "live": live,
        "turns": found.iter().map(|t| json!({ "role": t.role, "text": clip(&t.text, 4000) })).collect::<Vec<_>>(),
    }))
}

/// Session title and the last thing the agent said or did.
fn glance(app: &AppHandle, project: &ProjectRecord, rec: &RunnerRecord) -> (String, String) {
    let Some(path) = transcript(app, project, rec) else {
        return (String::new(), String::new());
    };
    let title = claude_session::read_title(&path)
        .ok()
        .and_then(|t| t.custom.or(t.ai))
        .unwrap_or_default();
    let last = tail(&path, STATUS_TAIL_BYTES)
        .map(|t| turns_in(&t, 8))
        .unwrap_or_default()
        .into_iter()
        .rev()
        .find(|t| t.role == "assistant")
        .map(|t| clip(t.text.lines().last().unwrap_or(""), 140))
        .unwrap_or_default();
    (title, last)
}

/// Per agent: what it has spent, how full its context is, and the title and
/// last line of its session. Keyed by runner id; agents with no transcript
/// yet are left out.
pub fn vitals(app: &AppHandle) -> Result<std::collections::HashMap<String, Value>> {
    let store = app.state::<Store>();
    let all = projects::list(&store)?;
    let mut out = std::collections::HashMap::new();
    for rec in projects::runners_list(&store)?.iter().filter(|r| r.kind == "agent") {
        let Some(project) = all.iter().find(|p| p.id == rec.project_id) else { continue };
        let Some(path) = transcript(app, project, rec) else { continue };
        let (title, last) = glance(app, project, rec);
        let mut v = serde_json::to_value(crate::usage::read(&path))?;
        v["title"] = json!(title);
        v["last"] = json!(last);
        out.insert(rec.id.clone(), v);
    }
    Ok(out)
}

/* ------------------------------- overview ------------------------------- */

fn is_master_project(p: &ProjectRecord) -> bool {
    p.name.eq_ignore_ascii_case(MASTER_NAME)
}

/// Every project with its runners and what each is doing.
pub fn status(app: &AppHandle) -> Result<Value> {
    let store = app.state::<Store>();
    let home = home_of(app)?;
    let runners = projects::runners_list(&store)?;
    let name_of = |id: &str| runners.iter().find(|r| r.id == id).map(|r| r.name.clone());
    let out: Vec<Value> = projects::list(&store)?
        .iter()
        .map(|p| {
            let rs: Vec<Value> = runners
                .iter()
                .filter(|r| r.project_id == p.id)
                .map(|r| {
                    let (live, status) = liveness(app, r);
                    let (title, last) = if r.kind == "agent" {
                        glance(app, p, r)
                    } else {
                        Default::default()
                    };
                    json!({
                        "name": r.name,
                        "id": r.id,
                        "kind": r.kind,
                        "mode": r.mode,
                        "status": status,
                        "live": live,
                        "branch": r.branch,
                        "task": r.task,
                        "title": title,
                        "last": last,
                        "model": providers::label(&home, &r.provider, &r.model),
                        "provider": r.provider,
                        "delegatedBy": name_of(&r.parent_id),
                        "lastActive": r.last_active,
                    })
                })
                .collect();
            json!({ "project": p.name, "slug": p.slug, "folders": p.folders, "runners": rs })
        })
        .collect();
    Ok(json!(out))
}

/// Ranks where `task` should go. See `router.rs`.
pub fn suggest(app: &AppHandle, task: &str) -> Result<Suggestion> {
    let store = app.state::<Store>();
    let home = home_of(app)?;
    let all = projects::list(&store)?;
    let views: Vec<ProjectView> = all
        .iter()
        .map(|p| ProjectView {
            slug: p.slug.clone(),
            name: p.name.clone(),
            folders: p.folders.clone(),
            is_master: is_master_project(p),
        })
        .collect();
    let known = providers::list(&home);
    let agents: Vec<AgentView> = projects::runners_list(&store)?
        .iter()
        .filter(|r| r.kind == "agent")
        .filter_map(|r| {
            let p = all.iter().find(|p| p.id == r.project_id)?;
            let (live, status) = liveness(app, r);
            let title = transcript(app, p, r)
                .and_then(|path| claude_session::read_title(&path).ok())
                .and_then(|t| t.custom.or(t.ai))
                .unwrap_or_default();
            Some(AgentView {
                id: r.id.clone(),
                name: r.name.clone(),
                project_slug: p.slug.clone(),
                task: r.task.clone(),
                title,
                live,
                status,
                last_active: r.last_active,
                is_master: is_master_project(p) && r.name.eq_ignore_ascii_case(MASTER_NAME),
                tier: known
                    .iter()
                    .flat_map(|p| p.models.iter())
                    .find(|m| !r.model.is_empty() && m.id == r.model)
                    .map(|m| m.tier),
                model_label: providers::label(&home, &r.provider, &r.model),
            })
        })
        .collect();
    Ok(router::suggest(task, &views, &agents, &known, now_unix()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transcript_reads_as_a_conversation() {
        let text = concat!(
            "{\"type\":\"user\",\"message\":{\"content\":\"arruma o ranking\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Vou olhar.\"},",
            "{\"type\":\"tool_use\",\"name\":\"Edit\",\"input\":{\"file_path\":\"src/rank.ts\"}}]}}\n",
            "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"ok\"}]}}\n",
            "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"content\":\"<system-reminder>x</system-reminder>\"}}\n",
            "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"subagent\"}]}}\n",
            "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Pronto.\"}]}}\n",
        );
        let turns = turns_in(text, 10);
        assert_eq!(
            turns,
            vec![
                Turn { role: "user".into(), text: "arruma o ranking".into() },
                Turn { role: "assistant".into(), text: "Vou olhar.\n[Edit src/rank.ts]".into() },
                Turn { role: "assistant".into(), text: "Pronto.".into() },
            ]
        );
        assert_eq!(turns_in(text, 1).len(), 1);
    }

    #[test]
    fn clipping_respects_char_boundaries() {
        assert_eq!(clip("ação", 2), "aç…");
        assert_eq!(clip("  ok ", 10), "ok");
    }
}
