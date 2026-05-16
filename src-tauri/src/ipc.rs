//! Shared IPC protocol between the running Cosmos app and the `cosmos` CLI.
//!
//! Wire format: one JSON object per line. Client writes a `Request`, server
//! replies with a single `Response` and closes (or the client closes after
//! reading). Keeping it line-delimited means we don't need length-prefix
//! framing for these tiny payloads.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Default socket path. Lives next to `cosmos.sqlite` under `~/.cosmos/` so
/// it's discoverable without env vars and survives across app launches —
/// stale sockets are detected and unlinked at server start.
pub fn default_socket_path(home: &std::path::Path) -> PathBuf {
    home.join(".cosmos").join("cosmos.sock")
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "method", content = "params", rename_all = "kebab-case")]
pub enum Request {
    /// Create a project (and optionally an agent runner inside it).
    ProjectAdd {
        name: String,
        folders: Vec<String>,
        #[serde(default)]
        memory: String,
        /// When `Some`, also creates an auto-starting agent runner with this
        /// name inside the new project. `None` = project shell only.
        #[serde(default)]
        with_agent: Option<String>,
    },
    /// Read-only listing.
    ProjectList,
    /// Add a runner to an existing project. `project` accepts either a slug
    /// or `.` (resolved to `$COSMOS_PROJECT_SLUG`). Auto-starts the PTY.
    RunnerAdd {
        project: String,
        name: String,
        /// "agent" (default) or "shell".
        #[serde(default)]
        kind: Option<String>,
    },
    /// Read-only listing, optionally filtered by project slug or `.`.
    RunnerList {
        #[serde(default)]
        project: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok(data: serde_json::Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }
    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}
