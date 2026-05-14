import { invoke, Channel } from "@tauri-apps/api/core";

export type AgentStatus =
  | "idle"
  | "streaming"
  | "awaiting_input"
  | "tool_running"
  | "error";

export interface SpawnOpts {
  id: string;
  cwd: string;
  program: string;
  args: string[];
  cols: number;
  rows: number;
  /** Routes events back to the right project on the runner-status channel. */
  projectId?: string;
  /** "agent" | "shell". Defaults to "agent" server-side. */
  kind?: "agent" | "shell";
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
