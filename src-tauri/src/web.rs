//! Remote control plane. Serves the same runners the desktop window shows,
//! over HTTP + WebSocket on loopback, so `tunnel.rs` can publish it through
//! Cloudflare and the phone becomes a first-class client.
//!
//! Two rules shape the design:
//! - Loopback only. The tunnel is the sole way in, and every request carries a
//!   token, because a quick-tunnel URL is public the moment it exists.
//! - Additive attachment. A web viewer subscribes to a PTY's fan-out; it never
//!   steals the desktop window's channel (see `PtySupervisor::web_subscribe`).

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxPath, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::projects;
use crate::pty_supervisor::{PtySupervisor, RunnerKind};
use crate::store::Store;

const COOKIE: &str = "cosmos_web";
const SPAWN_COLS: u16 = 120;
const SPAWN_ROWS: u16 = 32;

#[derive(Clone)]
struct Web {
    app: AppHandle,
    token: Arc<String>,
}

/// Binds the first free port at or after `port` and serves until the app
/// exits. Returns the port actually bound so the tunnel points at the right
/// place.
pub fn start(app: AppHandle, port: u16, token: String) -> Result<u16> {
    let listener = bind_from(port)?;
    let bound = listener.local_addr()?.port();
    let state = Web {
        app,
        token: Arc::new(token),
    };

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
                if let Err(e) = axum::serve(listener, router(state)).await {
                    eprintln!("[cosmos] web server stopped: {e}");
                }
            });
        })?;

    Ok(bound)
}

fn bind_from(start: u16) -> Result<std::net::TcpListener> {
    for port in start..start.saturating_add(16) {
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        if let Ok(l) = std::net::TcpListener::bind(addr) {
            l.set_nonblocking(true)?;
            return Ok(l);
        }
    }
    Err(anyhow!("no free port in {start}..{}", start + 16))
}

fn router(state: Web) -> Router {
    Router::new()
        .route("/", get(page_index))
        .route("/r/{id}", get(page_term))
        .route("/assets/{file}", get(asset))
        .route("/api/state", get(api_state))
        .route("/api/runner/{id}/spawn", post(api_spawn))
        .route("/api/runner/{id}/kill", post(api_kill))
        .route("/api/runner/{id}/send", post(api_send))
        .route("/api/project/{id}/agent", post(api_new_agent))
        .route("/ws/{id}", get(ws_handler))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state)
}

// ---------------------------------------------------------------- auth

