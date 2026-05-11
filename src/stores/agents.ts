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

async function enrich(cwd: string): Promise<{ stacks: StackInfo[]; claudeMd: string | null }> {
  const [stacks, claudeMd] = await Promise.all([
    fsDetectStack(cwd).catch(() => [] as StackInfo[]),
    fsClaudeMd(cwd).catch(() => null),
  ]);
  return { stacks, claudeMd };
}

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

export function openFileInEditor(path: string, line?: number): void {
  setRequestedOpenFile({ path, line });
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

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
  // Enrich each agent with stack + CLAUDE.md asynchronously — non-blocking.
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
  setState("list", (a) => a.id === id, "status", status);
}

/**
 * Spawns the user's login shell, sources profile (so PATH is right), then execs
 * claude inline with the no-flicker env var. exec replaces the shell so the
 * terminal sees a single process tree, not a shell wrapping claude.
 */
const CLAUDE_PROGRAM = "/bin/zsh";
const CLAUDE_ARGS = [
  "-l",
  "-c",
  "exec env CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions",
];

export async function createAgent(cwd: string, opts?: { cols?: number; rows?: number }): Promise<AgentUI> {
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
  enrich(cwd).then(({ stacks, claudeMd }) => {
    setState(
      "list",
      (a) => a.id === id,
      (cur) => ({ ...cur, stacks, claudeMd }),
    );
  });
  return ui;
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
