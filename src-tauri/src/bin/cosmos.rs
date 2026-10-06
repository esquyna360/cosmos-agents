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
    /// The remote web UI: where it answers (local network and Cloudflare
    /// tunnel) and who may use it. The tunnel URL rotates on every reconnect,
    /// so this is the way to get the current one. A browser gets in by
    /// typing a pairing code: `cosmos web pair`.
    Web {
        #[command(subcommand)]
        cmd: Option<WebCmd>,
        /// Print only the address to open (the tunnel, else the local network).
        #[arg(long)]
        link: bool,
    },
    /// Every project with its runners: status, model, who delegated it and
    /// the last thing it said.
    Status,
    /// Where a task should go: an existing agent, a new one in the right
    /// project, or nowhere (answer it yourself), and on which model. Prints
    /// the ranked candidates with reasons and a ready-to-run command.
    Route {
        /// The task, in plain words.
        task: Vec<String>,
    },
    /// Providers and models an agent can run on, and which have their key.
    Models,
    /// The second brain: every agent memory, CLAUDE.md, guideline and dev
    /// log as one vault of linked notes. Search before you start, write down
    /// what the next agent will need.
    Brain {
        #[command(subcommand)]
        cmd: BrainCmd,
        /// Print the raw JSON instead of text.
        #[arg(long, global = true)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum WebCmd {
    /// A fresh six-digit pairing code, good for five minutes and one
    /// browser. Give it only to the person who asked.
    Pair,
    /// Browsers that hold a session.
    Devices,
    /// End one browser's session.
    Revoke { id: String },
}

#[derive(Subcommand)]
enum BrainCmd {
    /// Find notes. Every word must appear; `tag:x` and `fonte:memory`
    /// (memory, claude, guideline, devlog, project, note) narrow it down.
    Search {
        query: Vec<String>,
        #[arg(long, default_value_t = 12)]
        limit: usize,
    },
    /// Print a note, then what links to it and what it links to. NOTE is a
    /// name (as in `[[name]]`), a title or a path.
    Read { note: String },
    /// Only the links of a note: who mentions it and what it mentions.
    Links { note: String },
    /// Every note, newest first.
    List {
        /// memory, claude, guideline, devlog, project or note.
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        tag: Option<String>,
    },
    /// Write a new note in ~/.cosmos/brain. Link others with `[[name]]`.
    New {
        title: String,
        /// The Markdown body. `-` (or nothing) reads it from stdin.
        #[arg(long)]
        body: Option<String>,
        /// Repeat for more than one.
        #[arg(long = "tag")]
        tags: Vec<String>,
        /// One line saying when this note matters.
        #[arg(long, default_value = "")]
        description: String,
    },
    /// Add text to the end of an existing note.
    Append {
        note: String,
        /// The text. `-` (or nothing) reads it from stdin.
        text: Option<String>,
    },
}

enum Out {
    Json,
    Hits,
    Note { links_only: bool },
    Notes { source: Option<String>, tag: Option<String> },
    Saved,
}

fn output_of(cmd: &Cmd) -> Out {
    match cmd {
        Cmd::Brain { json: false, cmd } => match cmd {
            BrainCmd::Search { .. } => Out::Hits,
            BrainCmd::Read { .. } => Out::Note { links_only: false },
            BrainCmd::Links { .. } => Out::Note { links_only: true },
            BrainCmd::List { source, tag } => Out::Notes { source: source.clone(), tag: tag.clone() },
            BrainCmd::New { .. } | BrainCmd::Append { .. } => Out::Saved,
        },
        _ => Out::Json,
    }
}

fn text_or_stdin(given: Option<String>) -> Result<String, String> {
    match given {
        Some(text) if text != "-" => Ok(text),
        _ => {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut text).map_err(|e| format!("cosmos: reading stdin: {e}"))?;
            Ok(text)
        }
    }
}

fn s<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

fn print_mentions(heading: &str, list: Option<&serde_json::Value>) {
    let Some(list) = list.and_then(|l| l.as_array()).filter(|l| !l.is_empty()) else { return };
    println!("\n{heading} ({})", list.len());
    for m in list {
        println!("- {}  [{}]  {}", s(m, "title"), s(m, "source"), s(m, "id"));
        if !s(m, "context").is_empty() {
            println!("    {}", s(m, "context"));
        }
    }
}

