//! Git worktrees for agents that should not share a checkout, plus the
//! read-only branch lookup the UI shows next to every runner.
//!
//! Worktrees live under `~/.cosmos/worktrees/<project slug>/<name>` — outside
//! the repo, so nothing has to be gitignored — on a `cosmos/<name>` branch.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;

use crate::projects::{self, ProjectRecord};

pub fn worktrees_root(home: &Path) -> PathBuf {
    home.join(".cosmos").join("worktrees")
}

/// True when `path` is a worktree Cosmos created, the only kind it removes.
pub fn is_managed(home: &Path, path: &str) -> bool {
    !path.is_empty() && Path::new(path).starts_with(worktrees_root(home))
}

fn git(repo: &str, args: &[&str]) -> Result<std::process::Output> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args(args);
    crate::no_console(&mut cmd);
    if let Some(path) = crate::pty_supervisor::path_with_cli_dir() {
        cmd.env("PATH", path);
    }
    cmd.output().context("running git")
}

fn branch_exists(repo: &str, branch: &str) -> bool {
    git(repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Creates a worktree of the project's first folder for `runner_name`.
/// Returns `(path, branch)`.
pub fn create(home: &Path, project: &ProjectRecord, runner_name: &str) -> Result<(String, String)> {
    let repo = project
        .folders
        .first()
        .ok_or_else(|| anyhow!("o projeto `{}` não tem pasta", project.name))?;
    if !info(repo).is_repo {
        bail!("`{repo}` não é um repositório git — worktree só funciona em repo git");
    }
    let base = projects::slugify(runner_name);
    let root = worktrees_root(home).join(&project.slug);
    std::fs::create_dir_all(&root).context("creating worktrees dir")?;

    let mut n = 1u32;
    let (path, branch) = loop {
        let suffix = if n == 1 { base.clone() } else { format!("{base}-{n}") };
        let path = root.join(&suffix);
        let branch = format!("cosmos/{suffix}");
        if !path.exists() && !branch_exists(repo, &branch) {
            break (path, branch);
        }
        n += 1;
    };
    let path_str = path.to_string_lossy().into_owned();
    let out = git(repo, &["worktree", "add", "-b", &branch, &path_str])?;
    if !out.status.success() {
        bail!(
            "git worktree add falhou: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let _ = projects::mark_paths_trusted_in_claude_json(home, &[path_str.clone()]);
    Ok((path_str, branch))
}

/// Removes a worktree without `--force`: git refuses when it holds
/// uncommitted work, which is the behaviour we want. The branch stays.
pub fn remove(repo: &str, path: &str) -> Result<()> {
    let out = git(repo, &["worktree", "remove", path])?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub path: String,
    pub is_repo: bool,
    pub branch: Option<String>,
    /// Linked worktrees of the repository this path belongs to.
    pub worktrees: u32,
}

/// Reads `.git` straight off the disk; no process, so it is cheap enough to
/// call for every runner on screen.
pub fn info(path: &str) -> GitInfo {
    let mut out = GitInfo {
        path: path.to_string(),
        ..Default::default()
    };
    let dot_git = Path::new(path).join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else if let Ok(text) = std::fs::read_to_string(&dot_git) {
        let Some(target) = text.lines().find_map(|l| l.strip_prefix("gitdir:")) else {
            return out;
        };
        let target = Path::new(target.trim());
        if target.is_absolute() {
            target.to_path_buf()
        } else {
            Path::new(path).join(target)
        }
    } else {
        return out;
    };
    let Ok(head) = std::fs::read_to_string(git_dir.join("HEAD")) else {
        return out;
    };
    out.is_repo = true;
    let head = head.trim();
    out.branch = Some(match head.strip_prefix("ref: refs/heads/") {
        Some(name) => name.to_string(),
        None => head.chars().take(7).collect(),
    });
    // A linked worktree's git dir points back at the shared one.
    let common = std::fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .map(|rel| {
            let rel = Path::new(rel.trim());
            if rel.is_absolute() {
                rel.to_path_buf()
            } else {
                git_dir.join(rel)
            }
        })
        .unwrap_or(git_dir);
    out.worktrees = std::fs::read_dir(common.join("worktrees"))
        .map(|d| d.flatten().filter(|e| e.path().is_dir()).count() as u32)
        .unwrap_or(0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_reads_repos_linked_worktrees_and_plain_dirs() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("cosmos-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let linked_git = repo.join(".git/worktrees/wt");
        std::fs::create_dir_all(&linked_git).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(linked_git.join("HEAD"), "ref: refs/heads/cosmos/fix\n").unwrap();
        std::fs::write(linked_git.join("commondir"), "../..\n").unwrap();
        let wt = root.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", linked_git.display())).unwrap();
        let plain = root.join("plain");
        std::fs::create_dir_all(&plain).unwrap();

        let main = info(&repo.to_string_lossy());
        assert!(main.is_repo);
        assert_eq!(main.branch.as_deref(), Some("main"));
        assert_eq!(main.worktrees, 1);

        let linked = info(&wt.to_string_lossy());
        assert_eq!(linked.branch.as_deref(), Some("cosmos/fix"));
        assert_eq!(linked.worktrees, 1);

        std::fs::write(repo.join(".git/HEAD"), "0123456789abcdef\n").unwrap();
        assert_eq!(info(&repo.to_string_lossy()).branch.as_deref(), Some("0123456"));

        assert!(!info(&plain.to_string_lossy()).is_repo);
        std::fs::remove_dir_all(&root).ok();
    }
}
