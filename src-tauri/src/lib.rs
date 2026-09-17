mod agent_proc;
mod claude_session;
mod clis;
mod fs_ops;
pub mod ipc;
mod ipc_server;
mod master;
mod memory;
mod projects;
mod pty_supervisor;
pub mod remote;
mod status_fsm;
mod store;
mod tunnel;
mod worktree;
mod web;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use agent_proc::{AgentLine, AgentSupervisor, SpawnSpec};
use clis::CliInfo;
use memory::MemoryCard;
use projects::{ProjectRecord, RunnerRecord};
use pty_supervisor::{PtySupervisor, RunnerKind};
use status_fsm::Status;
use store::Store;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Manager, State,
};

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn pty_spawn(
    app: AppHandle,
    sup: State<'_, PtySupervisor>,
    store: State<'_, Store>,
    id: String,
    cwd: String,
    program: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    // Optional in Step 1 — old call sites (Terminal.tsx) don't pass these yet.
    // When absent, runner is treated as a legacy agent with no project routing.
    project_id: Option<String>,
    kind: Option<String>,
    prompt: Option<String>,
) -> Result<(), String> {
    let project_id = project_id.unwrap_or_default();
    let kind = kind
        .as_deref()
        .map(RunnerKind::from_str)
        .unwrap_or(RunnerKind::Agent);
    // Resolve slug for env injection so `cosmos --project .` works. Best-effort:
    // a missing project just yields an empty slug, same as legacy call sites.
    let project_slug = if project_id.is_empty() {
        String::new()
    } else {
        store
            .projects_get(&project_id)
            .ok()
            .flatten()
            .map(|r| r.slug)
            .unwrap_or_default()
    };
    // Fold in the runner's name + session handle. The row is the authority:
    // persisted args stay generic, so a rename or a resume never needs a row
    // rewrite, and a legacy row that still carries an injected `--name` gets
    // cleaned up on its way to the PTY.
    let args = match store
        .runners_get(&id)
        .ok()
        .flatten()
        .and_then(|row| projects::runner_row_to_record(row).ok())
    {
        Some(rec) => {
            let home = home_dir(&app).unwrap_or_default();
            let args = projects::spawn_args_for(&home, &rec, &cwd);
            let args = projects::with_project_memory(args, &home, &project_slug, &rec);
            projects::with_initial_prompt(args, &rec, prompt.as_deref().unwrap_or(""))
        }
        None => args,
    };
    sup.spawn_with_slug(app, id, project_id, project_slug, kind, cwd, program, args, cols, rows)
        .map_err(|e| e.to_string())
}

/// Cosmos is a GUI app with no console of its own, so on Windows every
/// console child (powershell, git) would get a visible window, and closing
/// that window kills the child. CREATE_NO_WINDOW keeps it headless.
pub(crate) fn no_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// The same, for builder chains.
pub(crate) trait NoConsole {
    fn hidden(&mut self) -> &mut Self;
}
impl NoConsole for std::process::Command {
    fn hidden(&mut self) -> &mut Self {
        no_console(self);
        self
    }
}

/// Stop a runner's PTY without deleting the row. This is what the UI's close
/// button does now: the conversation stays resumable, and reopening the tab
/// respawns with `--resume`.
#[tauri::command]
fn runners_stop(
    sup: State<'_, PtySupervisor>,
    agents: State<'_, Arc<AgentSupervisor>>,
    id: String,
) -> Result<(), String> {
    agents.kill(&id);
    sup.kill(&id).map_err(|e| e.to_string())
}

/// Stop every runner in a project without deleting anything. Closing a
/// project is a view operation, not a destructive one — `projects_delete`
/// stays available behind an explicit confirm in the editor modal.
#[tauri::command]
fn projects_close(
    sup: State<'_, PtySupervisor>,
    agents: State<'_, Arc<AgentSupervisor>>,
    id: String,
) -> Result<(), String> {
    agents.kill_project(&id);
    sup.kill_project(&id).map_err(|e| e.to_string())
}