fn print_brain(out: &Out, data: &serde_json::Value) {
    match out {
        Out::Json => {}
        Out::Hits => {
            let hits = data.as_array().cloned().unwrap_or_default();
            if hits.is_empty() {
                println!("nenhuma nota. Tente menos palavras, ou `cosmos brain list`.");
            }
            for h in &hits {
                println!("{}  [{} · {}]", s(h, "title"), s(h, "source"), s(h, "group"));
                println!("    {}", s(h, "id"));
                if !s(h, "snippet").is_empty() {
                    println!("    {}", s(h, "snippet"));
                }
            }
        }
        Out::Note { links_only } => {
            let note = &data["note"];
            if !links_only {
                println!("# {}  [{} · {}]\n# {}\n", s(note, "title"), s(note, "source"), s(note, "group"), s(note, "id"));
                println!("{}", s(data, "content").trim_end());
            }
            print_mentions("Quem cita esta nota", data.get("backlinks"));
            print_mentions("O que esta nota cita", data.get("outgoing"));
            if let Some(dangling) = note["dangling"].as_array().filter(|d| !d.is_empty()) {
                let names: Vec<&str> = dangling.iter().filter_map(|d| d.as_str()).collect();
                println!("\nLinks sem nota: {}", names.join(", "));
            }
        }
        Out::Notes { source, tag } => {
            let mut notes = data["notes"].as_array().cloned().unwrap_or_default();
            notes.retain(|n| {
                let by_source = source.as_deref().is_none_or(|want| s(n, "source") == want);
                let by_tag = tag.as_deref().is_none_or(|want| {
                    n["tags"].as_array().is_some_and(|tags| tags.iter().any(|t| t.as_str() == Some(want)))
                });
                by_source && by_tag
            });
            notes.sort_by_key(|n| std::cmp::Reverse(n["modified"].as_i64().unwrap_or(0)));
            for n in &notes {
                println!("{}  [{} · {}]  {}", s(n, "name"), s(n, "source"), s(n, "group"), s(n, "id"));
            }
            println!("{} notas", notes.len());
        }
        Out::Saved => println!("salvo: {}  ({})", s(data, "name"), s(data, "id")),
    }
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
        /// First message for the --with-agent agent.
        #[arg(long)]
        task: Option<String>,
        /// Model for the --with-agent agent (see `cosmos models`).
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        provider: Option<String>,
    },
    List,
    /// Delete a project, its runners and its resumable sessions. The
    /// project's `~/.cosmos/projects/<slug>/` dir moves to `~/.cosmos/.trash/`;
    /// the working folders on disk are never touched.
    Rm {
        /// Project slug. `.` resolves to $COSMOS_PROJECT_SLUG — which for an
        /// agent means deleting the project it is running inside.
        #[arg(long)]
        project: String,
        /// Required. Without it the command refuses and explains itself.
        #[arg(long)]
        yes: bool,
    },
    /// Sweep `~/.cosmos/projects/` dirs left behind by already-deleted
    /// projects into the trash. Without --yes it only lists them.
    Prune {
        #[arg(long)]
        yes: bool,
    },
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
        /// What the agent should do. Sent as its first message.
        #[arg(long)]
        task: Option<String>,
        /// Give the agent its own git worktree on a `cosmos/<name>` branch
        /// instead of the project's checkout.
        #[arg(long)]
        worktree: bool,
        /// Start the agent in a terminal instead of the chat.
        #[arg(long)]
        tty: bool,
        /// Model: `opus` (architecture, decisions), `sonnet` (execution),
        /// `haiku`, or a provider's model such as `deepseek-flash`.
        #[arg(long)]
        model: Option<String>,
        /// Provider id from `cosmos models`. Inferred from --model when the
        /// model belongs to one.
        #[arg(long)]
        provider: Option<String>,
    },
    List {
        #[arg(long)]
        project: Option<String>,
    },
    /// Delete a runner: kills its process and drops the row, session and
    /// Cosmos-made worktree included (the branch stays).
    Rm {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        yes: bool,
    },
    /// Send a message to an agent, as if typed by the user.
    Send {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        message: String,
    },
    /// Kill the runner's process. The runner and its session stay.
    Stop {
        #[command(flatten)]
        target: Target,
    },
    Rename {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        to: String,
    },
    /// Change the model or provider. Applies on the runner's next start.
    Set {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        provider: Option<String>,
    },
    /// Read the last turns of an agent's conversation without opening it.
    Peek {
        #[command(flatten)]
        target: Target,
        /// How many turns, newest last.
        #[arg(long, default_value_t = 6)]
        turns: usize,
    },
}

#[derive(clap::Args)]
struct Target {
    /// Project the runner lives in. `.` = $COSMOS_PROJECT_SLUG.
    #[arg(long, default_value = ".")]
    project: String,
    /// Runner name. Ambiguous names are refused — use --id instead.
    #[arg(long)]
    name: Option<String>,
    /// Runner id, when the name is ambiguous or unknown.
    #[arg(long)]
    id: Option<String>,
}

impl Target {
    /// `(project, name, id)` as the app expects them. Only a name needs a
    /// project to disambiguate against.
    fn resolve(self) -> Result<(Option<String>, Option<String>, Option<String>), String> {
        if self.name.is_none() && self.id.is_none() {
            return Err("cosmos: pass --name or --id".into());
        }
        let project = match self.name {
            Some(_) => Some(resolve_project_handle(&self.project)?),
            None => None,
        };
        Ok((project, self.name, self.id))
    }
}


