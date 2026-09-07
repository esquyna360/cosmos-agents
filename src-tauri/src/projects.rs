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
    /// Stable Claude Code session UUID. Pinned with `--session-id` on the
    /// first spawn, replayed with `--resume` on every spawn after that, so
    /// closing Cosmos no longer throws the conversation away.
    #[serde(default)]
    pub session_id: String,
}

pub fn projects_root(home: &Path) -> PathBuf {
    home.join(".cosmos").join("projects")
}

pub fn project_dir(home: &Path, slug: &str) -> PathBuf {
    projects_root(home).join(slug)
}

/// Where a project's memory cards live on disk. Always under the project's
/// slug dir, regardless of folder count.
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

// Canonical defaults for an agent runner. Kept here (not in lib.rs) so the
// frontend can read them via a tauri command in later steps without locking
// into a preset model. Per-OS so the same defaults boot a usable agent /
// shell on macOS, Linux, and Windows out of the box.
#[cfg(unix)]
pub const DEFAULT_AGENT_PROGRAM: &str = "/bin/zsh";
#[cfg(unix)]
pub const DEFAULT_AGENT_ARGS: &[&str] = &[
    "-i",
    "-l",
    "-c",
    "exec env CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions",
];
#[cfg(unix)]
pub const DEFAULT_SHELL_PROGRAM: &str = "/bin/zsh";
#[cfg(unix)]
pub const DEFAULT_SHELL_ARGS: &[&str] = &["-i", "-l"];

// Windows: powershell.exe (Windows PowerShell 5.1) is guaranteed to exist
// on every Win10/11. Users can opt into pwsh (PS 7+) by editing the runner.
// Args mirror the Unix shape: a one-liner that sets env + execs claude.
#[cfg(windows)]
pub const DEFAULT_AGENT_PROGRAM: &str = "powershell.exe";
#[cfg(windows)]
pub const DEFAULT_AGENT_ARGS: &[&str] = &[
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "$env:CLAUDE_CODE_NO_FLICKER='1'; claude --dangerously-skip-permissions",
];
#[cfg(windows)]
pub const DEFAULT_SHELL_PROGRAM: &str = "powershell.exe";
#[cfg(windows)]
pub const DEFAULT_SHELL_ARGS: &[&str] = &["-NoLogo"];

/// Cwd for a project's agent runner. Always the materialized slug dir under
/// `~/.cosmos/projects/<slug>/` — Claude reads the generated CLAUDE.md there,
/// which @-includes each folder's own CLAUDE.md and folds in pinned cards.
pub fn compute_project_cwd(home: &Path, slug: &str, _folders: &[String]) -> PathBuf {
    project_dir(home, slug)
}

/// Materializes the on-disk dir + `.claude/CLAUDE.md`. Idempotent. Pinned
/// memory cards are folded into the generated CLAUDE.md so Claude reads them
/// on every turn.
pub fn ensure_project_dir(
    home: &Path,
    slug: &str,
    name: &str,
    folders: &[String],
    memory_text: &str,
) -> Result<PathBuf> {
    let dir = project_dir(home, slug);
    let claude_dir = dir.join(".claude");
    std::fs::create_dir_all(&claude_dir).context("creating project .claude dir")?;
    let claude_md = claude_dir.join("CLAUDE.md");
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

/// Re-render the generated CLAUDE.md for a project. Called after memory
/// mutations so pinned-card edits flow through without waiting for a
/// project_update.
pub fn refresh_claude_md(
    home: &Path,
    slug: &str,
    name: &str,
    folders: &[String],
    memory_text: &str,
) -> Result<()> {
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

    // Self-reference channel: tell the spawned agent that it can register
    // siblings / new projects in the live Cosmos app by shelling out to the
    // `cosmos` CLI (which the PTY spawner already put on $PATH and pointed
    // at the running socket).
    out.push_str("\n## Cosmos commands\n\n");
    out.push_str(
        "You are running inside Cosmos. To spawn another agent or create a \
new project from this session, use the `cosmos` CLI (already on PATH):\n\n",
    );
    out.push_str("```sh\n");
    out.push_str("# New sibling agent in this project (auto-starts):\n");
    out.push_str("cosmos runner add --project . --name \"<name>\"\n\n");
    out.push_str("# New project, optionally with an agent inside:\n");
    out.push_str(
        "cosmos project add --name \"<name>\" --folder /abs/path [--folder ...] \\\n  --with-agent \"<agent-name>\"\n\n",
    );
    out.push_str("# Read-only listing:\n");
    out.push_str("cosmos project list\n");
    out.push_str("cosmos runner list --project .\n");
    out.push_str("```\n\n");
    out.push_str(
        "`--project .` resolves to this project via `$COSMOS_PROJECT_SLUG`. \
The new agent appears in the sidebar but does **not** steal focus.\n",
    );

    // For each folder that already has its own CLAUDE.md, @-include it so the
    // repo's existing context isn't silently dropped just because the agent's
    // cwd is the synthetic dir. Checks both `.claude/CLAUDE.md` and the
    // top-level `CLAUDE.md` (same precedence as fs_ops::read_claude_md).
    let inherited: Vec<String> = folders
        .iter()
        .filter_map(|f| {
            let root = Path::new(f);
            for candidate in [".claude/CLAUDE.md", "CLAUDE.md"] {
                let p = root.join(candidate);
                if std::fs::metadata(&p).is_ok() {
                    return Some(p.to_string_lossy().into_owned());
                }
            }
            None
        })
        .collect();
    if !inherited.is_empty() {
        out.push_str("\n## Inherited memory\n\n");
        for p in &inherited {
            out.push_str(&format!("@{p}\n"));
        }
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
        session_id: row.session_id,
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
        session_id: rec.session_id.clone(),
    })
}

