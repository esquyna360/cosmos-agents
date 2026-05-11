import { createSignal, createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import { open } from "@tauri-apps/plugin-dialog";

import {
  agentsDelete,
  agentsList,
  agentsUpsert,
  ptyKill,
  ptyLiveIds,
  ptySpawn,
  type AgentRecord,
  type AgentStatus,
} from "../lib/ipc";
import { fsClaudeMd, fsDetectStack, type StackInfo } from "../lib/fs";

export interface AgentUI extends AgentRecord {
  /** Whether a PTY process is currently running for this agent. */
  live: boolean;
  status: AgentStatus;
  stacks: StackInfo[];
  claudeMd: string | null;
}

export interface ProjectView {
  cwd: string;
  displayName: string;
  agents: AgentUI[];
  collapsed: boolean;
  stacks: StackInfo[];
  claudeMd: string | null;
  promotedStatus: AgentStatus;
  promotedLive: boolean;
}

/* ------------------------------- persistence ----------------------------- */

const KEY_COLLAPSED = "cosmos.projects.collapsed";
const KEY_PROJECT_NAMES = "cosmos.projects.names";
const KEY_AGENT_NAMES = "cosmos.agents.names";

function readMap<T = unknown>(key: string): Record<string, T> {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") ?? {};
  } catch {
    return {};
  }
}
function writeMap(key: string, val: Record<string, unknown>) {
  localStorage.setItem(key, JSON.stringify(val));
}

const [collapsedMap, setCollapsedMap] = createSignal<Record<string, boolean>>(
  readMap<boolean>(KEY_COLLAPSED),
);
const [projectNames, setProjectNames] = createSignal<Record<string, string>>(
  readMap<string>(KEY_PROJECT_NAMES),
);
const [agentNames, setAgentNames] = createSignal<Record<string, string>>(
  readMap<string>(KEY_AGENT_NAMES),
);

const [pendingRename, setPendingRename] = createSignal<string | null>(null);
export const pendingRenameId = pendingRename;
export function consumePendingRename(id: string): void {
  if (pendingRename() === id) setPendingRename(null);
}

/* --------------------------------- helpers ------------------------------- */

function canonical(path: string): string {
  return path.replace(/\/+$/, "");
}

