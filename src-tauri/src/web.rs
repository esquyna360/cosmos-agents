//! Remote control plane: the same app the desktop window runs, served to a
//! browser on the local network or through the tunnel.
//!
//! Nothing is reimplemented for the web. The page is the desktop frontend;
//! its calls come in over HTTP and are handed to the very command handlers
//! the window uses, and what the backend emits goes out over a WebSocket.
//!
//! Three rules shape it:
//! - Nobody gets in without pairing (`web_auth`). The shell of the page is
//!   public so it can ask for the code; everything that reads or does
//!   something needs the session cookie.
//! - The cookie alone is not enough to act: writes need a header only our
//!   own page can send, and sockets must come from our own origin.
//! - Additive attachment. A web viewer subscribes to a PTY's fan-out; it never
//!   steals the desktop window's channel (see `PtySupervisor::web_subscribe`).

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path as AxPath, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::broadcast;

use crate::projects;
use crate::pty_supervisor::PtySupervisor;
use crate::store::Store;
use crate::web_auth::{Auth, Device, PairError, SESSION_TTL};

const COOKIE: &str = "cosmos_session";
const SPAWN_COLS: u16 = 120;
const SPAWN_ROWS: u16 = 32;
const MAX_BODY: usize = 24 * 1024 * 1024;

/// What the backend emits that a page needs to stay current.
const EVENTS: &[&str] = &[
    "agent-line",
    "agent-exit",
    "agent-status",
    "agent-task",
    "runner-status",
    "runners-changed",
    "projects-changed",
    "brain-changed",
];

/// Commands a browser may not call: they belong to the desk (who may pair,
/// what is exposed), or they hand out a channel that only the window has.
fn refused(cmd: &str) -> bool {
    cmd.starts_with("web_")
        || cmd.starts_with("plugin:")
        || matches!(cmd, "remote_config_set" | "pty_attach" | "pty_detach")
}

/// Shared between the server and the desk's own commands.
#[derive(Clone)]
pub struct Hub {
    pub auth: Arc<Auth>,
    /// Ids of devices whose session just ended; their sockets close.
    revoked: broadcast::Sender<String>,
}

impl Hub {
    pub fn new(home: &std::path::Path) -> Hub {
        Hub { auth: Arc::new(Auth::load(home)), revoked: broadcast::channel(16).0 }
    }

    pub fn revoke(&self, id: &str) -> bool {
        let gone = self.auth.revoke(id);
        if gone {
            let _ = self.revoked.send(id.to_string());
        }
        gone
    }
}

#[derive(Clone)]
struct Web {
    app: AppHandle,
    hub: Hub,
    events: broadcast::Sender<Arc<str>>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Binds the first free port at or after `port` and serves until the app
/// exits. Returns the port actually bound so the tunnel points at the right
/// place.
pub fn start(app: AppHandle, hub: Hub, port: u16, lan: bool) -> Result<u16> {
    let listener = bind_from(port, lan)?;
    let bound = listener.local_addr()?.port();
    let (events, _) = broadcast::channel::<Arc<str>>(2048);
    for name in EVENTS {
        let tx = events.clone();
        app.listen_any(*name, move |event| {
            if tx.receiver_count() == 0 {
                return;
            }
            let payload = event.payload();
            let payload = if payload.is_empty() { "null" } else { payload };
            let _ = tx.send(format!("{{\"event\":\"{name}\",\"payload\":{payload}}}").into());
        });
    }
    let state = Web { app, hub, events };

    std::thread::Builder::new()
        .name("cosmos-web".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[cosmos] web runtime failed: {e}");
                    return;
                }
            };
            rt.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("[cosmos] web listener failed: {e}");
                        return;
                    }
                };
                let service = router(state).into_make_service_with_connect_info::<SocketAddr>();
                if let Err(e) = axum::serve(listener, service).await {
                    eprintln!("[cosmos] web server stopped: {e}");
                }
            });
        })?;

    Ok(bound)
}

