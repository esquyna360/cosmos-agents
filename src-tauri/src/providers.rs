//! Who answers an agent's API calls, and with which model.
//!
//! Every agent is still Claude Code. A provider other than Anthropic is an
//! endpoint that speaks the Anthropic Messages API (DeepSeek does), reached by
//! pointing the CLI at it with `ANTHROPIC_BASE_URL` and that provider's key.
//!
//! Keys are never stored by Cosmos: a provider names a file under
//! `~/.private_keys/`, read at spawn time and handed to the child as env.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

pub const ANTHROPIC: &str = "anthropic";

/// What a model is good for, which is what the router picks by.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// Architecture, decisions, hard diagnosis.
    Deep,
    /// Execution and volume.
    Work,
    /// Mechanical, cheap tasks.
    Cheap,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Model {
    pub id: String,
    #[serde(default)]
    pub label: String,
    pub tier: Tier,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Provider {
    pub id: String,
    pub name: String,
    /// Empty for Anthropic: the CLI keeps its own login.
    #[serde(default)]
    pub base_url: String,
    /// Path to the API key, `~` allowed.
    #[serde(default)]
    pub key_file: String,
    pub models: Vec<Model>,
    /// Model for the CLI's background calls (titles, summaries).
    #[serde(default)]
    pub small_model: String,
    /// Filled in by `list`: the key file exists and is not empty.
    #[serde(default)]
    pub available: bool,
}

impl Provider {
    pub fn is_anthropic(&self) -> bool {
        self.id == ANTHROPIC
    }

    pub fn default_model(&self) -> &str {
        self.models
            .iter()
            .find(|m| m.tier == Tier::Work)
            .or(self.models.first())
            .map(|m| m.id.as_str())
            .unwrap_or("")
    }

    fn model_of(&self, tier: Tier) -> Option<&str> {
        self.models.iter().find(|m| m.tier == tier).map(|m| m.id.as_str())
    }
}

fn model(id: &str, label: &str, tier: Tier) -> Model {
    Model { id: id.into(), label: label.into(), tier }
}

fn builtin() -> Vec<Provider> {
    vec![
        Provider {
            id: ANTHROPIC.into(),
            name: "Anthropic".into(),
            base_url: String::new(),
            key_file: String::new(),
            models: vec![
                model("opus", "Opus", Tier::Deep),
                model("sonnet", "Sonnet", Tier::Work),
                model("haiku", "Haiku", Tier::Cheap),
            ],
            small_model: String::new(),
            available: true,
        },
        Provider {
            id: "deepseek".into(),
            name: "DeepSeek".into(),
            base_url: "https://api.deepseek.com/anthropic".into(),
            key_file: "~/.private_keys/deepseek_api_key".into(),
            models: vec![
                model("deepseek-flash", "DeepSeek Flash", Tier::Cheap),
                model("deepseek-v4-pro", "DeepSeek Pro", Tier::Work),
            ],
            small_model: "deepseek-flash".into(),
            available: false,
        },
    ]
}

fn expand(home: &Path, path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

fn read_key(home: &Path, provider: &Provider) -> Option<String> {
    let raw = std::fs::read_to_string(expand(home, &provider.key_file)).ok()?;
    let key = raw.trim();
    (!key.is_empty()).then(|| key.to_string())
}

/// Built-ins plus whatever `~/.cosmos/providers.json` adds or overrides by id.
pub fn list(home: &Path) -> Vec<Provider> {
    let mut all = builtin();
    let extra = std::fs::read_to_string(home.join(".cosmos").join("providers.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<Provider>>(&raw).ok())
        .unwrap_or_default();
    for p in extra {
        if p.id.is_empty() || p.id == ANTHROPIC || p.base_url.is_empty() || p.models.is_empty() {
            continue;
        }
        match all.iter_mut().find(|b| b.id == p.id) {
            Some(slot) => *slot = p,
            None => all.push(p),
        }
    }
    for p in all.iter_mut() {
        p.available = p.is_anthropic() || read_key(home, p).is_some();
        for m in p.models.iter_mut() {
            if m.label.is_empty() {
                m.label = m.id.clone();
            }
        }
    }
    all
}

/// Settles what a runner row stores from what the caller typed. Returns
/// `(provider, model)` with Anthropic as the empty provider, so rows written
/// before providers existed need no backfill.
pub fn resolve(home: &Path, provider: &str, model: &str) -> Result<(String, String)> {
    let provider = provider.trim().to_lowercase();
    let model = model.trim().to_string();
    let all = list(home);
    if provider.is_empty() || provider == ANTHROPIC {
        // A bare `--model deepseek-flash` is enough to pick its provider.
        let owner = all
            .iter()
            .find(|p| !p.is_anthropic() && p.models.iter().any(|m| m.id == model));
        return match owner {
            Some(p) if provider.is_empty() => check_available(p).map(|_| (p.id.clone(), model)),
            _ => Ok((String::new(), model)),
        };
    }
    let found = all.iter().find(|p| p.id == provider).ok_or_else(|| {
        anyhow!(
            "provedor `{provider}` não existe. Disponíveis: {}",
            all.iter().map(|p| p.id.as_str()).collect::<Vec<_>>().join(", ")
        )
    })?;
    check_available(found)?;
    let model = if model.is_empty() { found.default_model().to_string() } else { model };
    Ok((found.id.clone(), model))
}

fn check_available(p: &Provider) -> Result<()> {
    if !p.available {
        bail!("provedor `{}` sem key: crie {} com a API key", p.id, p.key_file);
    }
    Ok(())
}

/// Env that points Claude Code at `provider`. Empty for Anthropic.
pub fn env_for(home: &Path, provider: &str, model: &str) -> Result<Vec<(String, String)>> {
    if provider.is_empty() || provider == ANTHROPIC {
        return Ok(Vec::new());
    }
    let all = list(home);
    let p = all
        .iter()
        .find(|p| p.id == provider)
        .ok_or_else(|| anyhow!("provedor `{provider}` não existe mais em ~/.cosmos/providers.json"))?;
    let key = read_key(home, p)
        .ok_or_else(|| anyhow!("provedor `{}` sem key: crie {} com a API key", p.id, p.key_file))?;
    let main = if model.is_empty() { p.default_model() } else { model };
    let small = if p.small_model.is_empty() {
        p.model_of(Tier::Cheap).unwrap_or(main)
    } else {
        &p.small_model
    };
    let deep = p.model_of(Tier::Deep).unwrap_or(main);
    let pairs = [
        ("ANTHROPIC_BASE_URL", p.base_url.as_str()),
        ("ANTHROPIC_AUTH_TOKEN", key.as_str()),
        ("ANTHROPIC_MODEL", main),
        // Subagents and background calls ask for Claude aliases; map each to
        // something this endpoint actually serves.
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", deep),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL", main),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL", small),
        ("ANTHROPIC_SMALL_FAST_MODEL", small),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
        ("API_TIMEOUT_MS", "600000"),
    ];
    Ok(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
}

/// "Sonnet", "DeepSeek Flash": what the UI and `cosmos status` print.
pub fn label(home: &Path, provider: &str, model: &str) -> String {
    if model.is_empty() && provider.is_empty() {
        return String::new();
    }
    let id = if provider.is_empty() { ANTHROPIC } else { provider };
    list(home)
        .iter()
        .find(|p| p.id == id)
        .and_then(|p| p.models.iter().find(|m| m.id == model))
        .map(|m| m.label.clone())
        .unwrap_or_else(|| model.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(tag: &str, with_key: bool) -> PathBuf {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("cosmos-prov-{tag}-{ts}"));
        std::fs::create_dir_all(home.join(".private_keys")).unwrap();
        std::fs::create_dir_all(home.join(".cosmos")).unwrap();
        if with_key {
            std::fs::write(home.join(".private_keys/deepseek_api_key"), "sk-test\n").unwrap();
        }
        home
    }

    #[test]
    fn anthropic_needs_no_env_and_stores_an_empty_provider() {
        let h = home("anth", false);
        assert_eq!(resolve(&h, "", "opus").unwrap(), (String::new(), "opus".into()));
        assert_eq!(resolve(&h, "anthropic", "").unwrap(), (String::new(), String::new()));
        assert!(env_for(&h, "", "opus").unwrap().is_empty());
    }

    #[test]
    fn a_deepseek_model_alone_picks_the_provider() {
        let h = home("infer", true);
        assert_eq!(
            resolve(&h, "", "deepseek-flash").unwrap(),
            ("deepseek".into(), "deepseek-flash".into())
        );
        assert_eq!(
            resolve(&h, "deepseek", "").unwrap(),
            ("deepseek".into(), "deepseek-v4-pro".into())
        );
    }

    #[test]
    fn the_key_comes_from_the_file_and_only_into_env() {
        let h = home("env", true);
        let env = env_for(&h, "deepseek", "deepseek-flash").unwrap();
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("ANTHROPIC_BASE_URL"), Some("https://api.deepseek.com/anthropic"));
        assert_eq!(get("ANTHROPIC_AUTH_TOKEN"), Some("sk-test"));
        assert_eq!(get("ANTHROPIC_MODEL"), Some("deepseek-flash"));
        assert_eq!(get("ANTHROPIC_SMALL_FAST_MODEL"), Some("deepseek-flash"));
    }

    #[test]
    fn a_provider_without_its_key_is_refused_with_the_path() {
        let h = home("nokey", false);
        let err = resolve(&h, "deepseek", "").unwrap_err().to_string();
        assert!(err.contains("~/.private_keys/deepseek_api_key"), "{err}");
        assert!(env_for(&h, "deepseek", "").is_err());
        assert!(resolve(&h, "nope", "").is_err());
    }

    #[test]
    fn providers_json_adds_and_overrides() {
        let h = home("extra", false);
        std::fs::write(h.join(".private_keys/kimi"), "k").unwrap();
        std::fs::write(
            h.join(".cosmos/providers.json"),
            r#"[{"id":"kimi","name":"Kimi","base_url":"https://x/anthropic",
                 "key_file":"~/.private_keys/kimi",
                 "models":[{"id":"kimi-k2","tier":"cheap"}]}]"#,
        )
        .unwrap();
        let all = list(&h);
        let kimi = all.iter().find(|p| p.id == "kimi").unwrap();
        assert!(kimi.available);
        assert_eq!(kimi.models[0].label, "kimi-k2");
        assert_eq!(resolve(&h, "kimi", "").unwrap().1, "kimi-k2");
    }
}