/// Drop the stored session handle and mint a new one, so the next spawn
/// starts a clean conversation instead of resuming the old transcript.
#[tauri::command]
fn runners_reset_session(store: State<'_, Store>, id: String) -> Result<(), String> {
    let mut row = store
        .runners_get(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "runner not found".to_string())?;
    if !row.session_id.is_empty() {
        row.session_id = uuid_v4();
    }
    row.last_active = now_unix();
    store.runners_upsert(&row).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill_project(
    sup: State<'_, PtySupervisor>,
    agents: State<'_, Arc<AgentSupervisor>>,
    project_id: String,
) -> Result<(), String> {
    agents.kill_project(&project_id);
    sup.kill_project(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_status(
    sup: State<'_, PtySupervisor>,
    agents: State<'_, Arc<AgentSupervisor>>,
    id: String,
) -> Option<Status> {
    agents.status(&id).or_else(|| sup.status(&id))
}

#[tauri::command]
fn pty_attach(
    sup: State<'_, PtySupervisor>,
    id: String,
    output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    sup.attach(&id, output).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_detach(sup: State<'_, PtySupervisor>, id: String) -> Result<(), String> {
    sup.detach(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_write(sup: State<'_, PtySupervisor>, id: String, data: String) -> Result<(), String> {
    sup.write(&id, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(
    sup: State<'_, PtySupervisor>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    sup.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill(sup: State<'_, PtySupervisor>, id: String) -> Result<(), String> {
    sup.kill(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_live_ids(
    sup: State<'_, PtySupervisor>,
    agents: State<'_, Arc<AgentSupervisor>>,
) -> Vec<String> {
    let mut ids = sup.list();
    ids.extend(agents.list());
    ids
}

#[tauri::command]
fn debug_log(msg: String) {
    eprintln!("[js] {msg}");
}

#[tauri::command]
fn fs_read_dir(path: String) -> Result<Vec<fs_ops::DirEntry>, String> {
    fs_ops::read_dir(path.into()).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_read_file(path: String) -> Result<String, String> {
    fs_ops::read_file(path.into()).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_write_file(path: String, content: String) -> Result<(), String> {
    fs_ops::write_file(path.into(), content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_walk(root: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || fs_ops::walk_files(root.into()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn fs_grep(root: String, query: String) -> Result<Vec<fs_ops::GrepMatch>, String> {
    tokio::task::spawn_blocking(move || fs_ops::grep(root.into(), query))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_detect_stack(cwd: String) -> Vec<fs_ops::StackInfo> {
    fs_ops::detect_stack(cwd.into())
}

#[tauri::command]
fn fs_claude_md(cwd: String) -> Option<String> {
    fs_ops::read_claude_md(cwd.into())
}

#[tauri::command]
fn fs_read_package_scripts(folder: String) -> fs_ops::ScriptsInfo {
    fs_ops::read_package_scripts(folder.into())
}

#[tauri::command]
fn clis_detect() -> Vec<CliInfo> {
    clis::detect()
}

#[tauri::command]
fn clis_get(id: String) -> Option<CliInfo> {
    clis::preset_by_id(&id)
}

/// Receives image bytes as a raw IPC body (no JSON serialization), writes them
/// to a unique file under the OS temp dir, and returns the absolute path so the
/// caller can hand it to Claude via `@/path` syntax.
/// Run `git diff --no-color` in the agent's cwd. Returns the diff text on
/// success, or an error string (typically "not a git repository") that the
/// frontend renders as an empty state.
#[tauri::command]
async fn git_diff(cwd: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.args(["-C", &cwd, "diff", "--no-color"]);
        no_console(&mut cmd);
        let out = cmd
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        const CAP: usize = 1024 * 1024;
        if text.len() > CAP {
            let mut end = CAP;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            text.push_str("\n\n…(diff truncated to 1 MiB)");
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn fs_save_temp_image(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => return Err("expected raw body".into()),
    };
    let ext_raw = request
        .headers()
        .get("X-Ext")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("png");
    let safe_ext: String = ext_raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let safe_ext = if safe_ext.is_empty() {
        "png".to_string()
    } else {
        safe_ext.to_lowercase()
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("cosmos-{ts}.{safe_ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/* ------------------------------ settings ------------------------------ */

#[tauri::command]
fn remote_config_get(app: AppHandle) -> Result<serde_json::Value, String> {
    let home = home_dir(&app)?;
    let cfg = remote::load_config(&home);
    let mut v = serde_json::to_value(&cfg).map_err(|e| e.to_string())?;
    if let Some(obj) = v.as_object_mut() {
        obj.insert("tunnel_running".into(), tunnel::is_running().into());
        obj.insert(
            "cloudflared_present".into(),
            tunnel::binary().is_some().into(),
        );
    }
    Ok(v)
}

/// Persists the remote settings and reconciles the tunnel immediately.
/// `enabled` and `port` are read when the web server binds at launch, so a
/// change to either only takes effect on the next start — the UI says so
/// rather than pretending otherwise.
#[tauri::command]
fn remote_config_set(app: AppHandle, config: remote::RemoteConfig) -> Result<(), String> {
    let home = home_dir(&app)?;
    remote::save_config(&home, &config).map_err(|e| e.to_string())?;
    remote::apply_tunnel(&home, &config);
    Ok(())
}

#[tauri::command]
fn projects_reorder(store: State<'_, Store>, ids: Vec<String>) -> Result<(), String> {
    store.reorder("projects", &ids).map_err(|e| e.to_string())
}

#[tauri::command]
fn runners_reorder(store: State<'_, Store>, ids: Vec<String>) -> Result<(), String> {
    store.reorder("runners", &ids).map_err(|e| e.to_string())
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Hands a URL to the OS browser. The in-app preview is an iframe, so any site
/// that refuses framing needs an escape hatch.
/// Reveals a project folder in the file manager, or hands it to an editor.
#[tauri::command]
fn open_path(path: String, app: Option<String>) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("caminho não existe: {path}"));
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        if let Some(app) = app.as_deref().filter(|a| !a.is_empty()) {
            c.args(["-a", app]);
        }
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let _ = &app;
        std::process::Command::new("explorer")
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let _ = &app;
        std::process::Command::new("xdg-open")
    };
    cmd.arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) urls".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        no_console(&mut c);
        c.args(["/C", "start", ""]);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");

    cmd.arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn home_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().home_dir().map_err(|e| e.to_string())
}

/* ----------------------------- projects ----------------------------- */

#[tauri::command]
fn projects_list(store: State<'_, Store>) -> Result<Vec<ProjectRecord>, String> {
    projects::list(&store).map_err(|e| e.to_string())
}

#[tauri::command]
fn projects_create(
    app: AppHandle,
    store: State<'_, Store>,
    name: String,
    folders: Vec<String>,
    memory: String,
) -> Result<ProjectRecord, String> {
    let home = home_dir(&app)?;
    projects::create_project(&home, &store, name, folders, memory, uuid_v4(), now_unix())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn projects_update(
    app: AppHandle,
    store: State<'_, Store>,
    id: String,
    name: String,
    folders: Vec<String>,
    memory: String,
) -> Result<ProjectRecord, String> {
    let home = home_dir(&app)?;
    let folders = projects::dedupe_folders(folders);
    if folders.is_empty() {
        return Err("at least one folder is required".into());
    }
    let trimmed_name = name.trim().to_string();
    if trimmed_name.is_empty() {
        return Err("name is required".into());
    }
    if projects::name_exists(&store, &trimmed_name, Some(&id)).map_err(|e| e.to_string())? {
        return Err(format!("a project named \"{trimmed_name}\" already exists"));
    }
    let existing = store
        .projects_get(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "project not found".to_string())?;
    // Slug is sticky — keep the existing one. Renaming changes the label,
    // never the on-disk path. See plan doc for rationale.
    let slug = existing.slug.clone();
    let cwd = projects::compute_project_cwd(&home, &slug, &folders)
        .to_string_lossy()
        .into_owned();
    let rec = ProjectRecord {
        id: id.clone(),
        name: trimmed_name,
        slug: slug.clone(),
        folders,
        memory,
        cwd,
        created_at: existing.created_at,
    };
    let row = projects::record_to_row(&rec).map_err(|e| e.to_string())?;
    store.projects_upsert(&row).map_err(|e| e.to_string())?;
    projects::ensure_project_dir(&home, &rec.slug, &rec.name, &rec.folders, &rec.memory)
        .map_err(|e| e.to_string())?;
    Ok(rec)
}

#[tauri::command]
fn projects_delete(
    app: AppHandle,
    sup: State<'_, PtySupervisor>,
    agents: State<'_, Arc<AgentSupervisor>>,
    store: State<'_, Store>,
    id: String,
) -> Result<(), String> {
    let home = home_dir(&app)?;
    agents.kill_project(&id);
    // Kill any live runners first so we don't leave orphan PTYs after the
    // rows are gone.
    sup.kill_project(&id).map_err(|e| e.to_string())?;
    projects::delete_project(&home, &store, &id).map_err(|e| e.to_string())?;
    Ok(())
}


/* ----------------------------- runners ----------------------------- */

#[tauri::command]
fn runners_list(store: State<'_, Store>) -> Result<Vec<RunnerRecord>, String> {
    projects::runners_list(&store).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn runners_create(
    app: AppHandle,
    store: State<'_, Store>,
    project_id: String,
    kind: String,
    name: String,
    program: Option<String>,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    mode: Option<String>,
    name_auto: Option<bool>,
    cwd: Option<String>,
    task: Option<String>,
    worktree: Option<bool>,
) -> Result<RunnerRecord, String> {
    let mut rec = projects::build_runner_record(
        uuid_v4(),
        project_id.clone(),
        kind,
        name,
        program,
        args,
        env,
        now_unix(),
    );
    if projects::CHAT_ENABLED && mode.as_deref() == Some("chat") && projects::is_claude_command(&rec.args) {
        rec.mode = "chat".into();
    }
    rec.name_auto = name_auto.unwrap_or(false);
    rec.task = task.unwrap_or_default().trim().to_string();
    rec.cwd = cwd.unwrap_or_default();
    if worktree.unwrap_or(false) {
        let project = store
            .projects_get(&project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "projeto não encontrado".to_string())
            .and_then(|row| projects::row_to_record(row).map_err(|e| e.to_string()))?;
        let (path, branch) = worktree::create(&home_dir(&app)?, &project, &rec.name)
            .map_err(|e| format!("Não consegui criar o worktree: {e}"))?;
        rec.cwd = path;
        rec.branch = branch;
    }
    let row = projects::runner_record_to_row(&rec).map_err(|e| e.to_string())?;
    store.runners_upsert(&row).map_err(|e| e.to_string())?;
    Ok(rec)
}

/// Marks a runner as just used, so "stopped for N days" means something.
#[tauri::command]
fn runners_touch(store: State<'_, Store>, id: String) -> Result<(), String> {
    let mut found = runner_record(&store, &id)?;
    found.last_active = now_unix();
    let row = projects::runner_record_to_row(&found).map_err(|e| e.to_string())?;
    store.runners_upsert(&row).map_err(|e| e.to_string())
}

#[tauri::command]
fn runners_set_task(store: State<'_, Store>, id: String, task: String) -> Result<(), String> {
    let mut found = runner_record(&store, &id)?;
    found.task = task.trim().to_string();
    let row = projects::runner_record_to_row(&found).map_err(|e| e.to_string())?;
    store.runners_upsert(&row).map_err(|e| e.to_string())
}

/// Branch and worktree count for each path, read off the disk.
#[tauri::command]
fn git_info(paths: Vec<String>) -> Vec<worktree::GitInfo> {
    paths.iter().map(|p| worktree::info(p)).collect()
}

#[tauri::command]
fn runners_update(
    store: State<'_, Store>,
    id: String,
    name: String,
    auto: Option<bool>,
) -> Result<(), String> {
    let mut found = runner_record(&store, &id)?;
    found.name = name;
    found.name_auto = auto.unwrap_or(false);
    found.last_active = now_unix();
    let row = projects::runner_record_to_row(&found).map_err(|e| e.to_string())?;
    store.runners_upsert(&row).map_err(|e| e.to_string())
}

fn runner_record(store: &Store, id: &str) -> Result<RunnerRecord, String> {
    store
        .runners_get(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "runner not found".to_string())
        .and_then(|row| projects::runner_row_to_record(row).map_err(|e| e.to_string()))
}

/// Chat and terminal are two front ends for the same Claude session; the
/// caller stops whichever process is running before flipping this.
#[tauri::command]
fn runners_set_mode(store: State<'_, Store>, id: String, mode: String) -> Result<(), String> {
    let mut found = runner_record(&store, &id)?;
    found.mode = if projects::CHAT_ENABLED && mode == "chat" && projects::is_claude_command(&found.args) {
        "chat".into()
    } else {
        "tty".into()
    };
    let row = projects::runner_record_to_row(&found).map_err(|e| e.to_string())?;
    store.runners_upsert(&row).map_err(|e| e.to_string())
}

/* ------------------------------ chat ------------------------------ */

#[tauri::command]
fn agent_start(
    app: AppHandle,
    agents: State<'_, Arc<AgentSupervisor>>,
    store: State<'_, Store>,
    id: String,
    cwd: String,
    model: Option<String>,
    permission_mode: String,
) -> Result<(), String> {
    if agents.is_live(&id) {
        return Ok(());
    }
    let rec = runner_record(&store, &id)?;
    if !projects::is_claude_command(&rec.args) {
        return Err("esta sessão não roda o Claude Code".into());
    }
    let home = home_dir(&app)?;
    let opts = projects::ChatOptions {
        model: model.as_deref(),
        permission_mode: &permission_mode,
    };
    let project_slug = store
        .projects_get(&rec.project_id)
        .ok()
        .flatten()
        .map(|r| r.slug)
        .unwrap_or_default();
    let args = projects::chat_args_for(&home, &rec, &cwd, &opts);
    let args = projects::with_project_memory(args, &home, &project_slug, &rec);
    let spec = SpawnSpec {
        id,
        project_id: rec.project_id.clone(),
        project_slug,
        cwd,
        program: rec.program.clone(),
        args,
        env: rec.env.clone(),
    };
    agents.spawn(app, spec).map_err(|e| e.to_string())
}

#[tauri::command]
fn agent_send(
    agents: State<'_, Arc<AgentSupervisor>>,
    id: String,
    line: String,
) -> Result<(), String> {
    agents.send(&id, &line).map_err(|e| e.to_string())
}

#[tauri::command]
fn agent_snapshot(
    agents: State<'_, Arc<AgentSupervisor>>,
    id: String,
    after: Option<u64>,
) -> Vec<AgentLine> {
    agents.snapshot(&id, after.unwrap_or(0))
}

#[tauri::command]
fn agent_kill(agents: State<'_, Arc<AgentSupervisor>>, id: String) {
    agents.kill(&id);
}

/// The stored conversation, for a chat that opens with no process behind it.
#[tauri::command]
async fn agent_history(
    app: AppHandle,
    store: State<'_, Store>,
    id: String,
    cwd: String,
) -> Result<Vec<String>, String> {
    let rec = runner_record(&store, &id)?;
    let path = claude_session::transcript_path(&home_dir(&app)?, &cwd, &rec.session_id);
    if !path.exists() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || claude_session::read_history(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn session_title_get(
    app: AppHandle,
    store: State<'_, Store>,
    id: String,
    cwd: String,
) -> Result<claude_session::SessionTitle, String> {
    let rec = runner_record(&store, &id)?;
    let path = claude_session::transcript_path(&home_dir(&app)?, &cwd, &rec.session_id);
    if !path.exists() {
        return Ok(Default::default());
    }
    claude_session::read_title(&path).map_err(|e| e.to_string())
}

/// Writes the title into the transcript. Refused while a process owns the
/// session: a live CLI must be renamed through its own channel, or it
/// re-appends the title it still holds.
#[tauri::command]
fn session_title_set(
    app: AppHandle,
    sup: State<'_, PtySupervisor>,
    agents: State<'_, Arc<AgentSupervisor>>,
    store: State<'_, Store>,
    id: String,
    cwd: String,
    title: String,
) -> Result<bool, String> {
    if agents.is_live(&id) || sup.list().contains(&id) {
        return Ok(false);
    }
    let rec = runner_record(&store, &id)?;
    let path = claude_session::transcript_path(&home_dir(&app)?, &cwd, &rec.session_id);
    claude_session::append_title(&path, &rec.session_id, &title).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn runners_delete(
    app: AppHandle,
    sup: State<'_, PtySupervisor>,
    agents: State<'_, Arc<AgentSupervisor>>,
    store: State<'_, Store>,
    id: String,
) -> Result<(), String> {
    agents.kill(&id);
    let _ = sup.kill(&id);
    if let (Ok(rec), Ok(home)) = (runner_record(&store, &id), home_dir(&app)) {
        remove_runner_worktree(&store, &home, &rec);
    }
    store.runners_delete(&id).map_err(|e| e.to_string())
}

/// Best effort: git keeps a worktree that still holds uncommitted work.
pub(crate) fn remove_runner_worktree(store: &Store, home: &std::path::Path, rec: &RunnerRecord) {
    if rec.branch.is_empty() || !worktree::is_managed(home, &rec.cwd) {
        return;
    }
    let repo = store
        .projects_get(&rec.project_id)
        .ok()
        .flatten()
        .and_then(|row| projects::row_to_record(row).ok())
        .and_then(|p| p.folders.first().cloned());
    if let Some(repo) = repo {
        let _ = worktree::remove(&repo, &rec.cwd);
    }
}

/* ----------------------------- memory ----------------------------- */

#[tauri::command]
fn memories_list(
    app: AppHandle,
    store: State<'_, Store>,
    project_id: String,
) -> Result<Vec<MemoryCard>, String> {
    let home = home_dir(&app)?;
    let project = store
        .projects_get(&project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "project not found".to_string())?;
    memory::list_cards(&home, &project.slug).map_err(|e| e.to_string())
}

#[tauri::command]
fn memories_upsert(
    app: AppHandle,
    store: State<'_, Store>,
    project_id: String,
    card: MemoryCard,
) -> Result<MemoryCard, String> {
    let home = home_dir(&app)?;
    let project_rec = store
        .projects_get(&project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "project not found".to_string())?;
    let project = projects::row_to_record(project_rec).map_err(|e| e.to_string())?;
    let mut card = card;
    if card.id.is_empty() {
        card.id = uuid_v4().chars().take(12).collect();
    }
    let now = now_unix();
    if card.created_at == 0 {
        card.created_at = now;
    }
    card.updated_at = now;
    if card.kind.is_empty() {
        card.kind = "note".to_string();
    }
    memory::upsert_card(&home, &project.slug, &card).map_err(|e| e.to_string())?;
    // Auto-regen CLAUDE.md so pinned changes flow to Claude without a project
    // edit. No-op for single-folder projects.
    let _ = projects::refresh_claude_md(
        &home,
        &project.slug,
        &project.name,
        &project.folders,
        &project.memory,
    );
    Ok(card)
}

#[tauri::command]
fn memories_delete(
    app: AppHandle,
    store: State<'_, Store>,
    project_id: String,
    card_id: String,
) -> Result<(), String> {
    let home = home_dir(&app)?;
    let project_rec = store
        .projects_get(&project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "project not found".to_string())?;
    let project = projects::row_to_record(project_rec).map_err(|e| e.to_string())?;
    memory::delete_card(&home, &project.slug, &card_id).map_err(|e| e.to_string())?;
    let _ = projects::refresh_claude_md(
        &home,
        &project.slug,
        &project.name,
        &project.folders,
        &project.memory,
    );
    Ok(())
}

/// Local URL, tunnel URL and token for the web control plane — what the
/// title bar shows and what `cosmos web` prints.
#[tauri::command]
fn web_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let home = home_dir(&app)?;
    Ok(remote::info(&home))
}

/// Re-export for `ipc_server` which lives in this crate but outside the
/// tauri-command boundary where `uuid_v4` is otherwise private.
pub(crate) fn uuid_v4_for_ipc() -> String {
    uuid_v4()
}

/// Minimal UUID-v4 generator using OS randomness. Avoids adding the `uuid`
/// crate just for one call site.
fn uuid_v4() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut bytes);
    } else {
        // Fallback: pseudo-random from nanos. Not crypto-secure, but unique
        // enough for a local workspace id.
        let n = now_nanos();
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = ((n >> (i * 4 % 64)) & 0xff) as u8;
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PtySupervisor::new())
        .manage(Arc::new(AgentSupervisor::new()))
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            let store = Store::open(data_dir.join("cosmos.sqlite"))?;
            let home = app
                .path()
                .home_dir()
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            store.migrate(&home)?;
            projects::migrate_to_synthetic_cwd(&store, &home)?;
            app.manage(store);

            // The master agent comes up before anything else touches the UI:
            // Cosmos should never open on an empty room.
            if let Err(e) = master::ensure(app.handle()) {
                eprintln!("[cosmos] master agent `geral` failed to start: {e}");
            }

            // Remote control plane: loopback HTTP + Cloudflare tunnel.
            match remote::start(app.handle().clone(), &home) {
                Ok(Some(port)) => eprintln!("[cosmos] web UI on http://127.0.0.1:{port}"),
                Ok(None) => {}
                Err(e) => eprintln!("[cosmos] web UI failed to start: {e}"),
            }

            // IPC server for the `cosmos` CLI. Logged but non-fatal — if a
            // stale peer (or another running Cosmos) holds the socket, the
            // app still works, agents just can't self-register until the
            // collision is resolved.
            let socket_path = ipc::default_socket_path(&home);
            if let Err(e) = ipc_server::start(app.handle().clone(), socket_path.clone()) {
                eprintln!(
                    "[cosmos] IPC server failed to start ({e}). \
                     `cosmos` CLI from spawned agents won't work this session."
                );
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            remote_config_get,
            remote_config_set,
            projects_reorder,
            runners_reorder,
            app_version,
            open_external,
            open_path,
            pty_spawn,
            pty_status,
            pty_attach,
            pty_detach,
            pty_write,
            pty_resize,
            pty_kill,
            pty_live_ids,
            debug_log,
            fs_read_dir,
            fs_read_file,
            fs_write_file,
            fs_walk,
            fs_grep,
            fs_detect_stack,
            fs_claude_md,
            fs_read_package_scripts,
            clis_detect,
            clis_get,
            fs_save_temp_image,
            git_diff,
            projects_list,
            projects_create,
            projects_update,
            projects_delete,
            runners_list,
            runners_create,
            runners_update,
            runners_delete,
            runners_stop,
            runners_set_mode,
            runners_touch,
            runners_set_task,
            git_info,
            runners_reset_session,
            agent_start,
            agent_send,
            agent_snapshot,
            agent_history,
            agent_kill,
            session_title_get,
            session_title_set,
            projects_close,
            pty_kill_project,
            memories_list,
            memories_upsert,
            memories_delete,
            web_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // The tunnel is a child process; without this it outlives the
            // window and keeps a public URL alive with nothing behind it.
            if let tauri::RunEvent::Exit = event {
                tunnel::shutdown();
            }
        });
}
