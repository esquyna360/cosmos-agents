//! The second brain: one vault over notes that already live on disk.
//!
//! Nothing is copied. The vault is a view over agent memories
//! (`~/.claude/projects/*/memory`), every `CLAUDE.md`, the guidelines, the
//! dev logs and Cosmos' own notes (`~/.cosmos/brain`). `[[name]]` links and
//! relative Markdown links between them become the graph; a note is found by
//! its frontmatter `name`, its file name or its title.
//!
//! The index is rebuilt on demand, so what an agent just wrote is there on
//! the next read. Only the parsing is remembered, per file, for as long as
//! its size and mtime stand.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use anyhow::{anyhow, bail, Result};
use serde::Serialize;

const MAX_FILE_BYTES: u64 = 400 * 1024;
const MAX_NOTES: usize = 6000;
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", "Pods", "vendor", ".git", ".dart_tool", ".gradle", ".next",
    ".venv", "venv", "__pycache__",
];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// The path with `~` for home: stable, and readable in a terminal.
    pub id: String,
    pub path: String,
    /// What `[[...]]` matches first: frontmatter `name`, else the file stem.
    pub name: String,
    pub title: String,
    /// `memory`, `claude`, `guideline`, `devlog`, `project` or `note`.
    pub source: String,
    /// Where it belongs inside its source: a project, a folder.
    pub group: String,
    pub description: String,
    pub tags: Vec<String>,
    pub modified: i64,
    pub words: usize,
    /// Ids this note links to.
    pub links: Vec<String>,
    /// Link targets that match no note.
    pub dangling: Vec<String>,
    /// How many notes link here.
    pub backlinks: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct Index {
    pub notes: Vec<Note>,
    pub tags: Vec<(String, usize)>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    pub id: String,
    pub title: String,
    pub source: String,
    /// The line the link sits on.
    pub context: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub note: Note,
    pub content: String,
    pub backlinks: Vec<Mention>,
    pub outgoing: Vec<Mention>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: String,
    pub name: String,
    pub title: String,
    pub source: String,
    pub group: String,
    pub snippet: String,
    pub score: i32,
}

/* --------------------------------- roots -------------------------------- */

struct Root {
    source: &'static str,
    dir: PathBuf,
    depth: usize,
    /// Only files with exactly this name.
    only: Option<&'static str>,
}

/// Where new notes go.
pub fn notes_dir(home: &Path) -> PathBuf {
    home.join(".cosmos").join("brain")
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    out.sort();
    out
}

fn roots(home: &Path) -> Vec<Root> {
    let mut out = Vec::new();
    for project in subdirs(&home.join(".claude").join("projects")) {
        out.push(Root { source: "memory", dir: project.join("memory"), depth: 1, only: None });
    }
    for project in subdirs(&home.join(".cosmos").join("projects")) {
        out.push(Root { source: "project", dir: project.join("memories"), depth: 1, only: None });
    }
    let code = home.join("code");
    out.push(Root { source: "guideline", dir: code.join("guidelines"), depth: 6, only: None });
    out.push(Root { source: "devlog", dir: code.join(".dev-logs"), depth: 5, only: None });
    out.push(Root { source: "claude", dir: home.join(".claude"), depth: 0, only: Some("CLAUDE.md") });
    out.push(Root { source: "claude", dir: code, depth: 4, only: Some("CLAUDE.md") });
    out.push(Root { source: "note", dir: notes_dir(home), depth: 4, only: None });
    out
}

