//! Wiring for remote access: config, the shared secret, and the handoff
//! between the web server and the tunnel.
//!
//! The link that matters is `tunnel_url + ?t=token`. It rotates whenever
//! cloudflared reconnects, so it is written to `~/.cosmos/web-url` and pushed
//! to Telegram — a URL you have to come back to the desk to read is useless.

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::json;

const DEFAULT_PORT: u16 = 7777;

#[derive(Serialize, Deserialize, Clone)]
pub struct RemoteConfig {
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "yes")]
    pub tunnel: bool,
    #[serde(default = "yes")]
    pub telegram_notify: bool,
    #[serde(default)]
    pub telegram_chat_id: String,
    #[serde(default = "default_token_file")]
    pub telegram_token_file: String,
}

fn yes() -> bool {
    true
}
fn default_port() -> u16 {
    DEFAULT_PORT
}
fn default_token_file() -> String {
    "~/.private_keys/telegram_bot_token".to_string()
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            port: DEFAULT_PORT,
            tunnel: true,
            telegram_notify: true,
            telegram_chat_id: String::new(),
            telegram_token_file: default_token_file(),
        }
    }
}

pub fn cosmos_dir(home: &Path) -> PathBuf {
    home.join(".cosmos")
}

fn config_path(home: &Path) -> PathBuf {
    cosmos_dir(home).join("web.json")
}

fn token_path(home: &Path) -> PathBuf {
    cosmos_dir(home).join("web-token")
}

fn url_path(home: &Path) -> PathBuf {
    cosmos_dir(home).join("web-url")
}

pub fn load_config(home: &Path) -> RemoteConfig {
    let path = config_path(home);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => {
            let cfg = RemoteConfig::default();
            let _ = std::fs::create_dir_all(cosmos_dir(home));
            if let Ok(raw) = serde_json::to_string_pretty(&cfg) {
                let _ = std::fs::write(&path, raw);
            }
            cfg
        }
    }
}

/// Stable across restarts, so a link already saved on the phone keeps working
/// as long as the tunnel host holds. 0600 — it is a password.
pub fn ensure_token(home: &Path) -> Result<String> {
    let path = token_path(home);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim().to_string();
        if trimmed.len() >= 24 {
            return Ok(trimmed);
        }
    }
    let token = random_hex(24);
    std::fs::create_dir_all(cosmos_dir(home))?;
    std::fs::write(&path, &token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(token)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Starts the web server, then the tunnel. Returns the bound port so the
/// caller can report it even when the tunnel never comes up.
pub fn start(app: tauri::AppHandle, home: &Path) -> Result<Option<u16>> {
    let cfg = load_config(home);
    if !cfg.enabled {
        return Ok(None);
    }
    let token = ensure_token(home)?;
    let port = crate::web::start(app, cfg.port, token.clone())?;
    write_url_file(home, port, &token, None);

    if cfg.tunnel {
        let home = home.to_path_buf();
        let token_for_cb = token.clone();
        crate::tunnel::start(port, move |url| {
            write_url_file(&home, port, &token_for_cb, Some(url));
            let link = format!("{url}/?t={token_for_cb}");
            notify(&home, &link);
        });
    }
    Ok(Some(port))
}

fn write_url_file(home: &Path, port: u16, token: &str, tunnel: Option<&str>) {
    let local = format!("http://127.0.0.1:{port}/?t={token}");
    let body = json!({
        "port": port,
        "token": token,
        "local": local,
        "tunnel": tunnel,
        "link": tunnel.map(|u| format!("{u}/?t={token}")),
    });
    let _ = std::fs::create_dir_all(cosmos_dir(home));
    if let Ok(raw) = serde_json::to_string_pretty(&body) {
        let _ = std::fs::write(url_path(home), raw);
    }
}

/// What `cosmos web` prints. Read from disk rather than app state so the CLI
/// works from any process.
pub fn info(home: &Path) -> serde_json::Value {
    std::fs::read_to_string(url_path(home))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({ "error": "cosmos web server not running" }))
}

fn expand_tilde(home: &Path, path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

/// Best-effort push of the fresh link. Silent when unconfigured — a missing
/// bot token is not an error worth interrupting a launch for.
fn notify(home: &Path, link: &str) {
    let cfg = load_config(home);
    if !cfg.telegram_notify || cfg.telegram_chat_id.is_empty() {
        return;
    }
    let token_file = expand_tilde(home, &cfg.telegram_token_file);
    let Ok(bot_token) = std::fs::read_to_string(&token_file) else {
        return;
    };
    let bot_token = bot_token.trim().to_string();
    if bot_token.is_empty() {
        return;
    }
    let chat_id = cfg.telegram_chat_id.clone();
    let text = format!("De: Cosmos\n\nWeb UI no ar:\n{link}");
    std::thread::spawn(move || {
        let _ = std::process::Command::new("curl")
            .args([
                "-s",
                "-o",
                "/dev/null",
                &format!("https://api.telegram.org/bot{bot_token}/sendMessage"),
                "-d",
                &format!("chat_id={chat_id}"),
                "--data-urlencode",
                &format!("text={text}"),
            ])
            .status();
    });
}
