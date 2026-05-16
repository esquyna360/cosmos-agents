use std::collections::HashSet;
use std::process::Command;

use serde::Serialize;

/// What the frontend sees about an AI CLI preset.
#[derive(Serialize, Clone, Debug)]
pub struct CliInfo {
    /// Stable id used in URLs / persisted state (`claude`, `codex`).
    pub id: String,
    /// Display name shown in the agent picker.
    pub name: String,
    /// Short hint shown next to the name (e.g. the actual binary command).
    pub hint: String,
    /// `pty_spawn` `program` field — the shell that hosts the CLI so $PATH
    /// init runs before the CLI is exec'd. zsh on Unix, powershell on Win.
    pub program: String,
    /// `pty_spawn` `args` field. Shape matches `program`: zsh runs `-i -l -c
    /// exec …`; powershell runs `-NoLogo -NoProfile -Command …`.
    pub args: Vec<String>,
    /// True iff the underlying binary was found in PATH at detection time.
    pub available: bool,
}

// Each preset carries both Unix and Windows variants of its exec line; the
// `cfg`-gated code in `detect` reads only the one for the current target,
// hence the `dead_code` allow on the per-target unused field.
#[allow(dead_code)]
struct Preset {
    id: &'static str,
    name: &'static str,
    binary: &'static str,
    /// What goes inside `exec …` on Unix / `-Command …` on Windows — must
    /// already be safe shell (no untrusted interpolation since the presets
    /// are hard-coded).
    exec_unix: &'static str,
    exec_windows: &'static str,
}

const PRESETS: &[Preset] = &[
    Preset {
        id: "claude",
        name: "Claude Code",
        binary: "claude",
        exec_unix: "env CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions",
        exec_windows: "$env:CLAUDE_CODE_NO_FLICKER='1'; claude --dangerously-skip-permissions",
    },
    Preset {
        id: "codex",
        name: "Codex",
        binary: "codex",
        exec_unix: "codex",
        exec_windows: "codex",
    },
];

/// Probes whether each preset's binary is on $PATH. On Unix we shell out to a
/// real login+interactive zsh so $PATH matches what the user actually sees in
/// their terminal (not the bare PATH macOS hands a .app launched from
/// Finder). On Windows we use `where.exe`, which queries the same PATH the
/// shell would. One subprocess per platform path covers all presets.
fn probe_available() -> HashSet<String> {
    if PRESETS.is_empty() {
        return HashSet::new();
    }
    #[cfg(unix)]
    {
        let probe: String = PRESETS
            .iter()
            .map(|p| format!("command -v {bin} >/dev/null 2>&1 && echo {bin}", bin = p.binary))
            .collect::<Vec<_>>()
            .join("; ");
        let out = Command::new("/bin/zsh")
            .args(["-i", "-l", "-c", &probe])
            .output();
        match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            Err(e) => {
                eprintln!("[clis] probe failed: {e}");
                HashSet::new()
            }
        }
    }
    #[cfg(windows)]
    {
        let mut found = HashSet::new();
        for p in PRESETS {
            // `where.exe` exits 0 when it found at least one match. We don't
            // care about the path itself — only presence.
            let out = Command::new("where.exe").arg(p.binary).output();
            match out {
                Ok(o) if o.status.success() => {
                    found.insert(p.binary.to_string());
                }
                Ok(_) => {}
                Err(e) => eprintln!("[clis] where.exe probe for {} failed: {e}", p.binary),
            }
        }
        found
    }
}

pub fn detect() -> Vec<CliInfo> {
    let available = probe_available();
    PRESETS
        .iter()
        .map(|p| {
            #[cfg(unix)]
            let (program, args) = (
                "/bin/zsh".to_string(),
                vec![
                    "-i".to_string(),
                    "-l".to_string(),
                    "-c".to_string(),
                    format!("exec {}", p.exec_unix),
                ],
            );
            #[cfg(windows)]
            let (program, args) = (
                "powershell.exe".to_string(),
                vec![
                    "-NoLogo".to_string(),
                    "-NoProfile".to_string(),
                    "-Command".to_string(),
                    p.exec_windows.to_string(),
                ],
            );
            CliInfo {
                id: p.id.to_string(),
                name: p.name.to_string(),
                hint: p.binary.to_string(),
                program,
                args,
                available: available.contains(p.binary),
            }
        })
        .collect()
}

/// Look up a preset by id, used when the frontend asks to spawn a specific
/// CLI without echoing back the full program/args. Returns None for an
/// unknown id.
pub fn preset_by_id(id: &str) -> Option<CliInfo> {
    detect().into_iter().find(|c| c.id == id)
}