fn bind_from(start: u16, lan: bool) -> Result<std::net::TcpListener> {
    let host = if lan { Ipv4Addr::UNSPECIFIED } else { Ipv4Addr::LOCALHOST };
    for port in start..start.saturating_add(16) {
        if let Ok(l) = std::net::TcpListener::bind(SocketAddr::from((host, port))) {
            l.set_nonblocking(true)?;
            return Ok(l);
        }
    }
    Err(anyhow!("no free port in {start}..{}", start + 16))
}

fn router(state: Web) -> Router {
    let private = Router::new()
        .route("/api/invoke/{cmd}", post(api_invoke))
        .route("/api/logout", post(api_logout))
        .route("/ws/events", get(ws_events))
        .route("/ws/pty/{id}", get(ws_pty))
        .layer(middleware::from_fn_with_state(state.clone(), session));
    Router::new()
        .route("/api/session", get(api_session))
        .route("/api/pair", post(api_pair))
        .merge(private)
        .fallback(get(page))
        .layer(middleware::from_fn(hardening))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
        .with_state(state)
}

// ---------------------------------------------------------------- auth

/// The address to hold a miss against. Behind the tunnel every connection
/// comes from cloudflared on loopback, which says who is really there.
fn address(headers: &HeaderMap, peer: SocketAddr) -> String {
    if peer.ip().is_loopback() {
        if let Some(real) = headers.get("cf-connecting-ip").and_then(|v| v.to_str().ok()) {
            return real.trim().chars().take(64).collect();
        }
    }
    peer.ip().to_string()
}

fn through_tunnel(headers: &HeaderMap) -> bool {
    headers.contains_key("cf-connecting-ip")
        || headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) == Some("https")
}

fn cookie_of(headers: &HeaderMap) -> Option<String> {
    let prefix = format!("{COOKIE}=");
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|raw| raw.split(';'))
        .find_map(|kv| kv.trim().strip_prefix(&prefix).map(str::to_string))
}

fn set_cookie(headers: &HeaderMap, token: &str, max_age: i64) -> HeaderValue {
    let secure = if through_tunnel(headers) { "; Secure" } else { "" };
    format!("{COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict{secure}")
        .parse()
        .expect("cookie is ascii")
}

/// True when the request was made by a page served from this very host.
/// A browser always says where a cross-site request comes from.
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    origin.split_once("://").map(|(_, rest)| rest) == Some(host)
}

fn device_of(web: &Web, headers: &HeaderMap, peer: SocketAddr) -> Option<Device> {
    let token = cookie_of(headers)?;
    web.hub.auth.check(&token, &address(headers, peer), now())
}