pub fn list(store: &Store) -> Result<Vec<ProjectRecord>> {
    store
        .projects_list()?
        .into_iter()
        .map(row_to_record)
        .collect()
}

/// Boot-time migration that brings every project into the unified shape:
/// `cwd = ~/.cosmos/projects/<slug>/` and a materialized `.claude/CLAUDE.md`
/// in that dir. Idempotent — re-running is cheap. Single-folder projects
/// created before this change had `cwd = folders[0]`; we rewrite the row.
pub fn migrate_to_synthetic_cwd(store: &Store, home: &Path) -> Result<()> {
    for rec in list(store)? {
        let expected_cwd = project_dir(home, &rec.slug)
            .to_string_lossy()
            .into_owned();
        if rec.cwd != expected_cwd {
            let mut updated = rec.clone();
            updated.cwd = expected_cwd;
            let row = record_to_row(&updated)?;
            store.projects_upsert(&row)?;
        }
        ensure_project_dir(home, &rec.slug, &rec.name, &rec.folders, &rec.memory)?;
    }
    Ok(())
}

pub fn runners_list(store: &Store) -> Result<Vec<RunnerRecord>> {
    store
        .runners_list()?
        .into_iter()
        .map(runner_row_to_record)
        .collect()
}

/// Orchestrates a project creation end-to-end: validates input, generates the
/// slug, writes the row, materializes the on-disk dir. Returns the new record.
/// Both the Tauri command and the IPC server call this so the two surfaces
/// can't drift.
pub fn create_project(
    home: &Path,
    store: &Store,
    name: String,
    folders: Vec<String>,
    memory: String,
    new_id: String,
    created_at: i64,
) -> Result<ProjectRecord> {
    let folders = dedupe_folders(folders);
    if folders.is_empty() {
        anyhow::bail!("at least one folder is required");
    }
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        anyhow::bail!("name is required");
    }
    if name_exists(store, &trimmed, None)? {
        anyhow::bail!("a project named \"{trimmed}\" already exists");
    }
    let slug = dedupe_slug(store, &slugify(&trimmed))?;
    let cwd = compute_project_cwd(home, &slug, &folders)
        .to_string_lossy()
        .into_owned();
    let rec = ProjectRecord {
        id: new_id,
        name: trimmed,
        slug,
        folders,
        memory,
        cwd,
        created_at,
    };
    let row = record_to_row(&rec)?;
    store.projects_upsert(&row)?;
    ensure_project_dir(home, &rec.slug, &rec.name, &rec.folders, &rec.memory)?;

    // Pre-approve Claude Code's trust dialog for every path the spawned agent
    // might land on: each working folder + the synthetic project cwd. Without
    // this, a remote flow (Telegram, etc.) hits an interactive modal that the
    // user can't click. Best-effort — failure is logged, not fatal.
    let mut trust_paths: Vec<String> = rec.folders.clone();
    trust_paths.push(rec.cwd.clone());
    if let Err(e) = mark_paths_trusted_in_claude_json(home, &trust_paths) {
        eprintln!("cosmos: failed to pre-approve Claude trust dialog: {e}");
    }

    Ok(rec)
}

/// Builds an in-memory runner record with the canonical defaults for `kind`,
/// The exec fragment every Claude preset ends with. Everything Cosmos appends
/// after it (`--name`, `--session-id`, `--resume`) is injected at spawn time
/// and never persisted, so a rename or a resume needs no row rewrite.
const CLAUDE_NEEDLE: &str = "claude --dangerously-skip-permissions";