fn walk(root: &Root, dir: &Path, depth: usize, seen: &mut HashSet<PathBuf>, out: &mut Vec<(PathBuf, &'static str)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    // The kind comes with the listing: the dev logs hold tens of thousands of
    // files and a stat for each is what would make the vault feel slow.
    let mut entries: Vec<(PathBuf, bool)> = entries
        .flatten()
        .filter_map(|e| {
            let kind = e.file_type().ok()?;
            let is_dir = if kind.is_symlink() { e.path().is_dir() } else { kind.is_dir() };
            Some((e.path(), is_dir))
        })
        .collect();
    entries.sort();
    // A checkout parked among the logs is somebody's source tree, not notes.
    if root.source == "devlog" && entries.iter().any(|(p, _)| p.file_name().is_some_and(|n| n == ".git")) {
        return;
    }
    for (path, is_dir) in entries {
        if out.len() >= MAX_NOTES {
            return;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if is_dir {
            // Guidelines and dev logs are claimed by their own roots.
            let nested_root = root.only.is_some() && (name == "guidelines" || name == ".dev-logs");
            let hidden = root.only.is_some() && name.starts_with('.');
            if depth < root.depth && !SKIP_DIRS.contains(&name) && !nested_root && !hidden {
                walk(root, &path, depth + 1, seen, out);
            }
            continue;
        }
        let wanted = match root.only {
            Some(only) => name == only,
            None => name.ends_with(".md"),
        };
        if wanted && seen.insert(path.clone()) {
            out.push((path, root.source));
        }
    }
}

/* -------------------------------- parsing ------------------------------- */

#[derive(Default, Debug, PartialEq)]
struct Front {
    name: String,
    description: String,
    kind: String,
    tags: Vec<String>,
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let quoted = v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
    if quoted { v[1..v.len() - 1].to_string() } else { v.to_string() }
}

/// Splits YAML frontmatter off. Only the handful of keys the vault uses are
/// read, so a full YAML parser would be dead weight.
fn front_matter(raw: &str) -> (Front, &str) {
    let mut front = Front::default();
    let Some(rest) = raw.strip_prefix("---\n").or_else(|| raw.strip_prefix("---\r\n")) else {
        return (front, raw);
    };
    let Some(end) = rest.find("\n---") else { return (front, raw) };
    let body = rest[end + 4..].trim_start_matches(['\r', '\n']);
    let mut in_tags = false;
    for line in rest[..end].lines() {
        let trimmed = line.trim();
        if in_tags {
            if let Some(item) = trimmed.strip_prefix("- ") {
                front.tags.push(unquote(item));
                continue;
            }
            in_tags = false;
        }
        let Some((key, value)) = trimmed.split_once(':') else { continue };
        let value = value.trim();
        match key.trim() {
            "name" if front.name.is_empty() => front.name = unquote(value),
            "description" => front.description = unquote(value),
            "type" => front.kind = unquote(value),
            "tags" if value.is_empty() => in_tags = true,
            "tags" => front.tags.extend(
                value.trim_matches(['[', ']']).split(',').map(unquote).filter(|t| !t.is_empty()),
            ),
            _ => {}
        }
    }
    (front, body)
}

/// Cosmos memory cards carry their meta in an HTML comment on line one.
fn strip_card_meta(body: &str) -> &str {
    if body.starts_with("<!-- cosmos-meta") {
        body.split_once('\n').map_or("", |(_, rest)| rest)
    } else {
        body
    }
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-' || c == '/'
}

struct Scanned {
    title: String,
    /// `(target, line it sits on)`
    wiki: Vec<(String, String)>,
    relative: Vec<(String, String)>,
    tags: Vec<String>,
    words: usize,
}

/// One pass over the body, skipping code so a `[[` in a snippet is not a link.
fn scan(body: &str) -> Scanned {
    let mut out = Scanned { title: String::new(), wiki: vec![], relative: vec![], tags: vec![], words: 0 };
    let mut fenced = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        out.words += trimmed.split_whitespace().count();
        if out.title.is_empty() {
            if let Some(h) = trimmed.strip_prefix("# ") {
                out.title = h.trim().to_string();
            }
        }
        let prose = strip_inline_code(line);
        let mut rest = prose.as_str();
        while let Some(open) = rest.find("[[") {
            let after = &rest[open + 2..];
            let Some(close) = after.find("]]") else { break };
            let target = after[..close].split('|').next().unwrap_or("").split('#').next().unwrap_or("").trim();
            if !target.is_empty() && !target.contains('\n') {
                out.wiki.push((target.to_string(), trimmed.to_string()));
            }
            rest = &after[close + 2..];
        }
        let mut rest = prose.as_str();
        while let Some(open) = rest.find("](") {
            let after = &rest[open + 2..];
            let Some(close) = after.find(')') else { break };
            let href = after[..close].split('#').next().unwrap_or("").trim();
            if href.ends_with(".md") && !href.contains("://") {
                out.relative.push((href.replace("%20", " "), trimmed.to_string()));
            }
            rest = &after[close + 1..];
        }
        let heading = trimmed.starts_with('#') && trimmed.trim_start_matches('#').starts_with(' ');
        if !heading {
            collect_tags(&prose, &mut out.tags);
        }
    }
    out
}

fn strip_inline_code(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut code = false;
    for c in line.chars() {
        if c == '`' {
            code = !code;
            out.push(' ');
        } else if !code {
            out.push(c);
        }
    }
    out
}

fn collect_tags(line: &str, tags: &mut Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let starts = chars[i] == '#' && (i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(');
        if !starts {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < chars.len() && is_tag_char(chars[j]) {
            j += 1;
        }
        let tag: String = chars[i + 1..j].iter().collect();
        let looks_like_color = matches!(tag.len(), 3 | 6 | 8) && tag.chars().all(|c| c.is_ascii_hexdigit());
        let wordy = tag.chars().next().is_some_and(|c| c.is_alphabetic());
        if tag.chars().count() >= 2 && wordy && !looks_like_color {
            let tag = tag.to_lowercase();
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
        i = j.max(i + 1);
    }
}

fn fold(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'ê' | 'è' | 'ë' => 'e',
            'í' | 'î' | 'ì' | 'ï' => 'i',
            'ó' | 'ô' | 'õ' | 'ò' | 'ö' => 'o',
            'ú' | 'û' | 'ù' | 'ü' => 'u',
            'ç' => 'c',
            other => other,
        })
        .collect()
}

fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in fold(text).chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').chars().take(60).collect::<String>().trim_end_matches('-').to_string()
}

fn tilde(home: &Path, path: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) => format!("~/{}", rest.to_string_lossy()),
        Err(_) => path.to_string_lossy().to_string(),
    }
}