async fn session(
    State(web): State<Web>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut req: Request,
    next: Next,
) -> Response {
    let headers = req.headers();
    if !same_origin(headers) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    // A form or an image tag cannot set a header; our page can.
    if req.method() == axum::http::Method::POST && !headers.contains_key("x-cosmos") {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let Some(device) = device_of(&web, headers, peer) else {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    };
    req.extensions_mut().insert(device);
    next.run(req).await
}

async fn hardening(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    res
}

async fn api_session(
    State(web): State<Web>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Json<Value> {
    let device = device_of(&web, &headers, peer);
    Json(json!({
        "paired": device.is_some(),
        "device": device,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Deserialize)]
struct PairBody {
    code: String,
    #[serde(default)]
    name: String,
}

async fn api_pair(
    State(web): State<Web>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<PairBody>,
) -> Response {
    if !same_origin(&headers) || !headers.contains_key("x-cosmos") {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let agent = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("");
    match web.hub.auth.pair(&body.code, &body.name, &address(&headers, peer), agent, now()) {
        Ok((token, device)) => {
            let _ = web.app.emit("web-devices-changed", json!({ "paired": device }));
            let mut res = Json(json!({ "device": device })).into_response();
            res.headers_mut().insert(header::SET_COOKIE, set_cookie(&headers, &token, SESSION_TTL));
            res
        }
        Err(e) => {
            let status = match e {
                PairError::Locked { .. } => StatusCode::TOO_MANY_REQUESTS,
                _ => StatusCode::UNAUTHORIZED,
            };
            (status, Json(e)).into_response()
        }
    }
}

async fn api_logout(State(web): State<Web>, Extension(device): Extension<Device>, headers: HeaderMap) -> Response {
    web.hub.revoke(&device.id);
    let _ = web.app.emit("web-devices-changed", json!({ "revoked": device.id }));
    let mut res = Json(json!({ "ok": true })).into_response();
    res.headers_mut().insert(header::SET_COOKIE, set_cookie(&headers, "", 0));
    res
}

// ---------------------------------------------------------------- page

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// The frontend the window itself runs: bundled into the binary in a
/// release, read from `dist/` next to the sources while developing.
fn frontend(app: &AppHandle, path: &str) -> Option<Vec<u8>> {
    if let Some(asset) = app.asset_resolver().get(path.to_string()) {
        return Some(asset.bytes.to_vec());
    }
    if cfg!(debug_assertions) {
        return std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist").join(path)).ok();
    }
    None
}

async fn page(State(web): State<Web>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.split('/').any(|part| part == ".." || part.starts_with('.')) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let wants_file = path.rsplit('/').next().is_some_and(|name| name.contains('.'));
    let path = if path.is_empty() || !wants_file { "index.html" } else { path };
    let Some(bytes) = frontend(&web.app, path) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    // Built files carry a hash in their name; the page itself must stay fresh.
    let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    Response::builder()
        .header(header::CONTENT_TYPE, mime_of(path))
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(bytes))
        .unwrap()
}

// ---------------------------------------------------------------- invoke

/// Runs a command exactly as the window would: same handler, same state,
/// same serialization. Only the transport differs.
async fn api_invoke(State(web): State<Web>, AxPath(cmd): AxPath<String>, body: Bytes) -> Response {
    if refused(&cmd) {
        return (StatusCode::FORBIDDEN, Json(json!("este comando só existe no app"))).into_response();
    }
    let args: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => return (StatusCode::BAD_REQUEST, Json(json!(format!("invalid body: {e}")))).into_response(),
        }
    };
    let Some(window) = web.app.webview_windows().into_values().next() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!("o Cosmos está sem janela aberta no computador"))).into_response();
    };
    let Ok(url) = window.url() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!("a janela do Cosmos ainda está abrindo"))).into_response();
    };
    let request = InvokeRequest {
        cmd,
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url,
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: web.app.invoke_key().to_string(),
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    // Plain commands run on the calling thread; keep them off the reactor.
    tokio::task::spawn_blocking(move || {
        window.on_message(
            request,
            Box::new(move |_webview, _cmd, response, _callback, _error| {
                let _ = tx.send(response);
            }),
        );
    });
    match tokio::time::timeout(Duration::from_secs(180), rx).await {
        Ok(Ok(InvokeResponse::Ok(InvokeResponseBody::Json(raw)))) => Response::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(raw))
            .unwrap(),
        Ok(Ok(InvokeResponse::Ok(InvokeResponseBody::Raw(bytes)))) => Response::builder()
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(Body::from(bytes))
            .unwrap(),
        Ok(Ok(InvokeResponse::Err(e))) => (StatusCode::BAD_REQUEST, Json(e.0)).into_response(),
        Ok(Err(_)) => (StatusCode::NOT_FOUND, Json(json!("comando desconhecido"))).into_response(),
        Err(_) => (StatusCode::GATEWAY_TIMEOUT, Json(json!("o comando demorou demais"))).into_response(),
    }
}

// ---------------------------------------------------------------- sockets

