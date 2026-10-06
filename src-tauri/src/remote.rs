//! Wiring for remote access: config and the handoff between the web server
//! and the tunnel.
//!
//! The tunnel address rotates whenever cloudflared reconnects, so it is
//! written to `~/.cosmos/web-url` and pushed to Telegram — a URL you have to
//! come back to the desk to read is useless. The address opens nothing by
//! itself: a browser still has to pair (`web_auth`).

use crate::NoConsole;
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
    /// Also answer on the local network, not only to the tunnel.
    #[serde(default = "yes")]
    pub lan: bool,
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
            lan: true,
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

fn url_path(home: &Path) -> PathBuf {
    cosmos_dir(home).join("web-url")
}

pub fn save_config(home: &Path, cfg: &RemoteConfig) -> Result<()> {
    std::fs::create_dir_all(cosmos_dir(home))?;
    std::fs::write(config_path(home), serde_json::to_string_pretty(cfg)?)?;
    Ok(())
}

/// Brings the tunnel in line with `cfg` without a restart. The web server
/// itself is not restartable in place — `enabled`, `port` and `lan` are read
/// at launch — so only the tunnel is reconciled here and the UI says as much.
pub fn apply_tunnel(home: &Path, cfg: &RemoteConfig) {
    let port = bound_port(cfg);
    if cfg.enabled && cfg.tunnel {
        if crate::tunnel::is_running() {
            return;
        }
        crate::tunnel::start(port, on_tunnel(home.to_path_buf(), port));
    } else {
        crate::tunnel::stop();
        write_url_file(home, port, cfg.lan, None);
    }
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

/// The port the server actually bound, once it is up.
static PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

fn bound_port(cfg: &RemoteConfig) -> u16 {
    match PORT.load(std::sync::atomic::Ordering::Relaxed) {
        0 => cfg.port,
        port => port,
    }
}

/// This machine's address on the local network. Opening a UDP socket towards
/// a public address sends nothing; it only makes the OS pick the interface.
fn lan_ip() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

fn on_tunnel(home: PathBuf, port: u16) -> impl Fn(&str) + Send + 'static {
    move |url| {
        let cfg = load_config(&home);
        write_url_file(&home, port, cfg.lan, Some(url));
        notify(&home, url);
    }
}

/// Starts the web server, then the tunnel. Returns the bound port so the
/// caller can report it even when the tunnel never comes up.
pub fn start(app: tauri::AppHandle, hub: crate::web::Hub, home: &Path) -> Result<Option<u16>> {
    // The shared secret of earlier releases opens nothing anymore.
    let _ = std::fs::remove_file(cosmos_dir(home).join("web-token"));
    let cfg = load_config(home);
    if !cfg.enabled {
        let _ = std::fs::remove_file(url_path(home));
        return Ok(None);
    }
    let port = crate::web::start(app, hub, cfg.port, cfg.lan)?;
    PORT.store(port, std::sync::atomic::Ordering::Relaxed);
    write_url_file(home, port, cfg.lan, None);

    if cfg.tunnel {
        crate::tunnel::start(port, on_tunnel(home.to_path_buf(), port));
    }
    Ok(Some(port))
}

fn write_url_file(home: &Path, port: u16, lan: bool, tunnel: Option<&str>) {
    let local = format!("http://127.0.0.1:{port}");
    let lan = lan.then(lan_ip).flatten().map(|ip| format!("http://{ip}:{port}"));
    let body = json!({
        "port": port,
        "local": local,
        "lan": lan,
        "tunnel": tunnel,
        "link": tunnel.map(str::to_string).or(lan.clone()),
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
    let text = format!(
        "De: Cosmos\n\nWeb UI no ar:\n{link}\n\nNavegador novo pede o código de pareamento: Ajustes › Acesso remoto, ou peça ao Hub (`cosmos web pair`)."
    );
    std::thread::spawn(move || {
        let _ = std::process::Command::new("curl")
            .hidden()
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
