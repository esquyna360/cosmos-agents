use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize, Clone)]
pub struct GrepMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[derive(Serialize, Clone)]
pub struct StackInfo {
    pub label: String,
    pub color: String,
}

pub fn detect_stack(cwd: PathBuf) -> Vec<StackInfo> {
    let exists = |name: &str| cwd.join(name).exists();
    let mut out = Vec::new();
    if exists("package.json") {
        if exists("tsconfig.json") {
            out.push(stack("TS", "#3178c6"));
        } else {
            out.push(stack("JS", "#d4b619"));
        }
    }
    if exists("pubspec.yaml") {
        out.push(stack("Dart", "#0175c2"));
    }
    if exists("Cargo.toml") {
        out.push(stack("Rs", "#c97a4c"));
    }
    if exists("pyproject.toml") || exists("requirements.txt") || exists("setup.py") {
        out.push(stack("Py", "#3776ab"));
    }
    if exists("go.mod") {
        out.push(stack("Go", "#00add8"));
    }
    if exists("Gemfile") {
        out.push(stack("Rb", "#cc342d"));
    }
    if exists("mix.exs") {
        out.push(stack("Elixir", "#a37eb8"));
    }
    if exists("composer.json") {
        out.push(stack("PHP", "#777bb4"));
    }
    out
}

fn stack(label: &str, color: &str) -> StackInfo {
    StackInfo {
        label: label.into(),
        color: color.into(),
    }
}

pub fn read_claude_md(cwd: PathBuf) -> Option<String> {
    for c in [".claude/CLAUDE.md", "CLAUDE.md"] {
        if let Ok(content) = std::fs::read_to_string(cwd.join(c)) {
            return Some(content);
        }
    }
    None
}

/// Names we never want to descend into. Keeps tree responsive in big repos.
const IGNORED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "__pycache__",
    ".DS_Store",
];

pub fn read_dir(path: PathBuf) -> Result<Vec<DirEntry>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if IGNORED.iter().any(|n| *n == name) {
            continue;
        }
        let meta = entry.metadata()?;
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
        });
    }
    // Directories first, then files, both alphabetical.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

pub fn read_file(path: PathBuf) -> Result<String> {
    Ok(std::fs::read_to_string(path)?)
}

pub fn write_file(path: PathBuf, content: String) -> Result<()> {
    std::fs::write(path, content)?;
    Ok(())
}

const MAX_FILES: usize = 8000;
const MAX_GREP_MATCHES: usize = 500;
const GREP_LINE_TRUNC: usize = 240;

pub fn walk_files(root: PathBuf) -> Result<Vec<String>> {
    let mut out = Vec::new();
    walk(&root, &root, &mut out, MAX_FILES);
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>, cap: usize) {
    if out.len() >= cap {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= cap {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if IGNORED.iter().any(|n| *n == name) || name.starts_with('.') {
            // Skip hidden + ignored. Keep .env? For now skip — claude users
            // rarely browse those in a code finder. Re-add if asked.
            continue;
        }
        let p = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk(root, &p, out, cap);
        } else if let Ok(rel) = p.strip_prefix(root) {
            out.push(rel.to_string_lossy().into_owned());
        }
    }
}

pub fn grep(root: PathBuf, query: String) -> Result<Vec<GrepMatch>> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    walk(&root, &root, &mut files, MAX_FILES);
    let mut out = Vec::new();
    let q = query.as_str();
    'outer: for rel in &files {
        let path = root.join(rel);
        // Skip files that obviously aren't text-y, plus anything bigger than 2 MiB.
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > 2 * 1024 * 1024 {
                continue;
            }
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (i, line) in content.lines().enumerate() {
            if line.contains(q) {
                out.push(GrepMatch {
                    path: rel.clone(),
                    line: (i + 1) as u32,
                    text: truncate(line, GREP_LINE_TRUNC),
                });
                if out.len() >= MAX_GREP_MATCHES {
                    break 'outer;
                }
            }
        }
    }
    Ok(out)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}

#[derive(Serialize, Clone)]
pub struct ScriptsInfo {
    /// One of "pnpm" | "yarn" | "bun" | "npm". Detected from lockfile; falls
    /// back to npm when no lockfile is present.
    pub package_manager: String,
    /// (name, command) pairs from package.json's `scripts` block, preserving
    /// definition order. Empty if no package.json or no scripts.
    pub scripts: Vec<(String, String)>,
}

/// Detects the package manager + lists npm scripts for a single folder.
/// Returns an empty list (not an error) when no package.json is present, so
/// the frontend can call this for every folder of a project and merge.
pub fn read_package_scripts(folder: PathBuf) -> ScriptsInfo {
    let pkg_path = folder.join("package.json");
    let scripts: Vec<(String, String)> = std::fs::read_to_string(&pkg_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("scripts").cloned())
        .and_then(|v| v.as_object().cloned())
        .map(|map| {
            map.into_iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    // Lockfile-based package manager detection. Order matters: pnpm/yarn/bun
    // wins over npm even if package-lock.json is also present (the explicit
    // lockfile is the more honest signal).
    let pm = if folder.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if folder.join("yarn.lock").exists() {
        "yarn"
    } else if folder.join("bun.lockb").exists() || folder.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    };

    ScriptsInfo {
        package_manager: pm.to_string(),
        scripts,
    }
}