fn shell_quote(v: &str) -> String {
    #[cfg(unix)]
    {
        format!("'{}'", v.replace('\'', "'\\''"))
    }
    #[cfg(windows)]
    {
        format!("'{}'", v.replace('\'', "''"))
    }
}

/// Drops anything Cosmos previously appended to a claude exec line. Rows
/// written by releases <= 0.1.5 persisted `--name '<runner>'`; we cut back to
/// the canonical fragment so the spawn-time injector is the single source of
/// truth. Non-claude commands (codex, shells, scripts) pass through untouched.
fn strip_injected_flags(arg: &str) -> String {
    match arg.find(CLAUDE_NEEDLE) {
        None => arg.to_string(),
        Some(i) => arg[..i + CLAUDE_NEEDLE.len()].to_string(),
    }
}

/// Path encoding Claude Code uses for `~/.claude/projects/<encoded>/`: every
/// non-alphanumeric byte becomes `-`. `/Users/bruno/.cosmos/projects/code`
/// becomes `-Users-bruno--cosmos-projects-code`.
fn encode_claude_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// True when Claude has already written a transcript for `session_id` *under
/// this cwd*, which is what makes `--resume` valid. Deliberately not a
/// filesystem-wide search: Claude resolves `--resume` against the working
/// directory, so a transcript found elsewhere would make the flag fail and
/// take the PTY down with it. A miss degrades to a fresh `--session-id`,
/// which is the safe direction.
pub fn claude_session_exists(home: &Path, cwd: &str, session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    home.join(".claude")
        .join("projects")
        .join(encode_claude_project_dir(cwd))
        .join(format!("{session_id}.jsonl"))
        .exists()
}

/// Builds the args a PTY actually launches with. Persisted args stay generic;
/// the runner's display name and its session handle are folded in here.
/// `resume` picks `--resume` (transcript exists) over `--session-id` (first
/// boot, pins the id Claude will write under).
pub fn build_spawn_args(
    args: &[String],
    name: &str,
    session_id: &str,
    resume: bool,
) -> Vec<String> {
    args.iter()
        .map(|a| {
            if !a.contains(CLAUDE_NEEDLE) {
                return a.clone();
            }
            let mut line = strip_injected_flags(a);
            line.push_str(" --name ");
            line.push_str(&shell_quote(name));
            if !session_id.is_empty() {
                line.push_str(if resume { " --resume " } else { " --session-id " });
                line.push_str(session_id);
            }
            line
        })
        .collect()
}

/// True when this runner's command is a Claude preset — the only CLI whose
/// session flags we know how to drive.
pub fn is_claude_command(args: &[String]) -> bool {
    args.iter().any(|a| a.contains(CLAUDE_NEEDLE))
}

/// The one place that turns a persisted runner into a launchable command
/// line. Every spawn path (tauri command, IPC server, master boot) goes
/// through it, so none of them can drift on session handling.
pub fn spawn_args_for(home: &Path, rec: &RunnerRecord, cwd: &str) -> Vec<String> {
    if rec.kind != "agent" {
        return rec.args.clone();
    }
    let resume = claude_session_exists(home, cwd, &rec.session_id);
    build_spawn_args(&rec.args, &rec.name, &rec.session_id, resume)
}

/// without persisting or spawning. Caller is responsible for upsert + PTY
/// spawn. Pulled out so the IPC server and tauri commands share defaulting.
pub fn build_runner_record(
    new_id: String,
    project_id: String,
    kind: String,
    name: String,
    program: Option<String>,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    created_at: i64,
) -> RunnerRecord {
    let kind_clean = if kind == "shell" { "shell" } else { "agent" }.to_string();
    let (default_program, default_args): (&str, &[&str]) = if kind_clean == "shell" {
        (DEFAULT_SHELL_PROGRAM, DEFAULT_SHELL_ARGS)
    } else {
        (DEFAULT_AGENT_PROGRAM, DEFAULT_AGENT_ARGS)
    };
    let program = program.unwrap_or_else(|| default_program.to_string());
    let args: Vec<String> =
        args.unwrap_or_else(|| default_args.iter().map(|s| s.to_string()).collect());
    let with_status_fsm = kind_clean == "agent";
    // Claude agents get their session handle at birth so the very first spawn
    // can pin it with `--session-id`. Without that, Claude picks a random id
    // we'd have no way to resume later.
    let session_id = if kind_clean == "agent" && is_claude_command(&args) {
        session_uuid()
    } else {
        String::new()
    };
    RunnerRecord {
        id: new_id,
        project_id,
        kind: kind_clean,
        name,
        program,
        args,
        env: env.unwrap_or_default(),
        with_status_fsm,
        created_at,
        last_active: created_at,
        session_id,
    }
}