fn main() -> ExitCode {
    let cli = Cli::parse();
    if let Cmd::Web { cmd: None, link } = cli.cmd {
        return web(link);
    }
    let out = output_of(&cli.cmd);
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
                if let (false, Some(data)) = (matches!(out, Out::Json), &resp.data) {
                    print_brain(&out, data);
                } else if let Some(data) = resp.data {
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
        Cmd::Web { cmd: None, .. } => unreachable!("handled in main"),
        Cmd::Web { cmd: Some(WebCmd::Pair), .. } => Request::WebPair,
        Cmd::Web { cmd: Some(WebCmd::Devices), .. } => Request::WebDevices,
        Cmd::Web { cmd: Some(WebCmd::Revoke { id }), .. } => Request::WebRevoke { id },
        Cmd::Status => Request::Status,
        Cmd::Models => Request::Models,
        Cmd::Brain { cmd, .. } => match cmd {
            BrainCmd::Search { query, limit } => {
                let query = query.join(" ");
                if query.trim().is_empty() {
                    return Err("cosmos: `brain search` needs words: cosmos brain search <o que procurar>".into());
                }
                Request::BrainSearch { query, limit: Some(limit) }
            }
            BrainCmd::Read { note } | BrainCmd::Links { note } => Request::BrainRead { note },
            BrainCmd::List { .. } => Request::BrainList,
            BrainCmd::New { title, body, tags, description } => {
                Request::BrainNew { title, body: text_or_stdin(body)?, tags, description }
            }
            BrainCmd::Append { note, text } => Request::BrainAppend { note, text: text_or_stdin(text)? },
        },
        Cmd::Route { task } => {
            let task = task.join(" ");
            if task.trim().is_empty() {
                return Err("cosmos: `route` needs the task: cosmos route \"<o que fazer>\"".into());
            }
            Request::Route { task }
        }
        Cmd::Project { cmd } => match cmd {
            ProjectCmd::Add {
                name,
                folders,
                memory,
                with_agent,
                task,
                model,
                provider,
            } => Request::ProjectAdd {
                name,
                folders,
                memory,
                with_agent,
                task,
                model,
                provider,
                parent: caller_runner(),
            },
            ProjectCmd::List => Request::ProjectList,
            ProjectCmd::Rm { project, yes } => {
                if !yes {
                    return Err(
                        "cosmos: `project rm` deletes the project, every runner in it and \
their resumable sessions. Re-run with --yes if that is what you want."
                            .into(),
                    );
                }
                let project = resolve_project_handle(&project)?;
                Request::ProjectRemove { project }
            }
            ProjectCmd::Prune { yes } => Request::ProjectPrune { dry_run: !yes },
        },
        Cmd::Runner { cmd } => match cmd {
            RunnerCmd::Add {
                project,
                name,
                kind,
                task,
                worktree,
                tty,
                model,
                provider,
            } => {
                let project = resolve_project_handle(&project)?;
                Request::RunnerAdd {
                    project,
                    name,
                    kind: Some(kind),
                    task,
                    worktree,
                    tty,
                    model,
                    provider,
                    parent: caller_runner(),
                }
            }
            RunnerCmd::List { project } => {
                let project = match project {
                    Some(p) => Some(resolve_project_handle(&p)?),
                    None => None,
                };
                Request::RunnerList { project }
            }
            RunnerCmd::Rm { target, yes } => {
                if !yes {
                    return Err(
                        "cosmos: `runner rm` kills the runner and throws its session away. \
Re-run with --yes if that is what you want."
                            .into(),
                    );
                }
                let (project, name, id) = target.resolve()?;
                Request::RunnerRemove { project, name, id }
            }
            RunnerCmd::Send { target, message } => {
                let (project, name, id) = target.resolve()?;
                Request::RunnerSend {
                    project,
                    name,
                    id,
                    message,
                    from: caller_runner(),
                }
            }
            RunnerCmd::Stop { target } => {
                let (project, name, id) = target.resolve()?;
                Request::RunnerStop { project, name, id }
            }
            RunnerCmd::Set { target, model, provider } => {
                if model.is_none() && provider.is_none() {
                    return Err("cosmos: pass --model and/or --provider".into());
                }
                let (project, name, id) = target.resolve()?;
                Request::RunnerSet { project, name, id, model, provider }
            }
            RunnerCmd::Peek { target, turns } => {
                let (project, name, id) = target.resolve()?;
                Request::RunnerPeek { project, name, id, turns: Some(turns) }
            }
            RunnerCmd::Rename { target, to } => {
                let (project, name, id) = target.resolve()?;
                Request::RunnerRename {
                    project,
                    name,
                    id,
                    to,
                }
            }
        },
    })
}

/// The runner this CLI is being run from, so what it creates records who
/// delegated it.
fn caller_runner() -> Option<String> {
    std::env::var("COSMOS_RUNNER_ID").ok().filter(|v| !v.is_empty())
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
