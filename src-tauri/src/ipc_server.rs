//! Cross-platform local-socket RPC server that lets the `cosmos` CLI (running
//! inside a spawned agent's PTY) register new projects/runners in the live
//! app. Uses `interprocess::local_socket` so the same code path covers Unix
//! sockets on macOS/Linux and named pipes on Windows.
//!
//! Lifecycle:
//! - `start` is called once at app setup. On Unix it detects a stale socket
//!   from a previous run (no live peer answers a probe) and unlinks the file
//!   before binding. On Windows named pipes don't persist after the owning
//!   process exits, so the stale-cleanup step is a no-op.
//! - Each connection: read one line of JSON → `Request`, dispatch, write one
//!   line of JSON → `Response`, close. Stateless on the wire.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;

use anyhow::{anyhow, Context, Result};
use interprocess::local_socket::{prelude::*, ListenerOptions, Stream};
#[cfg(unix)]
use interprocess::local_socket::GenericFilePath;
#[cfg(windows)]
use interprocess::local_socket::GenericNamespaced;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_proc::AgentSupervisor;
use crate::brain;
use crate::ipc::{Request, Response};
use crate::ops::{self, home_of, liveness, now_unix};
use crate::projects::{self, ProjectRecord, RunnerRecord};
use crate::pty_supervisor::PtySupervisor;
use crate::store::Store;

/// Build a platform-appropriate local-socket name from `socket_path`. On Unix
/// we use the path verbatim as a filesystem socket; on Windows we take the
/// file name and put it in the namespaced pipe namespace (`\\.\pipe\<name>`).
fn ipc_name(socket_path: &Path) -> Result<interprocess::local_socket::Name<'_>> {
    #[cfg(windows)]
    {
        let stem = socket_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("invalid socket path {}", socket_path.display()))?;
        stem.to_ns_name::<GenericNamespaced>()
            .context("building named-pipe name")
    }
    #[cfg(unix)]
    {
        socket_path
            .to_fs_name::<GenericFilePath>()
            .context("building unix-socket name")
    }
}

/// Binds to `socket_path` and spawns an accept thread. Fails fast if another
/// live Cosmos is already serving the socket (so we don't end up with two
/// servers racing on the same SQLite).
pub fn start(app: AppHandle, socket_path: PathBuf) -> Result<()> {
    #[cfg(unix)]
    {
        if let Some(parent) = socket_path.parent() {
            std::fs::create_dir_all(parent).context("creating cosmos.sock parent dir")?;
        }
        if socket_path.exists() {
            // If a peer answers the probe, another instance owns the socket and
            // we must not bind. If the connect fails (ECONNREFUSED on a stale
            // node), unlink and continue.
            let probe_name = ipc_name(&socket_path)?;
            match Stream::connect(probe_name) {
                Ok(_) => {
                    return Err(anyhow!(
                        "another Cosmos app is already listening on {}",
                        socket_path.display()
                    ));
                }
                Err(_) => {
                    let _ = std::fs::remove_file(&socket_path);
                }
            }
        }
    }

    let name = ipc_name(&socket_path)?;
    let listener = ListenerOptions::new()
        .name(name)
        .create_sync()
        .with_context(|| format!("binding cosmos IPC socket at {}", socket_path.display()))?;

    // Owner-only — defense in depth. The default umask is usually fine but
    // we set it explicitly so multi-user machines don't leak the channel.
    // On Windows, named pipes default to the creator's user via DACL, which
    // is already the desired behavior.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));
    }

    thread::Builder::new()
        .name("cosmos-ipc-accept".into())
        .spawn(move || {
            for conn in listener.incoming() {
                match conn {
                    Ok(stream) => {
                        let app = app.clone();
                        thread::Builder::new()
                            .name("cosmos-ipc-conn".into())
                            .spawn(move || {
                                if let Err(e) = handle_connection(app, stream) {
                                    eprintln!("[cosmos-ipc] conn error: {e}");
                                }
                            })
                            .ok();
                    }
                    Err(e) => eprintln!("[cosmos-ipc] accept failed: {e}"),
                }
            }
        })
        .context("spawning IPC accept thread")?;
    Ok(())
}

fn handle_connection(app: AppHandle, stream: Stream) -> Result<()> {
    let (recv, mut send) = stream.split();
    let mut reader = BufReader::new(recv);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let resp = match serde_json::from_str::<Request>(trimmed) {
        Ok(req) => dispatch(&app, req),
        Err(e) => Response::err(format!("invalid request: {e}")),
    };
    let body = serde_json::to_string(&resp)?;
    send.write_all(body.as_bytes())?;
    send.write_all(b"\n")?;
    send.flush()?;
    Ok(())
}

