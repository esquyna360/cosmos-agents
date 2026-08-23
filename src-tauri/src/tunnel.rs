//! Cloudflare quick tunnel supervisor. Publishes the loopback web server at a
//! public HTTPS URL without an account, a domain, or an inbound port.
//!
//! Quick-tunnel URLs are ephemeral — they change every time cloudflared
//! reconnects — so the URL is a moving target by design: we watch for it,
//! persist it, and hand it to whoever asked to be told.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const CANDIDATES: [&str; 4] = [
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
    "cloudflared",
];

fn url_slot() -> &'static Mutex<Option<String>> {
    static URL: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    URL.get_or_init(|| Mutex::new(None))
}

static CHILD_PID: AtomicU32 = AtomicU32::new(0);

pub fn current_url() -> Option<String> {
    url_slot().lock().ok().and_then(|u| u.clone())
}

/// Where cloudflared actually lives. GUI apps inherit a bare PATH, so the
/// Homebrew prefix has to be probed explicitly rather than assumed.
pub fn binary() -> Option<String> {
    CANDIDATES
        .iter()
        .find(|c| {
            if c.starts_with('/') {
                std::path::Path::new(c).exists()
            } else {
                Command::new(c)
                    .arg("--version")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            }
        })
        .map(|c| c.to_string())
}

/// Runs cloudflared against `port` forever, restarting it if it dies. Calls
/// `on_url` once per established tunnel — including after a reconnect, since
/// the URL changes and any saved link is dead.
pub fn start<F>(port: u16, on_url: F)
where
    F: Fn(&str) + Send + 'static,
{
    let Some(bin) = binary() else {
        eprintln!("[cosmos] cloudflared not found — remote access stays local-only");
        return;
    };

    std::thread::Builder::new()
        .name("cosmos-tunnel".into())
        .spawn(move || loop {
            match run_once(&bin, port, &on_url) {
                Ok(()) => eprintln!("[cosmos] tunnel closed, reconnecting"),
                Err(e) => eprintln!("[cosmos] tunnel error: {e}"),
            }
            *url_slot().lock().unwrap() = None;
            std::thread::sleep(Duration::from_secs(5));
        })
        .ok();
}

fn run_once<F>(bin: &str, port: u16, on_url: &F) -> anyhow::Result<()>
where
    F: Fn(&str),
{
    let mut child: Child = Command::new(bin)
        .args([
            "tunnel",
            "--no-autoupdate",
            "--url",
            &format!("http://127.0.0.1:{port}"),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    CHILD_PID.store(child.id(), Ordering::SeqCst);

    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for _ in BufReader::new(out).lines().map_while(Result::ok) {}
        });
    }

    if let Some(err) = child.stderr.take() {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            if let Some(url) = extract_url(&line) {
                let mut slot = url_slot().lock().unwrap();
                if slot.as_deref() != Some(url.as_str()) {
                    *slot = Some(url.clone());
                    drop(slot);
                    on_url(&url);
                }
            }
        }
    }

    let _ = child.wait();
    CHILD_PID.store(0, Ordering::SeqCst);
    Ok(())
}

fn extract_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches('/').to_string();
    url.ends_with(".trycloudflare.com").then_some(url)
}

/// Kill the tunnel on app exit. Without this the child outlives the window and
/// keeps serving a URL nobody is watching.
pub fn shutdown() {
    let pid = CHILD_PID.swap(0, Ordering::SeqCst);
    if pid != 0 {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

#[cfg(test)]
mod tests {
    use super::extract_url;

    #[test]
    fn picks_quick_tunnel_url_out_of_a_log_line() {
        let line = "2026-08-22T02:11:04Z INF |  https://foo-bar-baz.trycloudflare.com   |";
        assert_eq!(
            extract_url(line).as_deref(),
            Some("https://foo-bar-baz.trycloudflare.com")
        );
        assert_eq!(extract_url("INF connected to https://api.example.com"), None);
    }
}