/// `-Users-bruno--cosmos-projects-ninar` → `ninar`. Claude Code flattens the
/// cwd into the folder name, so this is a label, not a path.
fn memory_group(home: &Path, project_dir: &str) -> String {
    let flat: String = home.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let rest = project_dir.strip_prefix(&flat).unwrap_or(project_dir).trim_start_matches('-');
    let rest = rest.strip_prefix("cosmos-projects-").or_else(|| rest.strip_prefix("cosmos-worktrees-")).unwrap_or(rest);
    let rest = ["code-apps-", "code-games-", "code-saas-", "code-tools-", "code-videos-", "code-"]
        .iter()
        .find_map(|p| rest.strip_prefix(p))
        .unwrap_or(rest);
    if rest.is_empty() { "home".into() } else { rest.to_string() }
}

fn group_of(home: &Path, source: &str, path: &Path) -> String {
    let parent = path.parent().unwrap_or(path);
    let dir_name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    match source {
        "memory" => memory_group(home, &dir_name(parent.parent().unwrap_or(parent))),
        "project" => dir_name(parent.parent().unwrap_or(parent)),
        "claude" => {
            if parent == home.join(".claude") { "global".into() } else { dir_name(parent) }
        }
        "guideline" | "devlog" | "note" => {
            let base = match source {
                "guideline" => home.join("code").join("guidelines"),
                "devlog" => home.join("code").join(".dev-logs"),
                _ => notes_dir(home),
            };
            parent
                .strip_prefix(&base)
                .ok()
                .and_then(|rel| rel.components().next())
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .unwrap_or_default()
        }
        _ => String::new(),
    }
}

#[derive(Clone)]
struct Parsed {
    note: Note,
    dir: PathBuf,
    wiki: Vec<(String, String)>,
    relative: Vec<(String, String)>,
    raw: Arc<str>,
    folded: Arc<str>,
}

fn parse(home: &Path, path: &Path, source: &str, raw: &str) -> Parsed {
    let (front, body) = front_matter(raw);
    let scanned = scan(strip_card_meta(body));
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let group = group_of(home, source, path);
    let name = if front.name.is_empty() { stem.clone() } else { front.name.clone() };
    let title = match (stem.as_str(), scanned.title.is_empty()) {
        ("CLAUDE", _) => format!("CLAUDE.md · {group}"),
        ("MEMORY", _) => format!("Memória · {group}"),
        (_, false) => scanned.title.clone(),
        _ => name.clone(),
    };
    let mut tags: Vec<String> = front.tags.iter().map(|t| t.trim_start_matches('#').to_lowercase()).collect();
    if !front.kind.is_empty() {
        tags.push(front.kind.to_lowercase());
    }
    for t in scanned.tags {
        if !tags.contains(&t) {
            tags.push(t);
        }
    }
    tags.dedup();
    let modified = path
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs() as i64);
    Parsed {
        note: Note {
            id: tilde(home, path),
            path: path.to_string_lossy().to_string(),
            name,
            title,
            source: source.to_string(),
            group,
            description: front.description,
            tags,
            modified,
            words: scanned.words,
            links: vec![],
            dangling: vec![],
            backlinks: 0,
        },
        dir: path.parent().unwrap_or(path).to_path_buf(),
        wiki: scanned.wiki,
        relative: scanned.relative,
        raw: raw.into(),
        folded: fold(raw).into(),
    }
}