/// Token in `?t=` mints a cookie and redirects to the clean URL; after that
/// every request rides the cookie. Anything unauthenticated gets a flat 401 —
/// no hints about what lives here.
async fn auth(State(web): State<Web>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();

    let from_query = form_urlencoded_get(&query, "t");
    if let Some(tok) = from_query.as_deref() {
        if tok == web.token.as_str() {
            let mut res = Redirect::to(&path).into_response();
            res.headers_mut().insert(
                header::SET_COOKIE,
                format!("{COOKIE}={tok}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly")
                    .parse()
                    .unwrap(),
            );
            return res;
        }
        return unauthorized();
    }

    let cookie_ok = req
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(|raw| {
            raw.split(';').any(|kv| {
                let kv = kv.trim();
                kv.strip_prefix(&format!("{COOKIE}="))
                    .map(|v| v == web.token.as_str())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    if cookie_ok {
        return next.run(req).await;
    }
    unauthorized()
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

fn form_urlencoded_get(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        if it.next()? == key {
            return it.next().map(|v| v.replace('+', " "));
        }
    }
    None
}

// ---------------------------------------------------------------- pages

async fn page_index() -> Html<&'static str> {
    Html(include_str!("../assets/web/index.html"))
}

async fn page_term() -> Html<&'static str> {
    Html(include_str!("../assets/web/term.html"))
}

async fn asset(AxPath(file): AxPath<String>) -> Response {
    let (body, mime): (&'static str, &'static str) = match file.as_str() {
        "xterm.js" => (include_str!("../assets/web/xterm.js"), "text/javascript"),
        "addon-fit.js" => (
            include_str!("../assets/web/addon-fit.js"),
            "text/javascript",
        ),
        "xterm.css" => (include_str!("../assets/web/xterm.css"), "text/css"),
        "app.css" => (include_str!("../assets/web/app.css"), "text/css"),
        "app.js" => (include_str!("../assets/web/app.js"), "text/javascript"),
        _ => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(body))
        .unwrap()
}

// ---------------------------------------------------------------- api

async fn api_state(State(web): State<Web>) -> Json<Value> {
    Json(snapshot(&web.app))
}

/// One read of the whole control room: projects, their runners, and each
/// runner's live status straight from the supervisor.
fn snapshot(app: &AppHandle) -> Value {
    let store = app.state::<Store>();
    let supervisor = app.state::<PtySupervisor>();

    let projects = projects::list(&store).unwrap_or_default();
    let runners = projects::runners_list(&store).unwrap_or_default();

    let list: Vec<Value> = projects
        .iter()
        .map(|p| {
            let rs: Vec<Value> = runners
                .iter()
                .filter(|r| r.project_id == p.id)
                .map(|r| {
                    let status = supervisor.status(&r.id);
                    json!({
                        "id": r.id,
                        "name": r.name,
                        "kind": r.kind,
                        "live": status.is_some(),
                        "status": status
                            .map(|s| serde_json::to_value(s).unwrap_or(Value::Null))
                            .unwrap_or(Value::Null),
                    })
                })
                .collect();
            json!({
                "id": p.id,
                "name": p.name,
                "slug": p.slug,
                "cwd": p.cwd,
                "folders": p.folders,
                "runners": rs,
            })
        })
        .collect();

    json!({
        "projects": list,
        "tunnel": crate::tunnel::current_url(),
        "master": crate::master::MASTER_NAME,
    })
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
    let supervisor = app.state::<PtySupervisor>();
    if supervisor.status(id).is_some() {
        return Ok(());
    }
    supervisor.spawn_with_slug(
        app.clone(),
        runner.id.clone(),
        project.id.clone(),
        project.slug.clone(),
        RunnerKind::from_str(&runner.kind),
        project.cwd.clone(),
        runner.program.clone(),
        runner.args.clone(),
        SPAWN_COLS,
        SPAWN_ROWS,
    )?;
    let _ = app.emit(
        "runners-changed",
        json!({ "reason": "web.spawn", "projectId": project.id }),
    );
    Ok(())
}

async fn api_spawn(State(web): State<Web>, AxPath(id): AxPath<String>) -> Response {
    match spawn_runner(&web.app, &id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

async fn api_kill(State(web): State<Web>, AxPath(id): AxPath<String>) -> Response {
    let res = {
        let supervisor = web.app.state::<PtySupervisor>();
        supervisor.kill(&id)
    };
    match res {
        Ok(()) => {
            let _ = web.app.emit("runners-changed", json!({ "reason": "web.kill" }));
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct SendBody {
    text: String,
    #[serde(default = "yes")]
    submit: bool,
}

fn yes() -> bool {
    true
}

/// Fire-and-forget prompt delivery, for clients that don't hold a socket open
/// (a Telegram bridge, a shortcut). The terminal page uses the WebSocket.
async fn api_send(
    State(web): State<Web>,
    AxPath(id): AxPath<String>,
    Json(body): Json<SendBody>,
) -> Response {
    let _ = spawn_runner(&web.app, &id);
    let mut data = body.text.into_bytes();
    if body.submit {
        data.push(b'\r');
    }
    let res = {
        let supervisor = web.app.state::<PtySupervisor>();
        supervisor.write(&id, &data)
    };
    match res {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct NewAgentBody {
    name: String,
    #[serde(default)]
    kind: Option<String>,
}

async fn api_new_agent(
    State(web): State<Web>,
    AxPath(project_id): AxPath<String>,
    Json(body): Json<NewAgentBody>,
) -> Response {
    match new_agent(&web.app, &project_id, body.name, body.kind.as_deref()) {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

fn new_agent(app: &AppHandle, project_id: &str, name: String, kind: Option<&str>) -> Result<Value> {
    let store = app.state::<Store>();
    let project = projects::list(&store)?
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| anyhow!("no project `{project_id}`"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let record = projects::build_runner_record(
        crate::uuid_v4_for_ipc(),
        project.id.clone(),
        kind.unwrap_or("agent").to_string(),
        name,
        None,
        None,
        None,
        now,
    );
    store.runners_upsert(&projects::runner_record_to_row(&record)?)?;
    drop(store);
    spawn_runner(app, &record.id)?;
    Ok(json!({ "id": record.id, "name": record.name }))
}

// ---------------------------------------------------------------- websocket

async fn ws_handler(
    State(web): State<Web>,
    AxPath(id): AxPath<String>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| ws_session(web, id, socket))
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

async fn ws_session(web: Web, id: String, socket: WebSocket) {
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

    // Output pump: PTY fan-out → socket. A lagging client skips ahead rather
    // than stalling the PTY for everyone else.
    let out = tokio::spawn(async move {
        loop {
            match feed.recv().await {
                Ok(chunk) => {
                    if tx.send(Message::Binary(chunk.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
        let _ = tx.close().await;
    });

    while let Some(Ok(msg)) = rx.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => {
                let app = web.app.clone();
                let supervisor = app.state::<PtySupervisor>();
                let _ = supervisor.write(&id, &b);
                continue;
            }
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(parsed) = serde_json::from_str::<ClientMsg>(&text) else {
            continue;
        };
        match parsed {
            ClientMsg::Input { d } => {
                let supervisor = web.app.state::<PtySupervisor>();
                let _ = supervisor.write(&id, d.as_bytes());
            }
            ClientMsg::Resize { c, r } => {
                let supervisor = web.app.state::<PtySupervisor>();
                let _ = supervisor.resize(&id, c, r);
            }
            ClientMsg::Revive => {
                let _ = spawn_runner(&web.app, &id);
            }
        }
    }

    out.abort();
}
