//! Tokens and money an agent has spent, read from Claude Code's transcript.
//!
//! The transcript is append-only, so each file is read once and then only
//! from where the last read stopped. Cost is an estimate from list prices:
//! Claude Code does not write what a session was billed.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// Size of the last main-thread request: how full the context is.
    pub context_tokens: u64,
    pub cost_usd: f64,
    /// Model of the last reply, as the API named it.
    pub model: String,
}

#[derive(Deserialize, Default, Clone)]
struct CacheCreation {
    #[serde(default)]
    ephemeral_1h_input_tokens: u64,
}

#[derive(Deserialize, Default, Clone)]
struct RawUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_creation: Option<CacheCreation>,
}

#[derive(Deserialize)]
struct RawMessage {
    #[serde(default)]
    id: String,
    #[serde(default)]
    model: String,
    usage: Option<RawUsage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLine {
    #[serde(default)]
    is_sidechain: bool,
    message: Option<RawMessage>,
}

/// USD per million tokens, `(input, output)`. `None` for a model nobody
/// listed: its tokens count, its cost does not.
fn price(model: &str) -> Option<(f64, f64)> {
    let m = model.to_lowercase();
    let has = |s: &str| m.contains(s);
    if has("opus") {
        Some((5.0, 25.0))
    } else if has("sonnet") {
        Some((3.0, 15.0))
    } else if has("haiku") {
        Some((1.0, 5.0))
    } else if has("deepseek") && (has("pro") || has("reasoner")) {
        Some((0.55, 2.19))
    } else if has("deepseek") {
        Some((0.28, 0.42))
    } else {
        None
    }
}

fn cost_of(model: &str, u: &RawUsage) -> f64 {
    let Some((input, output)) = price(model) else { return 0.0 };
    let long = u.cache_creation.as_ref().map_or(0, |c| c.ephemeral_1h_input_tokens);
    let short = u.cache_creation_input_tokens.saturating_sub(long);
    (u.input_tokens as f64 * input
        + u.cache_read_input_tokens as f64 * input * 0.1
        + short as f64 * input * 1.25
        + long as f64 * input * 2.0
        + u.output_tokens as f64 * output)
        / 1_000_000.0
}

/// One reply is written as several lines that repeat its usage, so a reply is
/// only added once the next one starts.
#[derive(Default, Clone)]
struct Tally {
    offset: u64,
    done: Usage,
    open: Option<(String, String, RawUsage, bool)>,
}

impl Tally {
    fn close(&mut self) {
        let Some((_, model, u, side)) = self.open.take() else { return };
        self.done.input_tokens += u.input_tokens;
        self.done.output_tokens += u.output_tokens;
        self.done.cache_read_tokens += u.cache_read_input_tokens;
        self.done.cache_write_tokens += u.cache_creation_input_tokens;
        self.done.cost_usd += cost_of(&model, &u);
        if !side {
            self.done.context_tokens =
                u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
            self.done.model = model;
        }
    }

    fn line(&mut self, line: &str) {
        if !line.contains("\"usage\"") || !line.contains("\"type\":\"assistant\"") {
            return;
        }
        let Ok(raw) = serde_json::from_str::<RawLine>(line) else { return };
        let Some(msg) = raw.message else { return };
        let Some(usage) = msg.usage else { return };
        if self.open.as_ref().is_some_and(|(id, ..)| *id != msg.id || id.is_empty()) {
            self.close();
        }
        self.open = Some((msg.id, msg.model, usage, raw.is_sidechain));
    }

    fn total(&self) -> Usage {
        let mut t = self.clone();
        t.close();
        t.done
    }
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Tally>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Tally>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Usage of the transcript at `path`; zeroes when there is none yet.
pub fn read(path: &Path) -> Usage {
    let Ok(mut file) = std::fs::File::open(path) else { return Usage::default() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut all = cache().lock().unwrap();
    let tally = all.entry(path.to_path_buf()).or_default();
    if len < tally.offset {
        *tally = Tally::default();
    }
    if len > tally.offset && file.seek(SeekFrom::Start(tally.offset)).is_ok() {
        let mut bytes = Vec::with_capacity((len - tally.offset) as usize);
        if file.read_to_end(&mut bytes).is_ok() {
            // A line still being written stays for the next read.
            let whole = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
            for line in String::from_utf8_lossy(&bytes[..whole]).lines() {
                tally.line(line);
            }
            tally.offset += whole as u64;
        }
    }
    tally.total()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn reply(id: &str, model: &str, input: u64, output: u64, side: bool) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":{side},"message":{{"id":"{id}","model":"{model}","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":1000,"cache_creation_input_tokens":0}}}}}}"#
        ) + "\n"
    }

    fn file(tag: &str) -> PathBuf {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("cosmos-usage-{tag}-{ts}.jsonl"))
    }

    #[test]
    fn a_reply_split_over_lines_counts_once() {
        let path = file("dedupe");
        let text = reply("m1", "claude-sonnet-5-5", 100, 10, false)
            + &reply("m1", "claude-sonnet-5-5", 100, 50, false)
            + &reply("m2", "claude-sonnet-5-5", 200, 20, false);
        std::fs::write(&path, text).unwrap();
        let u = read(&path);
        assert_eq!((u.input_tokens, u.output_tokens), (300, 70));
        assert_eq!(u.context_tokens, 1200);
        assert_eq!(u.model, "claude-sonnet-5-5");
        let want = (300.0 * 3.0 + 2000.0 * 0.3 + 70.0 * 15.0) / 1e6;
        assert!((u.cost_usd - want).abs() < 1e-9, "{}", u.cost_usd);
    }

    #[test]
    fn only_what_was_appended_is_read_again() {
        let path = file("append");
        std::fs::write(&path, reply("m1", "claude-opus-5-5", 10, 1, false)).unwrap();
        assert_eq!(read(&path).output_tokens, 1);
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(reply("m2", "claude-opus-5-5", 10, 2, false).as_bytes()).unwrap();
        f.write_all(b"{\"type\":\"assistant\",\"mess").unwrap();
        let u = read(&path);
        assert_eq!((u.input_tokens, u.output_tokens), (20, 3));
        assert_eq!(read(&path), u);
    }

    #[test]
    fn a_subagent_spends_but_does_not_fill_the_context() {
        let path = file("side");
        let text = reply("m1", "claude-opus-5-5", 500, 5, false)
            + &reply("s1", "claude-haiku-4-5", 9000, 9, true);
        std::fs::write(&path, text).unwrap();
        let u = read(&path);
        assert_eq!(u.context_tokens, 1500);
        assert_eq!(u.model, "claude-opus-5-5");
        assert_eq!(u.input_tokens, 9500);
        assert!(read(Path::new("/nonexistent/x.jsonl")) == Usage::default());
    }
}