/* --------------------------------- index -------------------------------- */

struct Built {
    notes: Vec<Note>,
    /// `(raw, folded)` per note, for search.
    texts: Vec<(Arc<str>, Arc<str>)>,
    /// `(from, to, line)` by position in `notes`.
    mentions: Vec<(usize, usize, String)>,
}

/// Resolves a `[[target]]` the way a person means it: a note called that,
/// preferring one that sits next to the note doing the linking.
fn resolve(target: &str, from: Option<usize>, parsed: &[Parsed], keys: &HashMap<String, Vec<usize>>) -> Option<usize> {
    let wanted = fold(target.trim().trim_end_matches(".md"));
    let found = keys.get(&wanted)?;
    let Some(from) = from else { return found.first().copied() };
    found
        .iter()
        .copied()
        .filter(|i| *i != from)
        .min_by_key(|i| {
            let other = &parsed[*i];
            let me = &parsed[from];
            if other.dir == me.dir {
                0
            } else if other.note.source == me.note.source {
                1
            } else {
                2
            }
        })
}

fn keys_of(parsed: &[Parsed]) -> HashMap<String, Vec<usize>> {
    let mut keys: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, p) in parsed.iter().enumerate() {
        let stem = Path::new(&p.note.path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        // Dozens of files are called CLAUDE or MEMORY: those names say nothing.
        let generic = stem == "CLAUDE" || stem == "MEMORY";
        let mut mine = vec![fold(&p.note.name), fold(&p.note.title), slug(&p.note.title)];
        if !generic {
            mine.push(fold(&stem));
        }
        mine.sort();
        mine.dedup();
        for key in mine.into_iter().filter(|k| !k.is_empty()) {
            keys.entry(key).or_default().push(i);
        }
    }
    keys
}

fn load(home: &Path) -> Vec<Parsed> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for root in roots(home) {
        walk(&root, &root.dir, 0, &mut seen, &mut files);
    }
    let mut cache = parsed_cache().lock().unwrap_or_else(|e| e.into_inner());
    let out: Vec<Parsed> = files
        .iter()
        .filter_map(|(path, source)| {
            let meta = path.metadata().ok().filter(|m| m.len() <= MAX_FILE_BYTES)?;
            let stamp = (meta.len(), meta.modified().ok()?);
            if let Some((seen, parsed)) = cache.get(path) {
                if *seen == stamp {
                    return Some(parsed.clone());
                }
            }
            let raw = std::fs::read_to_string(path).ok()?;
            let parsed = parse(home, path, source, &raw);
            cache.insert(path.clone(), (stamp, parsed.clone()));
            Some(parsed)
        })
        .collect();
    if cache.len() > out.len() + 512 {
        let alive: HashSet<&PathBuf> = files.iter().map(|(p, _)| p).collect();
        cache.retain(|path, _| alive.contains(path));
    }
    out
}

type Stamp = (u64, std::time::SystemTime);

fn parsed_cache() -> &'static Mutex<HashMap<PathBuf, (Stamp, Parsed)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (Stamp, Parsed)>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The last index, kept for a moment: typing a search asks for it on every
/// keystroke. Anything written through here drops it at once.
fn recent() -> &'static Mutex<Option<(PathBuf, std::time::Instant, Arc<Built>)>> {
    static RECENT: OnceLock<Mutex<Option<(PathBuf, std::time::Instant, Arc<Built>)>>> = OnceLock::new();
    RECENT.get_or_init(Default::default)
}

fn forget() {
    *recent().lock().unwrap_or_else(|e| e.into_inner()) = None;
}

fn build(home: &Path) -> Arc<Built> {
    let mut slot = recent().lock().unwrap_or_else(|e| e.into_inner());
    if let Some((of, at, built)) = slot.as_ref() {
        if of == home && at.elapsed() < std::time::Duration::from_secs(3) {
            return built.clone();
        }
    }
    let built = Arc::new(build_now(home));
    *slot = Some((home.to_path_buf(), std::time::Instant::now(), built.clone()));
    built
}

