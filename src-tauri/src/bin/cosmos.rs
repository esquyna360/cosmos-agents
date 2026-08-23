//! `cosmos` — tiny CLI client that talks to the running Cosmos app over a
//! local socket (Unix socket on macOS/Linux, named pipe on Windows). Designed
//! to be invoked from inside an agent's PTY (the app injects `COSMOS_SOCKET` +
//! `COSMOS_PROJECT_SLUG` into the env), so spawned agents can register new
//! projects/runners by running a shell command.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use agent_dashboard_lib::ipc::{default_socket_path, Request, Response};
use clap::{Parser, Subcommand};
use interprocess::local_socket::{prelude::*, Stream};
#[cfg(unix)]
use interprocess::local_socket::GenericFilePath;
#[cfg(windows)]
use interprocess::local_socket::GenericNamespaced;

#[derive(Parser)]
#[command(name = "cosmos", about = "Cosmos CLI — talks to the running app", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Project commands.
    Project {
        #[command(subcommand)]
        cmd: ProjectCmd,
    },
    /// Runner commands (agents and shells).
    Runner {
        #[command(subcommand)]
        cmd: RunnerCmd,
    },
    /// Show the remote web UI: local URL, Cloudflare tunnel and the link that
    /// carries the token. The tunnel URL rotates on every reconnect, so this
    /// is the way to get the current one.
    Web {
        /// Print only the authenticated link (or the local one if no tunnel).
        #[arg(long)]
        link: bool,
    },
}

#[derive(Subcommand)]
enum ProjectCmd {
    /// Create a project. Pass --with-agent NAME to also auto-spawn an agent.
    Add {
        #[arg(long)]
        name: String,
        /// Folder to include (repeatable for multi-folder projects).
        #[arg(long = "folder", num_args = 1, required = true)]
        folders: Vec<String>,
        #[arg(long, default_value = "")]
        memory: String,
        #[arg(long)]
        with_agent: Option<String>,
    },
    List,
}

#[derive(Subcommand)]
enum RunnerCmd {
    /// Spawn a new runner inside an existing project. `--project .` resolves
    /// to the agent's own project via $COSMOS_PROJECT_SLUG.
    Add {
        #[arg(long, default_value = ".")]
        project: String,
        #[arg(long)]
        name: String,
        /// "agent" (default) or "shell".
        #[arg(long, default_value = "agent")]
        kind: String,
    },
    List {
        #[arg(long)]
        project: Option<String>,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    if let Cmd::Web { link } = cli.cmd {
        return web(link);
    }
    let req = match build_request(cli) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    match send(req) {
        Ok(resp) => {
            if resp.ok {
                if let Some(data) = resp.data {
                    // Pretty-print so humans can grok it, but it's still valid
                    // JSON for agents that want to parse.
                    match serde_json::to_string_pretty(&data) {
                        Ok(s) => println!("{s}"),
                        Err(_) => println!("{data}"),
                    }
                }
                ExitCode::SUCCESS
            } else {
                let msg = resp.error.unwrap_or_else(|| "unknown error".into());
                eprintln!("cosmos: {msg}");
                ExitCode::from(1)
            }
        }
        Err(e) => {
            eprintln!("cosmos: {e}");
            ExitCode::from(1)
        }
    }
}

/// Reads what the app wrote to `~/.cosmos/web-url`. Deliberately file-based
/// rather than an IPC round-trip so it still answers while the app is busy.
fn web(link_only: bool) -> ExitCode {
    let path = home_dir().join(".cosmos").join("web-url");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        eprintln!("cosmos: web UI not running (no {})", path.display());
        return ExitCode::from(1);
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("cosmos: unreadable {}: {e}", path.display());
            return ExitCode::from(1);
        }
    };
    if link_only {
        let link = value
            .get("link")
            .and_then(|v| v.as_str())
            .or_else(|| value.get("local").and_then(|v| v.as_str()))
            .unwrap_or("");
        println!("{link}");
        return ExitCode::SUCCESS;
    }
    match serde_json::to_string_pretty(&value) {
        Ok(s) => println!("{s}"),
        Err(_) => println!("{value}"),
    }
    ExitCode::SUCCESS
}

fn build_request(cli: Cli) -> Result<Request, String> {
    Ok(match cli.cmd {
        Cmd::Web { .. } => unreachable!("handled in main"),
        Cmd::Project { cmd } => match cmd {
            ProjectCmd::Add {
                name,
                folders,
                memory,
                with_agent,
            } => Request::ProjectAdd {
                name,
                folders,
                memory,
                with_agent,
            },
            ProjectCmd::List => Request::ProjectList,
        },
        Cmd::Runner { cmd } => match cmd {
            RunnerCmd::Add {
                project,
                name,
                kind,
            } => {
                let project = resolve_project_handle(&project)?;
                Request::RunnerAdd {
                    project,
                    name,
                    kind: Some(kind),
                }
            }
            RunnerCmd::List { project } => {
                let project = match project {
                    Some(p) => Some(resolve_project_handle(&p)?),
                    None => None,
                };
                Request::RunnerList { project }
            }
        },
    })
}

/// `"."` means "the project this agent belongs to". The app injects
/// `COSMOS_PROJECT_SLUG` into every spawned PTY; if it's missing we tell the
/// user instead of guessing — silently picking some other project would be a
/// nasty footgun.
fn resolve_project_handle(handle: &str) -> Result<String, String> {
    if handle == "." {
        std::env::var("COSMOS_PROJECT_SLUG").map_err(|_| {
            "no $COSMOS_PROJECT_SLUG in env — pass --project <slug> explicitly".to_string()
        })
    } else {
        Ok(handle.to_string())
    }
}

/// HOME on Unix, USERPROFILE on Windows. Falls back to the current dir so
/// `default_socket_path` returns something usable rather than panicking.
fn home_dir() -> PathBuf {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var(var).map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."))
}

fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("COSMOS_SOCKET") {
        return PathBuf::from(p);
    }
    default_socket_path(&home_dir())
}

fn ipc_name(socket_path: &Path) -> Result<interprocess::local_socket::Name<'_>, String> {
    #[cfg(windows)]
    {
        let stem = socket_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| format!("invalid socket path {}", socket_path.display()))?;
        stem.to_ns_name::<GenericNamespaced>()
            .map_err(|e| format!("building named-pipe name: {e}"))
    }
    #[cfg(unix)]
    {
        socket_path
            .to_fs_name::<GenericFilePath>()
            .map_err(|e| format!("building unix-socket name: {e}"))
    }
}

fn send(req: Request) -> Result<Response, String> {
    let path = socket_path();
    let name = ipc_name(&path)?;
    let stream = Stream::connect(name).map_err(|e| {
        format!(
            "could not connect to Cosmos app at {} ({e}). Is Cosmos running?",
            path.display()
        )
    })?;
    let (recv, mut send) = stream.split();
    let body = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    send.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    send.write_all(b"\n").map_err(|e| e.to_string())?;
    send.flush().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(recv);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("reading response: {e}"))?;
    if line.trim().is_empty() {
        return Err("empty response from Cosmos app".into());
    }
    serde_json::from_str::<Response>(line.trim()).map_err(|e| format!("decoding response: {e}"))
}
