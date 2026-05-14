use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::projects::memories_dir;

/// A single memory card. Lives on disk as one `.md` file per card with an
/// HTML-comment frontmatter on the first line:
///
/// ```markdown
/// <!-- cosmos-meta {"id":"abc12345","kind":"decision",...} -->
/// # Auth strategy
///
/// We picked JWT because…
/// ```
///
/// Title is the first `# ` line of the body — this way the file renders
/// beautifully in any external MD reader without Cosmos involvement.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MemoryCard {
    pub id: String,
    pub title: String,
    pub body: String,
    pub kind: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize)]
struct CardMeta {
    id: String,
    kind: String,
    tags: Vec<String>,
    pinned: bool,
    created_at: i64,
    updated_at: i64,
}

/// Extracts the title (first `# ` line) and returns (title, body-without-title).
fn split_title(body: &str) -> (String, String) {
    let mut lines = body.lines();
    let first = lines.next().unwrap_or("").trim();
    if let Some(rest) = first.strip_prefix("# ") {
        let body_rest: String = lines.collect::<Vec<_>>().join("\n");
        // Drop a single leading blank line so round-tripping doesn't grow.
        let body_rest = body_rest.strip_prefix('\n').unwrap_or(&body_rest).to_string();
        return (rest.trim().to_string(), body_rest);
    }
    // No title line — fall back to "untitled" so the UI has something to show.
    ("untitled".to_string(), body.to_string())
}

/// Parses a single `.md` file from disk into a MemoryCard. Tolerant of
/// missing/corrupt frontmatter — falls back to defaults so a stray file
/// doesn't break the list.
fn parse_card(path: &Path) -> Result<MemoryCard> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading card {path:?}"))?;
    let (meta, body) = if let Some(rest) = raw.strip_prefix("<!-- cosmos-meta ") {
        if let Some(end) = rest.find(" -->") {
            let json = &rest[..end];
            let meta: CardMeta = serde_json::from_str(json).unwrap_or_else(|_| CardMeta {
                id: filename_stem(path),
                kind: "note".to_string(),
                tags: vec![],
                pinned: false,
                created_at: 0,
                updated_at: 0,
            });
            // Skip past " -->" and the newline that follows it.
            let after = &rest[end + 4..];
            let body = after.strip_prefix('\n').unwrap_or(after).to_string();
            (meta, body)
        } else {
            // Has the prefix but no closing marker — treat whole file as body.
            (
                CardMeta {
                    id: filename_stem(path),
                    kind: "note".to_string(),
                    tags: vec![],
                    pinned: false,
                    created_at: 0,
                    updated_at: 0,
                },
                raw.clone(),
            )
        }
    } else {
        (
            CardMeta {
                id: filename_stem(path),
                kind: "note".to_string(),
                tags: vec![],
                pinned: false,
                created_at: 0,
                updated_at: 0,
            },
            raw.clone(),
        )
    };
    let (title, body_without_title) = split_title(&body);
    Ok(MemoryCard {
        id: meta.id,
        title,
        body: body_without_title,
        kind: meta.kind,
        tags: meta.tags,
        pinned: meta.pinned,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
    })
}

fn filename_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled")
        .to_string()
}

/// Serialize a card back to disk. Body keeps the user's edits verbatim;
/// title is re-emitted as the first `# ` line.
fn serialize_card(card: &MemoryCard) -> String {
    let meta = CardMeta {
        id: card.id.clone(),
        kind: card.kind.clone(),
        tags: card.tags.clone(),
        pinned: card.pinned,
        created_at: card.created_at,
        updated_at: card.updated_at,
    };
    let meta_json = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".to_string());
    let mut out = String::new();
    out.push_str("<!-- cosmos-meta ");
    out.push_str(&meta_json);
    out.push_str(" -->\n");
    out.push_str("# ");
    out.push_str(card.title.trim());
    out.push_str("\n\n");
    out.push_str(&card.body);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Filesystem-safe filename for a card. Uses the card's id (8-char short
/// uuid) so renaming the title doesn't move the file on disk.
fn card_filename(card: &MemoryCard) -> String {
    let slug = slugify_title(&card.title);
    let stem = if slug.is_empty() {
        card.id.clone()
    } else {
        format!("{}-{}", slug, short_id(&card.id))
    };
    format!("{stem}.md")
}

fn slugify_title(title: &str) -> String {
    let mut out = String::new();
    let mut last_was_dash = false;
    for c in title.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_was_dash = false;
        } else if !out.is_empty() && !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.len() > 30 {
        out.truncate(30);
        while out.ends_with('-') {
            out.pop();
        }
    }
    out
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// List all memory cards for a project. Returns an empty list (not an error)
/// if the memories dir doesn't exist yet. Sorted by `pinned` first then by
/// `updated_at` descending (recent at top within each section).
pub fn list_cards(home: &Path, slug: &str) -> Result<Vec<MemoryCard>> {
    let dir = memories_dir(home, slug);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut cards: Vec<MemoryCard> = vec![];
    for entry in std::fs::read_dir(&dir).with_context(|| format!("reading {dir:?}"))? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        match parse_card(&path) {
            Ok(card) => cards.push(card),
            Err(e) => eprintln!("[memory] failed to parse {path:?}: {e}"),
        }
    }
    cards.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
    Ok(cards)
}

