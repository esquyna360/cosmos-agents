//! Reading and annotating Claude Code's own session transcripts
//! (`~/.claude/projects/<encoded cwd>/<session>.jsonl`).
//!
//! Two jobs: rebuilding a conversation for the chat view when no process is
//! running, and keeping a session's title the same on both sides — Claude
//! stores it as `custom-title` / `ai-title` lines inside the transcript, and
//! the last occurrence wins.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

const TITLE_TAIL_BYTES: u64 = 256 * 1024;

pub fn transcript_path(home: &Path, cwd: &str, session_id: &str) -> PathBuf {
    let encoded: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    home.join(".claude")
        .join("projects")
        .join(encoded)
        .join(format!("{session_id}.jsonl"))
}

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTitle {
    /// Set by a person (`/rename`, `--name`, a host rename).
    pub custom: Option<String>,
    /// Written by Claude after the first prompt.
    pub ai: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleLine {
    #[serde(rename = "type")]
    kind: String,
    custom_title: Option<String>,
    ai_title: Option<String>,
}

fn titles_in(text: &str) -> SessionTitle {
    let mut out = SessionTitle::default();
    for line in text.lines().rev() {
        if out.custom.is_some() && out.ai.is_some() {
            break;
        }
        // Title lines are tiny; anything long is a message that merely
        // mentions one.
        if line.len() > 4096
            || !(line.contains("\"type\":\"custom-title\"")
                || line.contains("\"type\":\"ai-title\""))
        {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<TitleLine>(line) else {
            continue;
        };
        if parsed.kind == "custom-title" && out.custom.is_none() {
            out.custom = parsed.custom_title.filter(|t| !t.trim().is_empty());
        }
        if parsed.kind == "ai-title" && out.ai.is_none() {
            out.ai = parsed.ai_title.filter(|t| !t.trim().is_empty());
        }
    }
    out
}

/// Claude re-appends the title pair as the session grows, so the tail almost
/// always has it; the full scan only runs when it doesn't.
pub fn read_title(path: &Path) -> Result<SessionTitle> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TITLE_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail)?;
    let found = titles_in(&String::from_utf8_lossy(&tail));
    if found.custom.is_some() || start == 0 {
        return Ok(found);
    }
    let full = std::fs::read(path)?;
    let scanned = titles_in(&String::from_utf8_lossy(&full));
    Ok(SessionTitle {
        custom: scanned.custom,
        ai: found.ai.or(scanned.ai),
    })
}

/// Same two lines the CLI writes on a rename. Only safe while no process owns
/// the session — a live CLI re-appends the title it holds in memory.
pub fn append_title(path: &Path, session_id: &str, title: &str) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut file = std::fs::OpenOptions::new().append(true).open(path)?;
    let title = serde_json::to_string(title)?;
    let session = serde_json::to_string(session_id)?;
    writeln!(
        file,
        "{{\"type\":\"custom-title\",\"customTitle\":{title},\"sessionId\":{session}}}"
    )?;
    writeln!(
        file,
        "{{\"type\":\"agent-name\",\"agentName\":{title},\"sessionId\":{session}}}"
    )?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Head {
    #[serde(rename = "type")]
    kind: Option<String>,
    uuid: Option<String>,
    parent_uuid: Option<String>,
    leaf_uuid: Option<String>,
    #[serde(default)]
    is_sidechain: bool,
}

/// The conversation's `user` / `assistant` lines, oldest first, following the
/// active branch. A transcript is a tree (rewinds fork it) and its physical
/// order is not strictly chronological, so the walk goes up `parentUuid` from
/// the leaf named by the last `last-prompt` line.
pub fn read_history(path: &Path) -> Result<Vec<String>> {
    let text = std::fs::read_to_string(path)?;
    let mut parent_of: HashMap<String, Option<String>> = HashMap::new();
    let mut renderable: HashMap<String, &str> = HashMap::new();
    let mut in_file_order: Vec<&str> = Vec::new();
    let mut leaf: Option<String> = None;
    let mut last_uuid: Option<String> = None;

    for line in text.lines() {
        let Ok(head) = serde_json::from_str::<Head>(line) else {
            continue;
        };
        let kind = head.kind.as_deref().unwrap_or("");
        if kind == "last-prompt" {
            if head.leaf_uuid.is_some() {
                leaf = head.leaf_uuid;
            }
            continue;
        }
        let Some(uuid) = head.uuid else { continue };
        if head.is_sidechain {
            continue;
        }
        parent_of.insert(uuid.clone(), head.parent_uuid);
        if kind == "user" || kind == "assistant" {
            renderable.insert(uuid.clone(), line);
            in_file_order.push(line);
        }
        last_uuid = Some(uuid);
    }

    // Work done after the last recorded prompt hangs below that leaf, so the
    // newest line is the better starting point when it descends from it.
    let start = match (&leaf, &last_uuid) {
        (Some(l), Some(last)) if descends_from(&parent_of, last, l) => Some(last.clone()),
        (Some(l), _) => Some(l.clone()),
        (None, last) => last.clone(),
    };
    let Some(mut cursor) = start else {
        return Ok(Vec::new());
    };

    let mut chain: Vec<String> = Vec::new();
    let mut guard = 0usize;
    loop {
        if let Some(line) = renderable.get(&cursor) {
            chain.push((*line).to_string());
        }
        guard += 1;
        match parent_of.get(&cursor) {
            Some(Some(parent)) if guard < 2_000_000 => cursor = parent.clone(),
            _ => break,
        }
    }
    if chain.is_empty() {
        return Ok(in_file_order.into_iter().map(str::to_string).collect());
    }
    chain.reverse();
    Ok(chain)
}

fn descends_from(parent_of: &HashMap<String, Option<String>>, node: &str, ancestor: &str) -> bool {
    let mut cursor = node.to_string();
    for _ in 0..2_000_000 {
        if cursor == ancestor {
            return true;
        }
        match parent_of.get(&cursor) {
            Some(Some(p)) => cursor = p.clone(),
            _ => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_title_wins_and_custom_is_separate_from_ai() {
        let text = concat!(
            "{\"type\":\"custom-title\",\"customTitle\":\"old\",\"sessionId\":\"s\"}\n",
            "{\"type\":\"ai-title\",\"aiTitle\":\"written by claude\",\"sessionId\":\"s\"}\n",
            "{\"type\":\"custom-title\",\"customTitle\":\"new\",\"sessionId\":\"s\"}\n",
        );
        let t = titles_in(text);
        assert_eq!(t.custom.as_deref(), Some("new"));
        assert_eq!(t.ai.as_deref(), Some("written by claude"));
    }

    #[test]
    fn history_follows_the_active_branch() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!("cosmos-hist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"a\",\"parentUuid\":null,\"message\":{\"content\":\"first\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"b\",\"parentUuid\":\"a\",\"message\":{\"content\":[]}}\n",
                "{\"type\":\"user\",\"uuid\":\"dead\",\"parentUuid\":\"b\",\"message\":{\"content\":\"rewound\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"c\",\"parentUuid\":\"b\",\"message\":{\"content\":\"kept\"}}\n",
                "{\"type\":\"last-prompt\",\"leafUuid\":\"c\"}\n",
            ),
        )
        .unwrap();
        let lines = read_history(&path).unwrap();
        assert_eq!(lines.len(), 3);
        assert!(lines[2].contains("kept"));
        assert!(!lines.iter().any(|l| l.contains("rewound")));
        std::fs::remove_dir_all(&dir).ok();
    }
}