fn dispatch(app: &AppHandle, req: Request) -> Response {
    let result = match req {
        Request::ProjectAdd {
            name,
            folders,
            memory,
            with_agent,
            task,
            model,
            provider,
            parent,
        } => handle_project_add(app, name, folders, memory, with_agent, task, model, provider, parent),
        Request::ProjectList => handle_project_list(app),
        Request::RunnerAdd {
            project,
            name,
            kind,
            task,
            worktree,
            tty,
            model,
            provider,
            parent,
        } => resolve_project(app, &project).and_then(|p| {
            let opts = AddOptions {
                kind: kind.as_deref().unwrap_or("agent"),
                task: task.as_deref().unwrap_or(""),
                worktree,
                tty,
                model: model.as_deref().unwrap_or(""),
                provider: provider.as_deref().unwrap_or(""),
                parent: parent.as_deref().unwrap_or(""),
            };
            Ok(serde_json::to_value(spawn_runner(app, &p, name, &opts)?)?)
        }),
        Request::RunnerList { project } => handle_runner_list(app, project.as_deref()),
        Request::ProjectRemove { project } => handle_project_remove(app, &project),
        Request::ProjectPrune { dry_run } => handle_project_prune(app, dry_run),
        Request::RunnerRemove { project, name, id } => {
            resolve_runner(app, project.as_deref(), name.as_deref(), id.as_deref())
                .and_then(|r| handle_runner_remove(app, r))
        }
        Request::RunnerSend {
            project,
            name,
            id,
            message,
            from,
        } => resolve_runner(app, project.as_deref(), name.as_deref(), id.as_deref())
            .and_then(|r| ops::delegated(app, r, from.as_deref().unwrap_or("")))
            .and_then(|r| ops::send(app, &r, &message)),
        Request::RunnerStop { project, name, id } => {
            resolve_runner(app, project.as_deref(), name.as_deref(), id.as_deref())
                .and_then(|r| handle_runner_stop(app, r))
        }
        Request::RunnerRename {
            project,
            name,
            id,
            to,
        } => resolve_runner(app, project.as_deref(), name.as_deref(), id.as_deref())
            .and_then(|r| handle_runner_rename(app, r, &to)),
        Request::RunnerSet {
            project,
            name,
            id,
            model,
            provider,
        } => resolve_runner(app, project.as_deref(), name.as_deref(), id.as_deref()).and_then(|r| {
            let rec = ops::set_model(
                app,
                &r,
                provider.as_deref().unwrap_or(""),
                model.as_deref().unwrap_or(""),
            )?;
            Ok(json!({
                "runner": rec,
                "note": "vale no próximo start: `cosmos runner stop` e depois `runner send`",
            }))
        }),
        Request::RunnerPeek {
            project,
            name,
            id,
            turns,
        } => resolve_runner(app, project.as_deref(), name.as_deref(), id.as_deref())
            .and_then(|r| ops::peek(app, &r, turns.unwrap_or(6))),
        Request::Status => ops::status(app),
        Request::Route { task } => ops::suggest(app, &task).and_then(|s| Ok(serde_json::to_value(s)?)),
        Request::Models => home_of(app).and_then(|h| Ok(serde_json::to_value(crate::providers::list(&h))?)),
        Request::BrainSearch { query, limit } => {
            home_of(app).and_then(|h| Ok(serde_json::to_value(brain::search(&h, &query, limit.unwrap_or(12)))?))
        }
        Request::BrainRead { note } => home_of(app).and_then(|h| Ok(serde_json::to_value(brain::open(&h, &note)?)?)),
        Request::BrainList => home_of(app).and_then(|h| Ok(serde_json::to_value(brain::index(&h))?)),
        Request::BrainNew { title, body, tags, description } => home_of(app)
            .and_then(|h| brain::create(&h, &title, &body, &tags, &description))
            .and_then(|note| brain_changed(app, note)),
        Request::BrainAppend { note, text } => home_of(app)
            .and_then(|h| brain::append(&h, &note, &text))
            .and_then(|note| brain_changed(app, note)),
    };
    match result {
        Ok(v) => Response::ok(v),
        Err(e) => Response::err(e.to_string()),
    }
}

fn brain_changed(app: &AppHandle, note: brain::Note) -> Result<serde_json::Value> {
    let _ = app.emit("brain-changed", &note.id);
    Ok(serde_json::to_value(note)?)
}

