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
use std::thread;

use anyhow::{anyhow, Context, Result};
use interprocess::local_socket::{prelude::*, ListenerOptions, Stream};
#[cfg(unix)]
use interprocess::local_socket::GenericFilePath;
#[cfg(windows)]
use interprocess::local_socket::GenericNamespaced;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::ipc::{Request, Response};
use crate::projects::{self, ProjectRecord};
use crate::pty_supervisor::{PtySupervisor, RunnerKind};
use crate::store::Store;

/// Reasonable default geometry for an auto-spawned PTY. The UI resizes to the
/// real terminal dims when the user attaches in the webview.
const SPAWN_COLS: u16 = 120;
const SPAWN_ROWS: u16 = 32;

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
    match req {
        Request::ProjectAdd {
            name,
            folders,
            memory,
            with_agent,
        } => match handle_project_add(app, name, folders, memory, with_agent) {
            Ok(v) => Response::ok(v),
            Err(e) => Response::err(e.to_string()),
        },
        Request::ProjectList => match handle_project_list(app) {
            Ok(v) => Response::ok(v),
            Err(e) => Response::err(e.to_string()),
        },
        Request::RunnerAdd {
            project,
            name,
            kind,
        } => match handle_runner_add(app, project, name, kind.as_deref()) {
            Ok(v) => Response::ok(v),
            Err(e) => Response::err(e.to_string()),
        },
        Request::RunnerList { project } => match handle_runner_list(app, project.as_deref()) {
            Ok(v) => Response::ok(v),
            Err(e) => Response::err(e.to_string()),
        },
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn home_of(app: &AppHandle) -> Result<std::path::PathBuf> {
    app.path()
        .home_dir()
        .map_err(|e| anyhow!(e.to_string()))
}

fn handle_project_add(
    app: &AppHandle,
    name: String,
    folders: Vec<String>,
    memory: String,
    with_agent: Option<String>,
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
        Some(spawn_runner(app, &project, "agent", agent_name)?)
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

fn handle_runner_add(
    app: &AppHandle,
    project_handle: String,
    name: String,
    kind: Option<&str>,
) -> Result<serde_json::Value> {
    let project = resolve_project(app, &project_handle)?;
    let kind = kind.unwrap_or("agent").to_string();
    let runner = spawn_runner(app, &project, &kind, name)?;
    Ok(serde_json::to_value(runner)?)
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
    Ok(serde_json::to_value(filtered)?)
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

/// Persist a runner record, then spawn its PTY against the project's cwd
/// using the canonical agent/shell defaults. Emits `runners-changed` so the
/// sidebar refreshes.
fn spawn_runner(
    app: &AppHandle,
    project: &ProjectRecord,
    kind: &str,
    name: String,
) -> Result<crate::projects::RunnerRecord> {
    let store = app.state::<Store>();
    let supervisor = app.state::<PtySupervisor>();
    let rec = projects::build_runner_record(
        crate::uuid_v4_for_ipc(),
        project.id.clone(),
        kind.to_string(),
        name,
        None,
        None,
        None,
        now_unix(),
    );
    let row = projects::runner_record_to_row(&rec)?;
    store.runners_upsert(&row)?;

    let runner_kind = RunnerKind::from_str(&rec.kind);
    supervisor.spawn_with_slug(
        app.clone(),
        rec.id.clone(),
        project.id.clone(),
        project.slug.clone(),
        runner_kind,
        project.cwd.clone(),
        rec.program.clone(),
        rec.args.clone(),
        SPAWN_COLS,
        SPAWN_ROWS,
    )?;
    let _ = app.emit(
        "runners-changed",
        json!({ "reason": "ipc.runner.add", "projectId": project.id }),
    );
    Ok(rec)
}