fn build_now(home: &Path) -> Built {
    let mut parsed = load(home);
    let keys = keys_of(&parsed);
    let by_path: HashMap<PathBuf, usize> = parsed.iter().enumerate().map(|(i, p)| (PathBuf::from(&p.note.path), i)).collect();
    let mut mentions: Vec<(usize, usize, String)> = Vec::new();
    for i in 0..parsed.len() {
        let mut links: Vec<usize> = Vec::new();
        let mut dangling: Vec<String> = Vec::new();
        for (target, line) in &parsed[i].wiki {
            match resolve(target, Some(i), &parsed, &keys) {
                Some(to) => {
                    if !links.contains(&to) {
                        links.push(to);
                        mentions.push((i, to, line.clone()));
                    }
                }
                None if !dangling.contains(target) => dangling.push(target.clone()),
                None => {}
            }
        }
        for (href, line) in &parsed[i].relative {
            let joined = normalize_path(&parsed[i].dir.join(href));
            if let Some(&to) = by_path.get(&joined) {
                if to != i && !links.contains(&to) {
                    links.push(to);
                    mentions.push((i, to, line.clone()));
                }
            }
        }
        parsed[i].note.links = links.iter().map(|to| parsed[*to].note.id.clone()).collect();
        parsed[i].note.dangling = dangling;
    }
    for (_, to, _) in &mentions {
        parsed[*to].note.backlinks += 1;
    }
    let texts = parsed.iter().map(|p| (p.raw.clone(), p.folded.clone())).collect();
    Built { notes: parsed.into_iter().map(|p| p.note).collect(), texts, mentions }
}

/// Resolves `..` and `.` without touching the disk.
fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

pub fn index(home: &Path) -> Index {
    let built = build(home);
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for n in &built.notes {
        for t in &n.tags {
            *counts.entry(t.clone()).or_default() += 1;
        }
    }
    let mut tags: Vec<(String, usize)> = counts.into_iter().collect();
    tags.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    Index { notes: built.notes.clone(), tags }
}

/// Finds a note by id, path or name. Agents type names; the app sends ids.
fn locate(home: &Path, built: &Built, key: &str) -> Result<usize> {
    let key = key.trim();
    let as_path = match key.strip_prefix("~/") {
        Some(rest) => home.join(rest).to_string_lossy().to_string(),
        None => key.to_string(),
    };
    if let Some(i) = built.notes.iter().position(|n| n.id == key || n.path == as_path) {
        return Ok(i);
    }
    let wanted = fold(key.trim_end_matches(".md"));
    let score = |n: &Note| -> usize {
        if fold(&n.name) == wanted {
            0
        } else if fold(&n.title) == wanted || slug(&n.title) == wanted {
            1
        } else {
            usize::MAX
        }
    };
    built
        .notes
        .iter()
        .enumerate()
        .filter(|(_, n)| score(n) != usize::MAX)
        .min_by_key(|(_, n)| (score(n), std::cmp::Reverse(n.modified)))
        .map(|(i, _)| i)
        .ok_or_else(|| anyhow!("nenhuma nota chamada `{key}`. Procure com `cosmos brain search`"))
}

fn mention(note: &Note, context: &str) -> Mention {
    Mention {
        id: note.id.clone(),
        title: note.title.clone(),
        source: note.source.clone(),
        context: clip(context, 220),
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{}…", cut.trim_end())
}

pub fn open(home: &Path, key: &str) -> Result<Opened> {
    let built = build(home);
    let i = locate(home, &built, key)?;
    let note = built.notes[i].clone();
    let content = built.texts[i].0.to_string();
    let backlinks = built
        .mentions
        .iter()
        .filter(|(_, to, _)| *to == i)
        .map(|(from, _, line)| mention(&built.notes[*from], line))
        .collect();
    let outgoing = built
        .mentions
        .iter()
        .filter(|(from, _, _)| *from == i)
        .map(|(_, to, line)| mention(&built.notes[*to], line))
        .collect();
    Ok(Opened { note, content, backlinks, outgoing })
}

/* -------------------------------- writing ------------------------------- */

/// A note may only be written where the vault already reads from.
fn writable(home: &Path, path: &Path) -> Result<()> {
    let path = normalize_path(path);
    if path.extension().and_then(|e| e.to_str()) != Some("md") {
        bail!("só notas .md podem ser escritas");
    }
    let inside = roots(home).iter().any(|r| match r.only {
        Some(only) => path.file_name().and_then(|n| n.to_str()) == Some(only) && path.starts_with(&r.dir),
        None => path.starts_with(&r.dir),
    });
    if !inside {
        bail!("`{}` fica fora do vault", path.display());
    }
    Ok(())
}

fn write_atomic(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)?;
    forget();
    Ok(())
}

