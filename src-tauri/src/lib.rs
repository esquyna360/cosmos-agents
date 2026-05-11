mod fs_ops;
mod pty_supervisor;
mod status_fsm;
mod store;
mod workspaces;

use std::time::{SystemTime, UNIX_EPOCH};

use pty_supervisor::PtySupervisor;
use status_fsm::Status;
use store::{AgentRecord, Store};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Manager, State,
};
use workspaces::WorkspaceRecord;

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    sup: State<'_, PtySupervisor>,
    id: String,
    cwd: String,
    program: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    sup.spawn(app, id, cwd, program, args, cols, rows)
        .map_err(|e| e.to_string())
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
fn agents_list(store: State<'_, Store>) -> Result<Vec<AgentRecord>, String> {
    store.list().map_err(|e| e.to_string())
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

#[tauri::command]
fn agents_upsert(
    store: State<'_, Store>,
    id: String,
    name: String,
    cwd: String,
) -> Result<AgentRecord, String> {
    let now = now_unix();
    let rec = AgentRecord {
        id,
        name,
        cwd,
        created_at: now,
        last_active: now,
    };
    store.upsert(&rec).map_err(|e| e.to_string())?;
    Ok(rec)
}

#[tauri::command]
fn agents_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.delete(&id).map_err(|e| e.to_string())
}

fn home_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().home_dir().map_err(|e| e.to_string())
}

#[tauri::command]
fn workspaces_list(
    app: AppHandle,
    store: State<'_, Store>,
) -> Result<Vec<WorkspaceRecord>, String> {
    let home = home_dir(&app)?;
    workspaces::list(&store, &home).map_err(|e| e.to_string())
}

#[tauri::command]
fn workspaces_create(
    app: AppHandle,
    store: State<'_, Store>,
    name: String,
    folders: Vec<String>,
    memory: String,
) -> Result<WorkspaceRecord, String> {
    let home = home_dir(&app)?;
    let folders = workspaces::dedupe_folders(folders);
    if folders.is_empty() {
        return Err("at least one folder is required".into());
    }
    let id = uuid_v4();
    let rec = WorkspaceRecord {
        id: id.clone(),
        name: name.trim().to_string(),
        folders: folders.clone(),
        memory,
        cwd: workspaces::workspace_dir(&home, &id)
            .to_string_lossy()
            .into_owned(),
        created_at: now_unix(),
    };
    let row = workspaces::record_to_row(&rec).map_err(|e| e.to_string())?;
    store.workspaces_upsert(&row).map_err(|e| e.to_string())?;
    workspaces::ensure_workspace_dir(&home, &rec.id, &rec.name, &rec.folders, &rec.memory)
        .map_err(|e| e.to_string())?;
    Ok(rec)
}

#[tauri::command]
fn workspaces_update(
    app: AppHandle,
    store: State<'_, Store>,
    id: String,
    name: String,
    folders: Vec<String>,
    memory: String,
) -> Result<WorkspaceRecord, String> {
    let home = home_dir(&app)?;
    let folders = workspaces::dedupe_folders(folders);
    if folders.is_empty() {
        return Err("at least one folder is required".into());
    }
    let existing = store
        .workspaces_get(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "workspace not found".to_string())?;
    let rec = WorkspaceRecord {
        id: id.clone(),
        name: name.trim().to_string(),
        folders,
        memory,
        cwd: workspaces::workspace_dir(&home, &id)
            .to_string_lossy()
            .into_owned(),
        created_at: existing.created_at,
    };
    let row = workspaces::record_to_row(&rec).map_err(|e| e.to_string())?;
    store.workspaces_upsert(&row).map_err(|e| e.to_string())?;
    workspaces::ensure_workspace_dir(&home, &rec.id, &rec.name, &rec.folders, &rec.memory)
        .map_err(|e| e.to_string())?;
    Ok(rec)
}

#[tauri::command]
fn workspaces_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.workspaces_delete(&id).map_err(|e| e.to_string())
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
        .manage(PtySupervisor::new())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            let store = Store::open(data_dir.join("cosmos.sqlite"))?;
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
            agents_list,
            agents_upsert,
            agents_delete,
            debug_log,
            fs_read_dir,
            fs_read_file,
            fs_write_file,
            fs_walk,
            fs_grep,
            fs_detect_stack,
            fs_claude_md,
            fs_save_temp_image,
            git_diff,
            workspaces_list,
            workspaces_create,
            workspaces_update,
            workspaces_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