fn handle_project_add(
    app: &AppHandle,
    name: String,
    folders: Vec<String>,
    memory: String,
    with_agent: Option<String>,
    task: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    parent: Option<String>,
) -> Result<serde_json::Value> {
    let home = home_of(app)?;
    let store = app.state::<Store>();
    let project = projects::create_project(
        &home,
        &store,
        name,
        folders,
        memory,
        crate::uuid_v4_for_ipc(),
        now_unix(),
    )?;
    let _ = app.emit("projects-changed", json!({ "reason": "ipc.project.add" }));

    let runner = if let Some(agent_name) = with_agent {
        let opts = AddOptions {
            kind: "agent",
            task: task.as_deref().unwrap_or(""),
            worktree: false,
            tty: false,
            model: model.as_deref().unwrap_or(""),
            provider: provider.as_deref().unwrap_or(""),
            parent: parent.as_deref().unwrap_or(""),
        };
        Some(spawn_runner(app, &project, agent_name, &opts)?)
    } else {
        None
    };
    Ok(json!({
        "project": project,
        "runner": runner,
    }))
}

fn handle_project_list(app: &AppHandle) -> Result<serde_json::Value> {
    let store = app.state::<Store>();
    let list = projects::list(&store)?;
    Ok(serde_json::to_value(list)?)
}

fn handle_runner_list(app: &AppHandle, project: Option<&str>) -> Result<serde_json::Value> {
    let store = app.state::<Store>();
    let all = projects::runners_list(&store)?;
    let filtered: Vec<_> = match project {
        None => all,
        Some(handle) => {
            let proj = resolve_project(app, handle)?;
            all.into_iter().filter(|r| r.project_id == proj.id).collect()
        }
    };
    let out: Vec<serde_json::Value> = filtered
        .iter()
        .map(|r| {
            let (live, status) = liveness(app, r);
            let mut v = serde_json::to_value(r).unwrap_or_default();
            v["live"] = json!(live);
            v["status"] = json!(status);
            v
        })
        .collect();
    Ok(json!(out))
}

fn handle_project_remove(app: &AppHandle, handle: &str) -> Result<serde_json::Value> {
    let home = home_of(app)?;
    let project = resolve_project(app, handle)?;
    let store = app.state::<Store>();
    let supervisor = app.state::<PtySupervisor>();
    // Kill first: a PTY outliving its rows would keep writing to a runner
    // nothing can address any more.
    supervisor.kill_project(&project.id)?;
    app.state::<Arc<AgentSupervisor>>().kill_project(&project.id);
    let removed = projects::delete_project(&home, &store, &project.id)?;
    let _ = app.emit("projects-changed", json!({ "reason": "ipc.project.rm" }));
    Ok(json!({ "removed": removed }))
}

fn handle_project_prune(app: &AppHandle, dry_run: bool) -> Result<serde_json::Value> {
    let home = home_of(app)?;
    let store = app.state::<Store>();
    if dry_run {
        let found = projects::orphan_project_dirs(&home, &store)?;
        return Ok(json!({
            "dryRun": true,
            "orphans": found.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
        }));
    }
    let moved = projects::prune_orphan_dirs(&home, &store)?;
    Ok(json!({
        "dryRun": false,
        "moved": moved
            .iter()
            .map(|(slug, dest)| json!({ "slug": slug, "to": dest.display().to_string() }))
            .collect::<Vec<_>>(),
    }))
}

/// One way to address a runner for every command: by `id`, or by `name`
/// inside `project`. Ambiguous names are refused rather than guessed.
fn resolve_runner(
    app: &AppHandle,
    project: Option<&str>,
    name: Option<&str>,
    id: Option<&str>,
) -> Result<RunnerRecord> {
    let store = app.state::<Store>();
    let all = projects::runners_list(&store)?;
    match (id, name) {
        (Some(id), _) => all
            .into_iter()
            .find(|r| r.id == id)
            .ok_or_else(|| anyhow!("no runner with id `{id}`")),
        (None, Some(name)) => {
            let handle = project.ok_or_else(|| anyhow!("--name needs --project"))?;
            let proj = resolve_project(app, handle)?;
            let mut hits: Vec<_> = all
                .into_iter()
                .filter(|r| r.project_id == proj.id && r.name.eq_ignore_ascii_case(name))
                .collect();
            match hits.len() {
                0 => anyhow::bail!("no runner named `{name}` in `{}`", proj.slug),
                1 => Ok(hits.remove(0)),
                n => anyhow::bail!(
                    "{n} runners named `{name}` in `{}` — address one by --id",
                    proj.slug
                ),
            }
        }
        (None, None) => anyhow::bail!("pass --id or --name"),
    }
}

fn kill_processes(app: &AppHandle, id: &str) {
    app.state::<Arc<AgentSupervisor>>().kill(id);
    let _ = app.state::<PtySupervisor>().kill(id);
}

fn emit_runners_changed(app: &AppHandle, reason: &str, project_id: &str) {
    let _ = app.emit(
        "runners-changed",
        json!({ "reason": reason, "projectId": project_id }),
    );
}