/// UUID v4 for a Claude session handle. Same generator the rest of the crate
/// uses; re-exported here so `build_runner_record` stays callable from both
/// the tauri commands and the IPC server.
fn session_uuid() -> String {
    crate::uuid_v4_for_ipc()
}

/// Pre-approve the "Do you trust the files in this folder?" dialog for Claude
/// Code by writing `hasTrustDialogAccepted=true` into `~/.claude.json` for each
/// path. Best-effort: if `~/.claude.json` is missing or unparseable we just
/// return — the user can still accept manually. The point is to unblock remote
/// flows (e.g. Telegram) where the modal sits on a freshly-spawned agent that
/// the user can't see or click.
pub fn mark_paths_trusted_in_claude_json(home: &Path, paths: &[String]) -> Result<()> {
    let cfg = home.join(".claude.json");
    if !cfg.exists() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&cfg).context("reading ~/.claude.json")?;
    let mut json: serde_json::Value =
        serde_json::from_str(&raw).context("parsing ~/.claude.json")?;
    let Some(projects) = json
        .as_object_mut()
        .and_then(|o| o.get_mut("projects"))
        .and_then(|p| p.as_object_mut())
    else {
        return Ok(());
    };
    let mut changed = false;
    for key in paths {
        let entry = projects
            .entry(key.clone())
            .or_insert_with(|| serde_json::json!({}));
        let Some(obj) = entry.as_object_mut() else {
            continue;
        };
        let already = obj
            .get("hasTrustDialogAccepted")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !already {
            obj.insert(
                "hasTrustDialogAccepted".into(),
                serde_json::Value::Bool(true),
            );
            changed = true;
        }
    }
    if changed {
        let tmp = cfg.with_extension("json.cosmos-tmp");
        let pretty = serde_json::to_string_pretty(&json).context("encoding ~/.claude.json")?;
        std::fs::write(&tmp, pretty).context("writing tmp ~/.claude.json")?;
        std::fs::rename(&tmp, &cfg).context("renaming tmp ~/.claude.json")?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE_LINE: &str = "exec env CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions";

    #[test]
    fn first_spawn_pins_the_session_id() {
        let args = vec!["-i".into(), "-l".into(), "-c".into(), CLAUDE_LINE.into()];
        let out = build_spawn_args(&args, "main", "abc-123", false);
        assert_eq!(out[3], format!("{CLAUDE_LINE} --name 'main' --session-id abc-123"));
    }

    #[test]
    fn later_spawns_resume_that_session() {
        let args = vec!["-c".into(), CLAUDE_LINE.into()];
        let out = build_spawn_args(&args, "main", "abc-123", true);
        assert_eq!(out[1], format!("{CLAUDE_LINE} --name 'main' --resume abc-123"));
    }

    /// Rows written before 0.1.6 persisted an injected `--name`. Injection has
    /// to be idempotent or every respawn would stack another flag on.
    #[test]
    fn legacy_injected_name_is_stripped_not_stacked() {
        let legacy = format!("{CLAUDE_LINE} --name 'old'");
        let out = build_spawn_args(&[legacy], "novo", "s1", false);
        assert_eq!(out[0], format!("{CLAUDE_LINE} --name 'novo' --session-id s1"));
        let twice = build_spawn_args(&out, "novo", "s1", false);
        assert_eq!(twice, out);
    }

    #[test]
    fn non_claude_commands_pass_through() {
        let args = vec!["-i".into(), "-l".into(), "-c".into(), "exec pnpm dev".into()];
        assert_eq!(build_spawn_args(&args, "dev", "s1", true), args);
        assert!(!is_claude_command(&args));
    }

    /// Must match what Claude Code actually names the dir, or `--resume` never
    /// fires and every restart silently starts a new conversation.
    #[test]
    fn project_dir_encoding_matches_claude() {
        assert_eq!(
            encode_claude_project_dir("/Users/bruno/.cosmos/projects/code"),
            "-Users-bruno--cosmos-projects-code"
        );
        assert_eq!(
            encode_claude_project_dir("/Users/bruno/code/metamorfosis_flutter"),
            "-Users-bruno-code-metamorfosis-flutter"
        );
    }

    #[test]
    fn shells_get_no_session_handle() {
        let rec = build_runner_record(
            "r1".into(),
            "p1".into(),
            "shell".into(),
            "dev".into(),
            None,
            None,
            None,
            0,
        );
        assert!(rec.session_id.is_empty());
        let agent = build_runner_record(
            "r2".into(),
            "p1".into(),
            "agent".into(),
            "main".into(),
            None,
            None,
            None,
            0,
        );
        assert!(!agent.session_id.is_empty());
    }
}
