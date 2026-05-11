use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::store::{Store, WorkspaceRow};

/// What the frontend sees. We translate to/from the SQLite row (which stores
/// folders as a JSON string) at the boundary so the JS side gets a real array.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub folders: Vec<String>,
    pub memory: String,
    pub cwd: String,
    pub created_at: i64,
}

pub fn workspaces_root(home: &Path) -> PathBuf {
    home.join(".cosmos").join("workspaces")
}

pub fn workspace_dir(home: &Path, id: &str) -> PathBuf {
    workspaces_root(home).join(id)
}

/// Materializes the on-disk dir for a workspace (idempotent) and writes the
/// generated `.claude/CLAUDE.md` so a spawned Claude reads the workspace
/// layout on startup. Returns the workspace cwd.
pub fn ensure_workspace_dir(
    home: &Path,
    id: &str,
    name: &str,
    folders: &[String],
    memory: &str,
) -> Result<PathBuf> {
    let dir = workspace_dir(home, id);
    let claude_dir = dir.join(".claude");
    std::fs::create_dir_all(&claude_dir).context("creating workspace .claude dir")?;
    let claude_md = claude_dir.join("CLAUDE.md");
    std::fs::write(&claude_md, render_claude_md(name, folders, memory))
        .context("writing workspace CLAUDE.md")?;
    Ok(dir)
}

fn render_claude_md(name: &str, folders: &[String], memory: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Workspace: {name}\n\n"));
    out.push_str(
        "This Cosmos workspace bundles the following working folders. \
Always use absolute paths when reading or editing files inside them.\n\n",
    );
    out.push_str("## Working folders\n\n");
    for f in folders {
        out.push_str(&format!("- {f}\n"));
    }
    out.push_str("\n## Memory\n\n");
    if memory.trim().is_empty() {
        out.push_str("_(none yet)_\n");
    } else {
        out.push_str(memory.trim_end());
        out.push('\n');
    }
    out
}

pub fn row_to_record(row: WorkspaceRow, home: &Path) -> Result<WorkspaceRecord> {
    let folders: Vec<String> =
        serde_json::from_str(&row.folders_json).context("decoding workspace folders json")?;
    let cwd = workspace_dir(home, &row.id).to_string_lossy().into_owned();
    Ok(WorkspaceRecord {
        id: row.id,
        name: row.name,
        folders,
        memory: row.memory,
        cwd,
        created_at: row.created_at,
    })
}

pub fn record_to_row(rec: &WorkspaceRecord) -> Result<WorkspaceRow> {
    let folders_json = serde_json::to_string(&rec.folders).context("encoding workspace folders")?;
    Ok(WorkspaceRow {
        id: rec.id.clone(),
        name: rec.name.clone(),
        folders_json,
        memory: rec.memory.clone(),
        created_at: rec.created_at,
    })
}

pub fn list(store: &Store, home: &Path) -> Result<Vec<WorkspaceRecord>> {
    store
        .workspaces_list()?
        .into_iter()
        .map(|r| row_to_record(r, home))
        .collect()
}

pub fn dedupe_folders(folders: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    folders
        .into_iter()
        .filter_map(|f| {
            let canon = f.trim_end_matches('/').to_string();
            if canon.is_empty() || !seen.insert(canon.clone()) {
                None
            } else {
                Some(canon)
            }
        })
        .collect()
}
