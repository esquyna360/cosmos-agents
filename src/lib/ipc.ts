import { invoke, Channel } from "@tauri-apps/api/core";

export type AgentStatus =
  | "idle"
  | "streaming"
  | "awaiting_input"
  | "tool_running"
  | "error";

export interface AgentRecord {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  lastActive: number;
}

interface AgentRecordSnake {
  id: string;
  name: string;
  cwd: string;
  created_at: number;
  last_active: number;
}

function toCamel(r: AgentRecordSnake): AgentRecord {
  return {
    id: r.id,
    name: r.name,
    cwd: r.cwd,
    createdAt: r.created_at,
    lastActive: r.last_active,
  };
}

export interface SpawnOpts {
  id: string;
  cwd: string;
  program: string;
  args: string[];
  cols: number;
  rows: number;
}

export function ptySpawn(opts: SpawnOpts): Promise<void> {
  return invoke("pty_spawn", opts as unknown as Record<string, unknown>);
}

export async function ptyAttach(
  id: string,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  const output = new Channel<unknown>();
  output.onmessage = (msg: unknown) => {
    if (msg instanceof ArrayBuffer) {
      onChunk(new Uint8Array(msg));
    } else if (msg instanceof Uint8Array) {
      onChunk(msg);
    } else if (Array.isArray(msg)) {
      onChunk(new Uint8Array(msg as number[]));
    }
  };
  await invoke("pty_attach", { id, output });
}

export function ptyDetach(id: string): Promise<void> {
  return invoke("pty_detach", { id });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

export function ptyLiveIds(): Promise<string[]> {
  return invoke("pty_live_ids");
}

export function debugLog(msg: string): void {
  invoke("debug_log", { msg }).catch(() => {});
}

export async function agentsList(): Promise<AgentRecord[]> {
  const rows = await invoke<AgentRecordSnake[]>("agents_list");
  return rows.map(toCamel);
}

export async function agentsUpsert(
  id: string,
  name: string,
  cwd: string,
): Promise<AgentRecord> {
  const r = await invoke<AgentRecordSnake>("agents_upsert", { id, name, cwd });
  return toCamel(r);
}

export function agentsDelete(id: string): Promise<void> {
  return invoke("agents_delete", { id });
}