function basenameOf(path: string): string {
  const trimmed = canonical(path);
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

async function enrich(cwd: string): Promise<{ stacks: StackInfo[]; claudeMd: string | null }> {
  const [stacks, claudeMd] = await Promise.all([
    fsDetectStack(cwd).catch(() => [] as StackInfo[]),
    fsClaudeMd(cwd).catch(() => null),
  ]);
  return { stacks, claudeMd };
}

const STATUS_RANK: Record<AgentStatus, number> = {
  awaiting_input: 4,
  error: 3,
  streaming: 2,
  tool_running: 2,
  idle: 1,
};

/* ----------------------------- store + signals --------------------------- */

interface AgentsState {
  list: AgentUI[];
}

const [state, setState] = createStore<AgentsState>({ list: [] });
const [focusedId, setFocusedId] = createSignal<string | null>(null);
const [requestedOpenFile, setRequestedOpenFile] = createSignal<{
  path: string;
  line?: number;
} | null>(null);

export const agents = state;
export const focused = createMemo(() => state.list.find((a) => a.id === focusedId()) ?? null);
export const focusedAgentId = focusedId;
export const editorOpenRequest = requestedOpenFile;

/** Per-project view derived from the flat agent list. Newest project first. */
export const projects = createMemo<ProjectView[]>(() => {
  const seen = new Map<string, ProjectView>();
  for (const a of state.list) {
    const cwd = canonical(a.cwd);
    let p = seen.get(cwd);
    if (!p) {
      p = {
        cwd,
        displayName: projectNames()[cwd] ?? basenameOf(cwd),
        agents: [],
        collapsed: !!collapsedMap()[cwd],
        stacks: a.stacks,
        claudeMd: a.claudeMd,
        promotedStatus: "idle",
        promotedLive: false,
      };
      seen.set(cwd, p);
    }
    p.agents.push(a);
    if ((a.stacks?.length ?? 0) > (p.stacks?.length ?? 0)) p.stacks = a.stacks;
    if (a.claudeMd && !p.claudeMd) p.claudeMd = a.claudeMd;
  }
  for (const p of seen.values()) {
    let bestRank = 0;
    let bestStatus: AgentStatus = "idle";
    let anyLive = false;
    for (const a of p.agents) {
      if (a.live) anyLive = true;
      const r = STATUS_RANK[a.status];
      if (r > bestRank) {
        bestRank = r;
        bestStatus = a.status;
      }
    }
    p.promotedStatus = bestStatus;
    p.promotedLive = anyLive;
  }
  return Array.from(seen.values());
});

/* ----------------------------- name accessors ---------------------------- */

export function agentDisplayName(a: AgentUI): string {
  return agentNames()[a.id] ?? a.name;
}

export function renameAgent(id: string, name: string): void {
  const trimmed = name.trim();
  const next = { ...agentNames() };
  if (trimmed) next[id] = trimmed;
  else delete next[id];
  setAgentNames(next);
  writeMap(KEY_AGENT_NAMES, next);
}

export function renameProject(cwd: string, name: string): void {
  const key = canonical(cwd);
  const trimmed = name.trim();
  const next = { ...projectNames() };
  if (trimmed) next[key] = trimmed;
  else delete next[key];
  setProjectNames(next);
  writeMap(KEY_PROJECT_NAMES, next);
}

export function toggleProjectCollapsed(cwd: string): void {
  const key = canonical(cwd);
  const next = { ...collapsedMap(), [key]: !collapsedMap()[key] };
  setCollapsedMap(next);
  writeMap(KEY_COLLAPSED, next);
}

function setProjectCollapsed(cwd: string, collapsed: boolean): void {
  const key = canonical(cwd);
  if (!!collapsedMap()[key] === collapsed) return;
  const next = { ...collapsedMap(), [key]: collapsed };
  setCollapsedMap(next);
  writeMap(KEY_COLLAPSED, next);
}

/* ------------------------------- file open ------------------------------- */

export function openFileInEditor(path: string, line?: number): void {
  setRequestedOpenFile({ path, line });
}

/* --------------------------- loaders + mutators -------------------------- */

export async function loadFromDisk(): Promise<void> {
  const [persisted, live] = await Promise.all([agentsList(), ptyLiveIds()]);
  const liveSet = new Set(live);
  setState(
    "list",
    persisted.map((r) => ({
      ...r,
      live: liveSet.has(r.id),
      status: "idle" as AgentStatus,
      stacks: [] as StackInfo[],
      claudeMd: null as string | null,
    })),
  );
  if (state.list.length > 0 && focusedId() === null) {
    setFocusedId(state.list[0].id);
  }
  for (const a of state.list) {
    enrich(a.cwd).then(({ stacks, claudeMd }) => {
      setState(
        "list",
        (x) => x.id === a.id,
        (cur) => ({ ...cur, stacks, claudeMd }),
      );
    });
  }
}

export function setStatus(id: string, status: AgentStatus): void {
  const prev = state.list.find((a) => a.id === id)?.status;
  setState("list", (a) => a.id === id, "status", status);
  // Auto-expand the agent's project the first time it transitions into
  // awaiting_input so the user sees who needs them without hunting.
  if (status === "awaiting_input" && prev !== "awaiting_input") {
    const a = state.list.find((x) => x.id === id);
    if (a) setProjectCollapsed(a.cwd, false);
  }
}

const CLAUDE_PROGRAM = "/bin/zsh";
const CLAUDE_ARGS = [
  "-l",
  "-c",
  "exec env CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions",
];

export async function createAgent(
  cwd: string,
  opts?: { cols?: number; rows?: number; explicitName?: string },
): Promise<AgentUI> {
  const id = crypto.randomUUID();
  const name = basenameOf(cwd);
  const cols = opts?.cols ?? 100;
  const rows = opts?.rows ?? 30;

  const rec = await agentsUpsert(id, name, cwd);
  try {
    await ptySpawn({
      id,
      cwd,
      program: CLAUDE_PROGRAM,
      args: CLAUDE_ARGS,
      cols,
      rows,
    });
  } catch (e) {
    console.error("[cosmos] pty spawn failed, rolling back", e);
    await agentsDelete(id).catch(() => {});
    throw e;
  }

  const ui: AgentUI = { ...rec, live: true, status: "idle", stacks: [], claudeMd: null };
  setState("list", (list) => [ui, ...list]);
  setFocusedId(id);
  if (opts?.explicitName) renameAgent(id, opts.explicitName);
  enrich(cwd).then(({ stacks, claudeMd }) => {
    setState(
      "list",
      (a) => a.id === id,
      (cur) => ({ ...cur, stacks, claudeMd }),
    );
  });
  return ui;
}

/**
 * Spawns another agent in the same project. If the existing single agent in
 * that project still uses the default name, auto-rename it to "main" so the
 * new sibling has a distinct label. The new agent gets `agent-N` as default
 * (user can rename inline).
 */
export async function createSiblingAgent(cwd: string): Promise<AgentUI> {
  const key = canonical(cwd);
  const siblings = state.list.filter((a) => canonical(a.cwd) === key);
  if (siblings.length === 1) {
    const first = siblings[0];
    if (!agentNames()[first.id]) renameAgent(first.id, "main");
  }
  const fresh = await createAgent(cwd, {
    explicitName: `agent-${siblings.length + 1}`,
  });
  // Cue the new agent's row to auto-enter inline-rename mode.
  setPendingRename(fresh.id);
  return fresh;
}

export function focus(id: string): void {
  setFocusedId(id);
}

export function markLive(id: string, live: boolean): void {
  setState("list", (a) => a.id === id, "live", live);
}

export async function closeAgent(id: string): Promise<void> {
  try {
    await ptyKill(id);
  } catch (e) {
    console.error(e);
  }
  try {
    await agentsDelete(id);
  } catch (e) {
    console.error(e);
  }
  setState("list", (list) => list.filter((a) => a.id !== id));
  renameAgent(id, ""); // clear override if any
  if (focusedId() === id) {
    setFocusedId(state.list[0]?.id ?? null);
  }
}

export function focusByIndex(idx: number): void {
  const a = state.list[idx];
  if (a) setFocusedId(a.id);
}

export async function pickAndCreate(): Promise<void> {
  let picked: string | string[] | null;
  try {
    picked = await open({ directory: true, multiple: false });
  } catch (e) {
    console.error("[cosmos] dialog open failed", e);
    return;
  }
  if (typeof picked !== "string") return;
  try {
    await createAgent(picked);
  } catch (e) {
    console.error("[cosmos] createAgent threw", e);
  }
}