/// Write a card to disk. Creates the memories dir lazily on first call.
/// Idempotent — re-saving the same id overwrites.
pub fn upsert_card(home: &Path, slug: &str, card: &MemoryCard) -> Result<()> {
    let dir = memories_dir(home, slug);
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {dir:?}"))?;
    let path = dir.join(card_filename(card));
    // If a previous file exists for this card.id (e.g. title changed and slug
    // shifted), find and remove the stale file so we don't end up with two.
    cleanup_stale(&dir, &card.id, &path)?;
    std::fs::write(&path, serialize_card(card))
        .with_context(|| format!("writing {path:?}"))?;
    Ok(())
}

fn cleanup_stale(dir: &Path, card_id: &str, keep: &Path) -> Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path == keep {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        // Parse just enough to check the id. Cheap.
        if let Ok(card) = parse_card(&path) {
            if card.id == card_id {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

/// Remove a card by id. Scans the dir (no in-disk index) — fine at the V1
/// scale (~50 cards).
pub fn delete_card(home: &Path, slug: &str, card_id: &str) -> Result<()> {
    let dir = memories_dir(home, slug);
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        if let Ok(card) = parse_card(&path) {
            if card.id == card_id {
                std::fs::remove_file(&path)
                    .with_context(|| format!("deleting {path:?}"))?;
            }
        }
    }
    Ok(())
}

/// Public helper for `lib.rs` to compute the on-disk path of the memories dir
/// (used in tooltips / "open in Finder" affordance later).
#[allow(dead_code)]
pub fn dir_for(home: &Path, slug: &str) -> PathBuf {
    memories_dir(home, slug)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_home() -> PathBuf {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("cosmos-mem-test-{ts}"));
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    #[test]
    fn roundtrip_parse_serialize() {
        let card = MemoryCard {
            id: "abc12345".into(),
            title: "Auth strategy".into(),
            body: "We picked JWT because…\n\n## Why\n\nReasons.".into(),
            kind: "decision".into(),
            tags: vec!["arch".into(), "auth".into()],
            pinned: true,
            created_at: 1715000000,
            updated_at: 1715000001,
        };
        let serialized = serialize_card(&card);
        assert!(serialized.starts_with("<!-- cosmos-meta "));
        assert!(serialized.contains("# Auth strategy"));

        // Write & re-parse.
        let home = fresh_home();
        upsert_card(&home, "myproj", &card).unwrap();
        let cards = list_cards(&home, "myproj").unwrap();
        assert_eq!(cards.len(), 1);
        let back = &cards[0];
        assert_eq!(back.id, card.id);
        assert_eq!(back.title, card.title);
        assert_eq!(back.kind, card.kind);
        assert_eq!(back.tags, card.tags);
        assert_eq!(back.pinned, card.pinned);
    }

    #[test]
    fn list_empty_dir_is_ok() {
        let home = fresh_home();
        let cards = list_cards(&home, "neverexisted").unwrap();
        assert!(cards.is_empty());
    }

    #[test]
    fn delete_removes_file() {
        let home = fresh_home();
        let card = MemoryCard {
            id: "deletable".into(),
            title: "Doomed".into(),
            body: "byebye".into(),
            kind: "note".into(),
            tags: vec![],
            pinned: false,
            created_at: 0,
            updated_at: 0,
        };
        upsert_card(&home, "proj", &card).unwrap();
        assert_eq!(list_cards(&home, "proj").unwrap().len(), 1);
        delete_card(&home, "proj", "deletable").unwrap();
        assert_eq!(list_cards(&home, "proj").unwrap().len(), 0);
    }

    #[test]
    fn title_rename_cleans_stale_file() {
        let home = fresh_home();
        let mut card = MemoryCard {
            id: "stable".into(),
            title: "First name".into(),
            body: "body".into(),
            kind: "note".into(),
            tags: vec![],
            pinned: false,
            created_at: 0,
            updated_at: 0,
        };
        upsert_card(&home, "proj", &card).unwrap();
        card.title = "Second name".into();
        upsert_card(&home, "proj", &card).unwrap();
        // Only one card on disk — the renamed-title one. (Stale removed.)
        let cards = list_cards(&home, "proj").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].title, "Second name");
    }

    #[test]
    fn parse_tolerates_missing_frontmatter() {
        let home = fresh_home();
        let dir = memories_dir(&home, "proj");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("raw.md"), "# Manual file\n\nNo frontmatter.").unwrap();
        let cards = list_cards(&home, "proj").unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].title, "Manual file");
        assert_eq!(cards[0].kind, "note");
    }
}
