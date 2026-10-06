import { invoke } from "@tauri-apps/api/core";

/** A stretch of terminal cells sharing a style. `c` is an ANSI index
 *  ("0".."15") or a hex color. */
export interface Run {
  t: string;
  c?: string;
  b?: boolean;
  d?: boolean;
}

export interface Snapshot {
  id: string;
  ver: number;
  cols: number;
  lines: Run[][];
}

export interface Vitals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number;
  costUsd: number;
  model: string;
  title: string;
  last: string;
}

/** Bottom `rows` of each live PTY's screen; unchanged ones are left out. */
export function ptyScreens(ids: string[], rows: number, seen: Record<string, number>): Promise<Snapshot[]> {
  return invoke("pty_screens", { ids, rows, seen });
}

export function runnersVitals(): Promise<Record<string, Vitals>> {
  return invoke("runners_vitals");
}
