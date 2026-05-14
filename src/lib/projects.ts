import { invoke } from "@tauri-apps/api/core";

import type { AgentStatus } from "./ipc";

export type RunnerKind = "agent" | "shell";

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
}): Promise<Runner> {
  const r = await invoke<RunnerSnake>("runners_create", {
    projectId: opts.projectId,
    kind: opts.kind,
    name: opts.name,
    program: opts.program ?? null,
    args: opts.args ?? null,
    env: opts.env ?? null,
  });
  return runnerFromSnake(r);
}

export function runnersUpdate(id: string, name: string): Promise<void> {
  return invoke("runners_update", { id, name });
}

export function runnersDelete(id: string): Promise<void> {
  return invoke("runners_delete", { id });
}

export function ptyKillProject(projectId: string): Promise<void> {
  return invoke("pty_kill_project", { projectId });
}
