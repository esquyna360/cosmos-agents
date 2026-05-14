use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::memory;
use crate::store::{ProjectRow, RunnerRow, Store};

/// Hard cap on how many pinned cards we inline into the generated
/// `.claude/CLAUDE.md`. Beyond this, we drop the rest and add a pointer
/// to the memories dir.
const MAX_PINNED_IN_CLAUDE_MD: usize = 10;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub folders: Vec<String>,
    pub memory: String,
    pub cwd: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RunnerRecord {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
    pub with_status_fsm: bool,
    pub created_at: i64,
    pub last_active: i64,
}

pub fn projects_root(home: &Path) -> PathBuf {
    home.join(".cosmos").join("projects")
}

pub fn project_dir(home: &Path, slug: &str) -> PathBuf {
    projects_root(home).join(slug)
}

/// Where a project's memory cards live on disk. Always under the project's
/// slug dir, regardless of folder count — single-folder projects use this dir
/// lazily (created when the first card is saved) without affecting their
/// agent cwd (which stays at `folders[0]`).
#[allow(dead_code)] // wired up in Step 4 (memory.rs)
pub fn memories_dir(home: &Path, slug: &str) -> PathBuf {
    project_dir(home, slug).join("memories")
}

/// Slugify a project name into a filesystem-safe handle. ASCII-only,
/// lowercase, kebab-case, capped at 40 chars. Returns "project" if the input
/// has no slug-able chars (so we never produce an empty dir name).
pub fn slugify(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    let mut result = String::new();
    let mut last_was_dash = false;
    for c in lower.chars() {
        if c.is_ascii_alphanumeric() {
            result.push(c);
            last_was_dash = false;
        } else if !result.is_empty() && !last_was_dash {
            result.push('-');
            last_was_dash = true;
        }
    }
    while result.ends_with('-') {
        result.pop();
    }
    if result.is_empty() {
        result = "project".to_string();
    }
    if result.len() > 40 {
        result.truncate(40);
        while result.ends_with('-') {
            result.pop();
        }
    }
    result
}

/// Returns a slug not in use yet. If `candidate` collides with an existing
/// project's slug, tries `candidate-2`, `candidate-3`, etc.
pub fn dedupe_slug(store: &Store, candidate: &str) -> Result<String> {
    let mut slug = candidate.to_string();
    let mut n = 2u32;
    loop {
        let hit = store.projects_get_by_slug(&slug)?;
        if hit.is_none() {
            return Ok(slug);
        }
        slug = format!("{}-{}", candidate, n);
        n += 1;
        if n > 999 {
            anyhow::bail!("too many slug collisions for `{}`", candidate);
        }
    }
}