fn reopened(home: &Path, path: &Path) -> Result<Note> {
    let built = build(home);
    let i = locate(home, &built, &path.to_string_lossy())?;
    Ok(built.notes[i].clone())
}

/// Replaces the whole file of an existing note.
pub fn save(home: &Path, key: &str, content: &str) -> Result<Note> {
    let built = build(home);
    let i = locate(home, &built, key)?;
    let path = PathBuf::from(&built.notes[i].path);
    writable(home, &path)?;
    write_atomic(&path, content)?;
    reopened(home, &path)
}

pub fn append(home: &Path, key: &str, text: &str) -> Result<Note> {
    let text = text.trim();
    if text.is_empty() {
        bail!("nada para acrescentar");
    }
    let built = build(home);
    let i = locate(home, &built, key)?;
    let path = PathBuf::from(&built.notes[i].path);
    writable(home, &path)?;
    let mut content = std::fs::read_to_string(&path)?;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push('\n');
    content.push_str(text);
    content.push('\n');
    write_atomic(&path, &content)?;
    reopened(home, &path)
}

/// A new note in `~/.cosmos/brain`. The title becomes the file name; a taken
/// name is refused so one agent never silently overwrites another's note.
pub fn create(home: &Path, title: &str, body: &str, tags: &[String], description: &str) -> Result<Note> {
    let title = title.trim();
    let name = slug(title);
    if name.is_empty() {
        bail!("a nota precisa de um título");
    }
    let path = notes_dir(home).join(format!("{name}.md"));
    if path.exists() {
        bail!("já existe a nota `{name}`. Use `cosmos brain append {name}` para acrescentar");
    }
    let tags: Vec<String> = tags
        .iter()
        .map(|t| t.trim().trim_start_matches('#').to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    let mut content = format!("---\nname: {name}\n");
    if !description.trim().is_empty() {
        content.push_str(&format!("description: \"{}\"\n", description.trim().replace('"', "'")));
    }
    if !tags.is_empty() {
        content.push_str(&format!("tags: [{}]\n", tags.join(", ")));
    }
    content.push_str(&format!("---\n\n# {title}\n\n{}\n", body.trim()));
    write_atomic(&path, &content)?;
    reopened(home, &path)
}

/* --------------------------------- search ------------------------------- */

struct Query {
    terms: Vec<String>,
    tags: Vec<String>,
    sources: Vec<String>,
}

fn parse_query(q: &str) -> Query {
    let mut out = Query { terms: vec![], tags: vec![], sources: vec![] };
    for word in q.split_whitespace() {
        let folded = fold(word);
        if let Some(tag) = folded.strip_prefix("tag:").or_else(|| folded.strip_prefix('#')) {
            if !tag.is_empty() {
                out.tags.push(tag.to_string());
            }
        } else if let Some(src) = folded.strip_prefix("fonte:").or_else(|| folded.strip_prefix("source:")) {
            out.sources.push(src.to_string());
        } else {
            out.terms.push(folded);
        }
    }
    out
}

fn snippet(content: &str, terms: &[String]) -> String {
    let (_, body) = front_matter(content);
    let line = body
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("<!--"))
        .find(|l| {
            let f = fold(l);
            terms.iter().any(|t| f.contains(t.as_str()))
        })
        .or_else(|| body.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("<!--")))
        .unwrap_or("");
    clip(line, 200)
}

