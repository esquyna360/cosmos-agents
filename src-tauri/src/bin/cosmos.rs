//! `cosmos` — tiny CLI client that talks to the running Cosmos app over a
//! Unix socket. Designed to be invoked from inside an agent's PTY (the app
//! injects `COSMOS_SOCKET` + `COSMOS_PROJECT_SLUG` into the env), so spawned
//! agents can register new projects/runners by running a shell command.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::ExitCode;

use agent_dashboard_lib::ipc::{default_socket_path, Request, Response};
use clap::{Parser, Subcommand};

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

fn build_request(cli: Cli) -> Result<Request, String> {
    Ok(match cli.cmd {
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

fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("COSMOS_SOCKET") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    default_socket_path(&PathBuf::from(home))
}

fn send(req: Request) -> Result<Response, String> {
    let path = socket_path();
    let mut stream = UnixStream::connect(&path).map_err(|e| {
        format!(
            "could not connect to Cosmos app at {} ({e}). Is Cosmos running?",
            path.display()
        )
    })?;
    let body = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    stream
        .write_all(body.as_bytes())
        .map_err(|e| e.to_string())?;
    stream.write_all(b"\n").map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("reading response: {e}"))?;
    if line.trim().is_empty() {
        return Err("empty response from Cosmos app".into());
    }
    serde_json::from_str::<Response>(line.trim()).map_err(|e| format!("decoding response: {e}"))
}