/// Case-insensitive name uniqueness check. Returns true if another project
/// (excluding `exclude_id`) already uses this name.
pub fn name_exists(store: &Store, name: &str, exclude_id: Option<&str>) -> Result<bool> {
    let normalized = name.trim().to_lowercase();
    let all = store.projects_list()?;
    for p in all {
        if Some(p.id.as_str()) == exclude_id {
            continue;
        }
        if p.name.trim().to_lowercase() == normalized {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Canonical defaults for an agent runner. Kept here (not in lib.rs) so the
/// frontend can read them via a tauri command in later steps without locking
/// into a preset model.
pub const DEFAULT_AGENT_PROGRAM: &str = "/bin/zsh";
pub const DEFAULT_AGENT_ARGS: &[&str] = &[
    "-i",
    "-l",
    "-c",
    "exec env CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions",
];

pub const DEFAULT_SHELL_PROGRAM: &str = "/bin/zsh";
pub const DEFAULT_SHELL_ARGS: &[&str] = &["-i", "-l"];

/// Computes the cwd for a project. Single-folder projects use the folder
/// directly (no synthetic dir, no generated CLAUDE.md — Claude reads the
/// repo's own one). Multi-folder projects use a materialized slug dir.
pub fn compute_project_cwd(home: &Path, slug: &str, folders: &[String]) -> PathBuf {
    if folders.len() <= 1 {
        // We trust the caller to have ensured folders[0] exists.
        PathBuf::from(folders.first().cloned().unwrap_or_default())
    } else {
        project_dir(home, slug)
    }
}

/// Materializes the on-disk dir + `.claude/CLAUDE.md` only when there's more
/// than one folder. Single-folder projects are pass-through. Idempotent.
pub fn ensure_project_dir(
    home: &Path,
    slug: &str,
    name: &str,
    folders: &[String],
    memory_text: &str,
) -> Result<PathBuf> {
    if folders.len() <= 1 {
        return Ok(PathBuf::from(folders.first().cloned().unwrap_or_default()));
    }
    let dir = project_dir(home, slug);
    let claude_dir = dir.join(".claude");
    std::fs::create_dir_all(&claude_dir).context("creating project .claude dir")?;
    let claude_md = claude_dir.join("CLAUDE.md");
    // Pinned memory cards auto-flow into the generated CLAUDE.md so Claude
    // reads them on every turn. Single-folder projects skip this entire path,
    // so pinning a card there does nothing automatically — Bruno needs to
    // @-mention the file path in chat (documented in MemoryView's empty state).
    let pinned = memory::list_cards(home, slug)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.pinned)
        .collect::<Vec<_>>();
    std::fs::write(
        &claude_md,
        render_claude_md(name, folders, memory_text, &pinned, slug),
    )
    .context("writing project CLAUDE.md")?;
    Ok(dir)
}

/// Re-render the generated CLAUDE.md for a project. No-op for single-folder
/// projects (they don't have a synthetic dir). Called after memory mutations
/// so pinned-card edits flow through without waiting for a project_update.
pub fn refresh_claude_md(
    home: &Path,
    slug: &str,
    name: &str,
    folders: &[String],
    memory_text: &str,
) -> Result<()> {
    if folders.len() <= 1 {
        return Ok(());
    }
    ensure_project_dir(home, slug, name, folders, memory_text)?;
    Ok(())
}

fn render_claude_md(
    name: &str,
    folders: &[String],
    memory_text: &str,
    pinned_cards: &[memory::MemoryCard],
    slug: &str,
) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Project: {name}\n\n"));
    out.push_str(
        "This Cosmos project bundles the following working folders. \
Always use absolute paths when reading or editing files inside them.\n\n",
    );
    out.push_str("## Working folders\n\n");
    for f in folders {
        out.push_str(&format!("- {f}\n"));
    }
    out.push_str("\n## Memory\n\n");
    if memory_text.trim().is_empty() {
        out.push_str("_(none yet)_\n");
    } else {
        out.push_str(memory_text.trim_end());
        out.push('\n');
    }
    if !pinned_cards.is_empty() {
        out.push_str("\n## Pinned context\n\n");
        out.push_str(
            "Memory cards Bruno has explicitly pinned for this project. \
Treat as authoritative project-level context.\n\n",
        );
        let cap = pinned_cards.len().min(MAX_PINNED_IN_CLAUDE_MD);
        for card in pinned_cards.iter().take(cap) {
            out.push_str(&format!("### {} ({})\n\n", card.title, card.kind));
            if !card.tags.is_empty() {
                out.push_str(&format!(
                    "*tags: {}*\n\n",
                    card.tags
                        .iter()
                        .map(|t| format!("#{t}"))
                        .collect::<Vec<_>>()
                        .join(" ")
                ));
            }
            let body = card.body.trim();
            if !body.is_empty() {
                out.push_str(body);
                out.push_str("\n\n");
            }
        }
        if pinned_cards.len() > cap {
            out.push_str(&format!(
                "_(+ {} more pinned card(s) in `~/.cosmos/projects/{}/memories/`)_\n",
                pinned_cards.len() - cap,
                slug,
            ));
        }
    }
    out
}

pub fn row_to_record(row: ProjectRow) -> Result<ProjectRecord> {
    let folders: Vec<String> =
        serde_json::from_str(&row.folders_json).context("decoding project folders json")?;
    Ok(ProjectRecord {
        id: row.id,
        name: row.name,
        slug: row.slug,
        folders,
        memory: row.memory,
        cwd: row.cwd,
        created_at: row.created_at,
    })
}

pub fn record_to_row(rec: &ProjectRecord) -> Result<ProjectRow> {
    let folders_json =
        serde_json::to_string(&rec.folders).context("encoding project folders json")?;
    Ok(ProjectRow {
        id: rec.id.clone(),
        name: rec.name.clone(),
        slug: rec.slug.clone(),
        folders_json,
        memory: rec.memory.clone(),
        cwd: rec.cwd.clone(),
        created_at: rec.created_at,
    })
}

pub fn runner_row_to_record(row: RunnerRow) -> Result<RunnerRecord> {
    let args: Vec<String> =
        serde_json::from_str(&row.args_json).context("decoding runner args json")?;
    let env: std::collections::HashMap<String, String> = if row.env_json.trim().is_empty() {
        Default::default()
    } else {
        serde_json::from_str(&row.env_json).context("decoding runner env json")?
    };
    Ok(RunnerRecord {
        id: row.id,
        project_id: row.project_id,
        kind: row.kind,
        name: row.name,
        program: row.program,
        args,
        env,
        with_status_fsm: row.with_status_fsm,
        created_at: row.created_at,
        last_active: row.last_active,
    })
}

pub fn runner_record_to_row(rec: &RunnerRecord) -> Result<RunnerRow> {
    let args_json = serde_json::to_string(&rec.args).context("encoding runner args json")?;
    let env_json = serde_json::to_string(&rec.env).context("encoding runner env json")?;
    Ok(RunnerRow {
        id: rec.id.clone(),
        project_id: rec.project_id.clone(),
        kind: rec.kind.clone(),
        name: rec.name.clone(),
        program: rec.program.clone(),
        args_json,
        env_json,
        with_status_fsm: rec.with_status_fsm,
        created_at: rec.created_at,
        last_active: rec.last_active,
    })
}

pub fn list(store: &Store) -> Result<Vec<ProjectRecord>> {
    store
        .projects_list()?
        .into_iter()
        .map(row_to_record)
        .collect()
}

pub fn runners_list(store: &Store) -> Result<Vec<RunnerRecord>> {
    store
        .runners_list()?
        .into_iter()
        .map(runner_row_to_record)
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