/// Every term must appear somewhere; where it appears decides the rank.
pub fn search(home: &Path, q: &str, limit: usize) -> Vec<Hit> {
    let query = parse_query(q);
    let built = build(home);
    let mut hits: Vec<Hit> = Vec::new();
    for (note, (content, body)) in built.notes.iter().zip(&built.texts) {
        if !query.sources.is_empty() && !query.sources.iter().any(|s| note.source.starts_with(s.as_str())) {
            continue;
        }
        if !query.tags.iter().all(|t| note.tags.iter().any(|have| fold(have).starts_with(t.as_str()))) {
            continue;
        }
        let title = fold(&note.title);
        let name = fold(&note.name);
        let meta = fold(&format!("{} {} {}", note.description, note.group, note.tags.join(" ")));
        let mut score = 0;
        let mut all = true;
        for term in &query.terms {
            let mut s = 0;
            if title.contains(term.as_str()) {
                s += 12;
            }
            if name.contains(term.as_str()) {
                s += 9;
            }
            if meta.contains(term.as_str()) {
                s += 5;
            }
            s += body.matches(term.as_str()).take(6).count() as i32;
            if s == 0 {
                all = false;
                break;
            }
            score += s;
        }
        if !all {
            continue;
        }
        score += (note.backlinks.min(8)) as i32;
        hits.push(Hit {
            id: note.id.clone(),
            name: note.name.clone(),
            title: note.title.clone(),
            source: note.source.clone(),
            group: note.group.clone(),
            snippet: snippet(content, &query.terms),
            score,
        });
    }
    hits.sort_by(|a, b| b.score.cmp(&a.score).then(a.title.cmp(&b.title)));
    hits.truncate(limit.clamp(1, 200));
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(tag: &str) -> PathBuf {
        let ts = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let home = std::env::temp_dir().join(format!("cosmos-brain-{tag}-{ts}"));
        let mem = home.join(".claude/projects/-tmp-ninar/memory");
        std::fs::create_dir_all(&mem).unwrap();
        std::fs::create_dir_all(home.join("code/guidelines/ads")).unwrap();
        std::fs::create_dir_all(home.join("code/apps/ninar/node_modules/x")).unwrap();
        std::fs::write(
            mem.join("paywall.md"),
            "---\nname: ninar-paywall\ndescription: \"Como o paywall funciona\"\nmetadata:\n  type: project\n---\n\nUsa RevenueCat. Ver [[loja]] e [[nao-existe]].\n`[[codigo]]` não conta. #monetizacao e cor #fff.\n",
        )
        .unwrap();
        std::fs::write(mem.join("loja.md"), "# Loja do Ninar\n\nScreenshots com promessa.\n").unwrap();
        std::fs::write(mem.join("MEMORY.md"), "- [Paywall](paywall.md) — como cobra\n- [Loja](loja.md)\n").unwrap();
        std::fs::write(home.join("code/guidelines/ads/PADRAO.md"), "# Padrão de anúncios\n\nVeja [[Loja do Ninar]].\n").unwrap();
        std::fs::write(home.join("code/apps/ninar/CLAUDE.md"), "# Ninar\n\nApp de sono.\n").unwrap();
        std::fs::write(home.join("code/apps/ninar/README.md"), "fora do vault").unwrap();
        std::fs::write(home.join("code/apps/ninar/node_modules/x/CLAUDE.md"), "lixo").unwrap();
        home
    }

    fn by_name<'a>(idx: &'a Index, name: &str) -> &'a Note {
        idx.notes.iter().find(|n| n.name == name).unwrap_or_else(|| panic!("no note {name}"))
    }

    #[test]
    fn the_vault_is_only_what_the_roots_claim() {
        let home = vault("roots");
        let idx = index(&home);
        let mut names: Vec<&str> = idx.notes.iter().map(|n| n.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["CLAUDE", "MEMORY", "PADRAO", "loja", "ninar-paywall"]);
        assert_eq!(by_name(&idx, "CLAUDE").title, "CLAUDE.md · ninar");
        assert_eq!(by_name(&idx, "MEMORY").source, "memory");
        assert_eq!(by_name(&idx, "ninar-paywall").group, "tmp-ninar");
    }

    #[test]
    fn links_resolve_by_name_stem_or_title_and_count_backlinks() {
        let home = vault("links");
        let idx = index(&home);
        let paywall = by_name(&idx, "ninar-paywall");
        let loja = by_name(&idx, "loja");
        assert_eq!(paywall.links, [loja.id.clone()]);
        assert_eq!(paywall.dangling, ["nao-existe"]);
        // paywall, the MEMORY index and the guideline (by title) all point at it.
        assert_eq!(loja.backlinks, 3);
        assert_eq!(by_name(&idx, "MEMORY").links.len(), 2);
        assert_eq!(paywall.tags, ["project", "monetizacao"]);
        assert_eq!(idx.tags.first().map(|t| t.0.as_str()), Some("monetizacao"));
    }

    #[test]
    fn opening_a_note_brings_the_lines_that_mention_it() {
        let home = vault("open");
        let opened = open(&home, "loja").unwrap();
        assert!(opened.content.contains("Screenshots"));
        let mut from: Vec<&str> = opened.backlinks.iter().map(|m| m.title.as_str()).collect();
        from.sort();
        assert_eq!(from, ["Memória · tmp-ninar", "Padrão de anúncios", "ninar-paywall"]);
        assert!(opened.backlinks.iter().any(|m| m.context.contains("Usa RevenueCat")));
        assert!(open(&home, "nada-disso").is_err());
    }

    #[test]
    fn search_ranks_titles_first_and_filters_by_tag_and_source() {
        let home = vault("search");
        let hits = search(&home, "loja", 10);
        assert_eq!(hits[0].title, "Loja do Ninar");
        assert!(hits.len() >= 3);
        let hits = search(&home, "tag:monetizacao", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "ninar-paywall");
        assert!(hits[0].snippet.contains("RevenueCat"));
        assert_eq!(search(&home, "padrao fonte:guideline", 10).len(), 1);
        assert!(search(&home, "revenuecat anuncios", 10).is_empty());
    }

    #[test]
    fn agents_create_append_and_cannot_write_outside() {
        let home = vault("write");
        let made = create(&home, "Decisão: preço do Ninar", "Fica em R$ 19. Ver [[ninar-paywall]].", &["Preço".into()], "Preço mensal").unwrap();
        assert_eq!(made.name, "decisao-preco-do-ninar");
        assert_eq!(made.source, "note");
        assert_eq!(made.links.len(), 1);
        assert!(create(&home, "Decisão: preço do Ninar", "de novo", &[], "").is_err());
        let after = append(&home, "decisao-preco-do-ninar", "Revisto em outubro.").unwrap();
        assert!(after.words > made.words);
        assert_eq!(open(&home, "ninar-paywall").unwrap().note.backlinks, 2);
        let saved = save(&home, "loja", "# Loja do Ninar\n\nNova.\n").unwrap();
        assert_eq!(saved.title, "Loja do Ninar");
        assert!(writable(&home, &home.join("code/apps/ninar/README.md")).is_err());
        assert!(writable(&home, &home.join("code/guidelines/../apps/ninar/x.md")).is_err());
        assert!(writable(&home, &home.join("code/apps/ninar/CLAUDE.md")).is_ok());
    }

    #[test]
    #[ignore]
    fn real_vault() {
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let t = std::time::Instant::now();
        let idx = index(&home);
        let took = t.elapsed();
        let mut by: BTreeMap<&str, usize> = BTreeMap::new();
        for n in &idx.notes {
            *by.entry(n.source.as_str()).or_default() += 1;
        }
        let links: usize = idx.notes.iter().map(|n| n.links.len()).sum();
        let dangling: usize = idx.notes.iter().map(|n| n.dangling.len()).sum();
        println!("{} notes in {took:?} {by:?} links={links} dangling={dangling}", idx.notes.len());
        println!("tags: {:?}", idx.tags.iter().take(25).collect::<Vec<_>>());
        let mut groups: Vec<&str> = idx.notes.iter().filter(|n| n.source == "memory").map(|n| n.group.as_str()).collect();
        groups.sort();
        groups.dedup();
        println!("groups: {groups:?}");
        forget();
        let again = std::time::Instant::now();
        index(&home);
        println!("warm index {:?}", again.elapsed());
        let t = std::time::Instant::now();
        let hits = search(&home, "upload crazygames", 5);
        println!("search {:?}: {:?}", t.elapsed(), hits.iter().map(|h| (&h.title, h.score)).collect::<Vec<_>>());
    }

    #[test]
    fn frontmatter_reads_the_keys_the_vault_uses() {
        let (front, body) = front_matter("---\nname: a-b\ntags:\n  - Um\n  - dois\nmetadata:\n  type: feedback\n---\n\ncorpo");
        assert_eq!(front, Front { name: "a-b".into(), description: String::new(), kind: "feedback".into(), tags: vec!["Um".into(), "dois".into()] });
        assert_eq!(body, "corpo");
        assert_eq!(front_matter("sem nada").1, "sem nada");
        assert_eq!(memory_group(Path::new("/Users/bruno"), "-Users-bruno--cosmos-projects-ninar"), "ninar");
        assert_eq!(memory_group(Path::new("/Users/bruno"), "-Users-bruno-code-games-splat-up"), "splat-up");
    }
}
