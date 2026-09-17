import { invoke } from "@tauri-apps/api/core";

import type { AgentStatus } from "./ipc";

export type RunnerKind = "agent" | "shell";
/// How an agent is driven: native chat over stream-json, or the CLI's own TUI.
export type RunnerMode = "chat" | "tty";

/// Wire shape — superset of AgentStatus with shell-only lifecycle states.
export type RunnerStatus = AgentStatus | "running" | "exited";

export interface Project {
  id: string;
  name: string;
  /// Filesystem-safe handle (`slugify(name) + -N` dedupe). Sticky: generated
  /// at create time, doesn't change on rename. Powers
  /// `~/.cosmos/projects/<slug>/` paths.
  slug: string;
  folders: string[];
  memory: string;
  cwd: string;
  createdAt: number;
}

export interface Runner {
  id: string;
  projectId: string;
  kind: RunnerKind;
  name: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  withStatusFsm: boolean;
  createdAt: number;
  lastActive: number;
  /// Claude session UUID this runner resumes into. Empty for shells.
  sessionId: string;
  mode: RunnerMode;
  /// The name was machine-written and may be replaced by an auto-title.
  nameAuto: boolean;
}

interface ProjectSnake {
  id: string;
  name: string;
  slug: string;
  folders: string[];
  memory: string;
  cwd: string;
  created_at: number;
}

interface RunnerSnake {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  program: string;
  args: string[];
  env: Record<string, string>;
  with_status_fsm: boolean;
  created_at: number;
  last_active: number;
  session_id: string;
  mode?: string;
  name_auto?: boolean;
}

function projectFromSnake(r: ProjectSnake): Project {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    folders: r.folders,
    memory: r.memory,
    cwd: r.cwd,
    createdAt: r.created_at,
  };
}

function runnerFromSnake(r: RunnerSnake): Runner {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: (r.kind === "shell" ? "shell" : "agent") as RunnerKind,
    name: r.name,
    program: r.program,
    args: r.args,
    env: r.env,
    withStatusFsm: r.with_status_fsm,
    createdAt: r.created_at,
    lastActive: r.last_active,
    sessionId: r.session_id ?? "",
    mode: r.mode === "chat" ? "chat" : "tty",
    nameAuto: !!r.name_auto,
  };
}

export async function projectsList(): Promise<Project[]> {
  const rows = await invoke<ProjectSnake[]>("projects_list");
  return rows.map(projectFromSnake);
}

export async function projectsCreate(
  name: string,
  folders: string[],
  memory: string,
): Promise<Project> {
  const r = await invoke<ProjectSnake>("projects_create", { name, folders, memory });
  return projectFromSnake(r);
}

export async function projectsUpdate(
  id: string,
  name: string,
  folders: string[],
  memory: string,
): Promise<Project> {
  const r = await invoke<ProjectSnake>("projects_update", { id, name, folders, memory });
  return projectFromSnake(r);
}

export function projectsDelete(id: string): Promise<void> {
  return invoke("projects_delete", { id });
}

export async function runnersList(): Promise<Runner[]> {
  const rows = await invoke<RunnerSnake[]>("runners_list");
  return rows.map(runnerFromSnake);
}

export async function runnersCreate(opts: {
  projectId: string;
  kind: RunnerKind;
  name: string;
  program?: string;
  args?: string[];
  env?: Record<string, string>;
  mode?: RunnerMode;
  nameAuto?: boolean;
}): Promise<Runner> {
  const r = await invoke<RunnerSnake>("runners_create", {
    mode: opts.mode ?? null,
    nameAuto: opts.nameAuto ?? false,
    projectId: opts.projectId,
    kind: opts.kind,
    name: opts.name,
    program: opts.program ?? null,
    args: opts.args ?? null,
    env: opts.env ?? null,
  });
  return runnerFromSnake(r);
}

/// `auto` marks a machine-written title, which a later auto-title may replace.
export function runnersUpdate(id: string, name: string, auto = false): Promise<void> {
  return invoke("runners_update", { id, name, auto });
}

export function runnersSetMode(id: string, mode: RunnerMode): Promise<void> {
  return invoke("runners_set_mode", { id, mode });
}

/// Removes the runner row for good. Only reachable behind an explicit
/// confirm — the close button stops instead.
export function runnersDelete(id: string): Promise<void> {
  return invoke("runners_delete", { id });
}

/// Kills the PTY, keeps the row. The conversation stays resumable.
export function runnersStop(id: string): Promise<void> {
  return invoke("runners_stop", { id });
}

/// Mints a fresh session handle so the next spawn starts a clean thread.
export function runnersResetSession(id: string): Promise<void> {
  return invoke("runners_reset_session", { id });
}

/// Stops every runner in a project without deleting anything.
export function projectsClose(id: string): Promise<void> {
  return invoke("projects_close", { id });
}

export function ptyKillProject(projectId: string): Promise<void> {
  return invoke("pty_kill_project", { projectId });
}

/** Only Claude Code sessions can be shown as a chat; other CLIs are TUIs. */
export function isClaudeRunner(r: { kind: RunnerKind; args: string[] }): boolean {
  return r.kind === "agent" && r.args.some((a) => a.includes("claude --dangerously-skip-permissions"));
}

/** Opens a folder in Finder, or in the named app ("Visual Studio Code"). */
export function openPath(path: string, app?: string): Promise<void> {
  return invoke("open_path", { path, app: app ?? null });
}