/// Resolves when this device's session ends.
async fn until_revoked(mut revoked: broadcast::Receiver<String>, id: String) {
    loop {
        match revoked.recv().await {
            Ok(gone) if gone == id => return,
            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => std::future::pending::<()>().await,
        }
    }
}

async fn ws_events(State(web): State<Web>, Extension(device): Extension<Device>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| events_session(web, device, socket))
}

async fn events_session(web: Web, device: Device, socket: WebSocket) {
    let (mut tx, mut rx) = socket.split();
    let mut feed = web.events.subscribe();
    let gone = until_revoked(web.hub.revoked.subscribe(), device.id.clone());
    tokio::pin!(gone);
    let mut beat = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            _ = &mut gone => {
                let _ = tx.send(Message::Text("{\"event\":\"cosmos:revoked\",\"payload\":null}".into())).await;
                break;
            }
            _ = beat.tick() => {
                if tx.send(Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
            line = feed.recv() => match line {
                Ok(line) => {
                    if tx.send(Message::Text(line.as_ref().into())).await.is_err() {
                        break;
                    }
                }
                // The page missed some: tell it, so it reads the state again.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if tx.send(Message::Text("{\"event\":\"cosmos:resync\",\"payload\":null}".into())).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            },
            msg = rx.next() => match msg {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
        }
    }
    let _ = tx.close().await;
}

fn find_runner(app: &AppHandle, id: &str) -> Option<(projects::RunnerRecord, projects::ProjectRecord)> {
    let store = app.state::<Store>();
    let runner = projects::runners_list(&store)
        .ok()?
        .into_iter()
        .find(|r| r.id == id)?;
    let project = projects::list(&store)
        .ok()?
        .into_iter()
        .find(|p| p.id == runner.project_id)?;
    Some((runner, project))
}

/// Revive a runner whose PTY is gone, using its persisted program/args — the
/// same contract the desktop Terminal follows, so a shell never comes back as
/// an agent.
fn spawn_runner(app: &AppHandle, id: &str) -> Result<()> {
    let (runner, project) = find_runner(app, id).ok_or_else(|| anyhow!("no runner `{id}`"))?;
    if app.state::<PtySupervisor>().status(id).is_some() {
        return Ok(());
    }
    crate::ops::spawn_pty(app, &project, &runner, "")?;
    let _ = app.emit(
        "runners-changed",
        json!({ "reason": "web.spawn", "projectId": project.id }),
    );
    Ok(())
}

async fn ws_pty(
    State(web): State<Web>,
    Extension(device): Extension<Device>,
    AxPath(id): AxPath<String>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| pty_session(web, device, id, socket))
}

#[derive(Deserialize)]
#[serde(tag = "t")]
enum ClientMsg {
    /// Keystrokes / pasted text.
    #[serde(rename = "i")]
    Input { d: String },
    /// Opt-in resize. Off by default: the phone scales its view instead of
    /// reflowing the PTY under the desktop window.
    #[serde(rename = "r")]
    Resize { c: u16, r: u16 },
    #[serde(rename = "revive")]
    Revive,
}

async fn pty_session(web: Web, device: Device, id: String, socket: WebSocket) {
    let (mut tx, mut rx) = socket.split();

    let subscription = {
        let supervisor = web.app.state::<PtySupervisor>();
        supervisor.web_subscribe(&id)
    };
    let Some((snapshot, mut feed)) = subscription else {
        let _ = tx
            .send(Message::Text(
                json!({ "t": "dead" }).to_string().into(),
            ))
            .await;
        let _ = tx.close().await;
        return;
    };

    let size = {
        let supervisor = web.app.state::<PtySupervisor>();
        supervisor.size(&id).unwrap_or((SPAWN_COLS, SPAWN_ROWS))
    };
    let _ = tx
        .send(Message::Text(
            json!({ "t": "meta", "cols": size.0, "rows": size.1 })
                .to_string()
                .into(),
        ))
        .await;
    if !snapshot.is_empty() {
        let _ = tx.send(Message::Binary(snapshot.into())).await;
    }

    let gone = until_revoked(web.hub.revoked.subscribe(), device.id.clone());
    tokio::pin!(gone);
    let mut beat = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            _ = &mut gone => break,
            _ = beat.tick() => {
                if tx.send(Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
            // A lagging client skips ahead rather than stalling the PTY for
            // everyone else.
            chunk = feed.recv() => match chunk {
                Ok(chunk) => {
                    if tx.send(Message::Binary(chunk.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            msg = rx.next() => {
                let Some(Ok(msg)) = msg else { break };
                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Binary(b) => {
                        let supervisor = web.app.state::<PtySupervisor>();
                        let _ = supervisor.write(&id, &b);
                        continue;
                    }
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(parsed) = serde_json::from_str::<ClientMsg>(&text) else {
                    continue;
                };
                let supervisor = web.app.state::<PtySupervisor>();
                match parsed {
                    ClientMsg::Input { d } => {
                        let _ = supervisor.write(&id, d.as_bytes());
                    }
                    ClientMsg::Resize { c, r } => {
                        let _ = supervisor.resize(&id, c, r);
                    }
                    ClientMsg::Revive => {
                        let _ = spawn_runner(&web.app, &id);
                    }
                }
            }
        }
    }
    let _ = tx.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
        }
        h
    }

    #[test]
    fn the_tunnel_is_believed_about_the_caller_only_from_loopback() {
        let cf = headers(&[("cf-connecting-ip", "203.0.113.9")]);
        assert_eq!(address(&cf, "127.0.0.1:5000".parse().unwrap()), "203.0.113.9");
        assert_eq!(address(&cf, "192.168.0.7:5000".parse().unwrap()), "192.168.0.7");
        assert_eq!(address(&HeaderMap::new(), "127.0.0.1:5000".parse().unwrap()), "127.0.0.1");
    }

    #[test]
    fn only_our_own_page_counts_as_same_origin() {
        assert!(same_origin(&headers(&[("host", "a.trycloudflare.com"), ("origin", "https://a.trycloudflare.com")])));
        assert!(same_origin(&headers(&[("host", "192.168.0.5:7777"), ("origin", "http://192.168.0.5:7777")])));
        assert!(!same_origin(&headers(&[("host", "192.168.0.5:7777"), ("origin", "http://evil.example")])));
        assert!(!same_origin(&headers(&[("host", "a.trycloudflare.com"), ("origin", "null")])));
        assert!(same_origin(&headers(&[("host", "a.trycloudflare.com")])));
    }

    #[test]
    fn the_cookie_is_httponly_strict_and_secure_through_the_tunnel() {
        let lan = set_cookie(&HeaderMap::new(), "abc", 60);
        assert_eq!(lan.to_str().unwrap(), "cosmos_session=abc; Path=/; Max-Age=60; HttpOnly; SameSite=Strict");
        let tunnel = set_cookie(&headers(&[("cf-connecting-ip", "1.2.3.4")]), "abc", 60);
        assert!(tunnel.to_str().unwrap().ends_with("; Secure"));
        let jar = headers(&[("cookie", "theme=dark; cosmos_session=tok123; x=1")]);
        assert_eq!(cookie_of(&jar).as_deref(), Some("tok123"));
        assert_eq!(cookie_of(&headers(&[("cookie", "cosmos_sessionx=1")])), None);
    }

    #[test]
    fn the_desk_keeps_its_own_commands() {
        for cmd in ["web_pair_start", "web_device_revoke", "remote_config_set", "pty_attach", "plugin:updater|check"] {
            assert!(refused(cmd), "{cmd}");
        }
        for cmd in ["projects_list", "pty_write", "brain_search", "runner_send"] {
            assert!(!refused(cmd), "{cmd}");
        }
    }
}
