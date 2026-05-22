mod clis;
mod fs_ops;
pub mod ipc;
mod ipc_server;
mod memory;
mod projects;
mod pty_supervisor;
mod status_fsm;
mod store;

use std::time::{SystemTime, UNIX_EPOCH};

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
    sup.spawn_with_slug(app, id, project_id, project_slug, kind, cwd, program, args, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill_project(sup: State<'_, PtySupervisor>, project_id: String) -> Result<(), String> {
    sup.kill_project(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_status(sup: State<'_, PtySupervisor>, id: String) -> Option<Status> {
    sup.status(&id)
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
fn pty_live_ids(sup: State<'_, PtySupervisor>) -> Vec<String> {
    sup.list()
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
        let out = std::process::Command::new("git")
            .args(["-C", &cwd, "diff", "--no-color"])
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
    sup: State<'_, PtySupervisor>,
    store: State<'_, Store>,
    id: String,
) -> Result<(), String> {
    // Kill any live runners first so we don't leave orphan PTYs after the
    // rows are gone.
    sup.kill_project(&id).map_err(|e| e.to_string())?;
    store.projects_delete(&id).map_err(|e| e.to_string())
}

/* ----------------------------- runners ----------------------------- */

#[tauri::command]
fn runners_list(store: State<'_, Store>) -> Result<Vec<RunnerRecord>, String> {
    projects::runners_list(&store).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn runners_create(
    store: State<'_, Store>,
    project_id: String,
    kind: String,
    name: String,
    program: Option<String>,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<RunnerRecord, String> {
    let rec = projects::build_runner_record(
        uuid_v4(),
        project_id,
        kind,
        name,
        program,
        args,
        env,
        now_unix(),
    );
    let row = projects::runner_record_to_row(&rec).map_err(|e| e.to_string())?;
    store.runners_upsert(&row).map_err(|e| e.to_string())?;
    Ok(rec)
}

#[tauri::command]
fn runners_update(
    store: State<'_, Store>,
    id: String,
    name: String,
) -> Result<(), String> {
    let all = projects::runners_list(&store).map_err(|e| e.to_string())?;
    let mut found = all
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "runner not found".to_string())?;
    found.name = name;
    found.last_active = now_unix();
    let row = projects::runner_record_to_row(&found).map_err(|e| e.to_string())?;
    store.runners_upsert(&row).map_err(|e| e.to_string())
}

#[tauri::command]
fn runners_delete(
    sup: State<'_, PtySupervisor>,
    store: State<'_, Store>,
    id: String,
) -> Result<(), String> {
    let _ = sup.kill(&id);
    store.runners_delete(&id).map_err(|e| e.to_string())
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

            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                if let Some(win) = app.get_webview_window("main") {
                    let _ = apply_vibrancy(
                        &win,
                        NSVisualEffectMaterial::HudWindow,
                        Some(NSVisualEffectState::Active),
                        None,
                    );
                }
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
            pty_kill_project,
            memories_list,
            memories_upsert,
            memories_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