fn handle_runner_remove(app: &AppHandle, target: RunnerRecord) -> Result<serde_json::Value> {
    let store = app.state::<Store>();
    kill_processes(app, &target.id);
    crate::remove_runner_worktree(&store, &home_of(app)?, &target);
    store.runners_delete(&target.id)?;
    emit_runners_changed(app, "ipc.runner.rm", &target.project_id);
    Ok(json!({ "removed": target }))
}

fn handle_runner_stop(app: &AppHandle, target: RunnerRecord) -> Result<serde_json::Value> {
    let (was_live, _) = liveness(app, &target);
    kill_processes(app, &target.id);
    // The supervisors announce an exit from their reader threads, but only
    // once the pipe drains; say it now so the UI never shows a ghost.
    let _ = app.emit(
        "runner-status",
        json!({ "projectId": target.project_id, "runnerId": target.id, "status": "exited" }),
    );
    emit_runners_changed(app, "ipc.runner.stop", &target.project_id);
    Ok(json!({ "stopped": target.id, "wasLive": was_live }))
}

fn handle_runner_rename(app: &AppHandle, mut target: RunnerRecord, to: &str) -> Result<serde_json::Value> {
    let to = to.trim();
    if to.is_empty() {
        anyhow::bail!("--to needs a name");
    }
    target.name = to.to_string();
    target.name_auto = false;
    let store = app.state::<Store>();
    store.runners_upsert(&projects::runner_record_to_row(&target)?)?;
    emit_runners_changed(app, "ipc.runner.rename", &target.project_id);
    Ok(serde_json::to_value(target)?)
}

/// Resolves a project handle to a record. `"."` means "use whatever
/// COSMOS_PROJECT_SLUG resolved to on the client side" — by the time we get
/// here the CLI already substituted, so we should never see a literal `.`.
/// Anything else is treated as a slug.
fn resolve_project(app: &AppHandle, handle: &str) -> Result<ProjectRecord> {
    if handle == "." || handle.is_empty() {
        anyhow::bail!(
            "project handle `{handle}` was not resolved by the client. \
             Set COSMOS_PROJECT_SLUG or pass a real slug"
        );
    }
    let store = app.state::<Store>();
    let row = store
        .projects_get_by_slug(handle)?
        .ok_or_else(|| anyhow!("no project with slug `{handle}`"))?;
    projects::row_to_record(row)
}

struct AddOptions<'a> {
    kind: &'a str,
    task: &'a str,
    worktree: bool,
    tty: bool,
    model: &'a str,
    provider: &'a str,
    parent: &'a str,
}

/// Persists a runner and brings it up. Claude agents are chats by default:
/// no process until the first message, which `agent-task` asks the webview to
/// send. Shells and `--tty` agents get their PTY right away.
fn spawn_runner(
    app: &AppHandle,
    project: &ProjectRecord,
    name: String,
    opts: &AddOptions,
) -> Result<RunnerRecord> {
    let store = app.state::<Store>();
    let home = home_of(app)?;
    let mut rec = projects::build_runner_record(
        crate::uuid_v4_for_ipc(),
        project.id.clone(),
        opts.kind.to_string(),
        name,
        None,
        None,
        None,
        now_unix(),
    );
    let is_agent = rec.kind == "agent";
    let as_chat =
        projects::CHAT_ENABLED && is_agent && !opts.tty && projects::is_claude_command(&rec.args);
    if as_chat {
        rec.mode = "chat".into();
    }
    if is_agent {
        rec.task = opts.task.trim().to_string();
        let (provider, model) = crate::providers::resolve(&home, opts.provider, opts.model)?;
        rec.provider = provider;
        rec.model = model;
    } else if !opts.model.is_empty() || !opts.provider.is_empty() {
        anyhow::bail!("--model and --provider only apply to agents");
    }
    // A parent that no longer exists is dropped rather than refused: the
    // delegation line is a nicety, the agent is the point.
    if store.runners_get(opts.parent)?.is_some() {
        rec.parent_id = opts.parent.to_string();
    }
    if opts.worktree {
        if !is_agent {
            anyhow::bail!("--worktree only applies to agents");
        }
        let (path, branch) = crate::worktree::create(&home, project, &rec.name)?;
        rec.cwd = path;
        rec.branch = branch;
    }
    store.runners_upsert(&projects::runner_record_to_row(&rec)?)?;

    if !as_chat {
        ops::spawn_pty(app, project, &rec, &rec.task)?;
    }
    emit_runners_changed(app, "ipc.runner.add", &project.id);
    if as_chat && !rec.task.is_empty() {
        let _ = app.emit("agent-task", json!({ "runnerId": rec.id, "text": rec.task }));
    }
    Ok(rec)
}
