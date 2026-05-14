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
    /// `pty_spawn` `program` field — always `/bin/zsh` so $PATH-aware shell
    /// init runs before the CLI is exec'd.
    pub program: String,
    /// `pty_spawn` `args` field. Always `["-i","-l","-c","exec …"]`.
    pub args: Vec<String>,
    /// True iff the underlying binary was found in PATH at detection time.
    pub available: bool,
}

struct Preset {
    id: &'static str,
    name: &'static str,
    binary: &'static str,
    /// What goes inside `exec …` — must already be safe shell (no untrusted
    /// interpolation since the presets are hard-coded).
    exec_line: &'static str,
}

const PRESETS: &[Preset] = &[
    Preset {
        id: "claude",
        name: "Claude Code",
        binary: "claude",
        exec_line: "env CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions",
    },
    Preset {
        id: "codex",
        name: "Codex",
        binary: "codex",
        exec_line: "codex",
    },
];

/// Probe `command -v <bin>` in a real login+interactive zsh so $PATH matches
/// what Bruno actually sees in his terminal (not the bare PATH macOS hands a
/// .app launched from Finder). Single subprocess covers all presets.
fn probe_available() -> HashSet<String> {
    if PRESETS.is_empty() {
        return HashSet::new();
    }
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

pub fn detect() -> Vec<CliInfo> {
    let available = probe_available();
    PRESETS
        .iter()
        .map(|p| {
            let args = vec![
                "-i".to_string(),
                "-l".to_string(),
                "-c".to_string(),
                format!("exec {}", p.exec_line),
            ];
            CliInfo {
                id: p.id.to_string(),
                name: p.name.to_string(),
                hint: p.binary.to_string(),
                program: "/bin/zsh".to_string(),
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
