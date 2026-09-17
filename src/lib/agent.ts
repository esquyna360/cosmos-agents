import { invoke } from "@tauri-apps/api/core";

export interface AgentLine {
  runnerId: string;
  seq: number;
  line: string;
}

export interface SessionTitle {
  /** Set by a person: `/rename`, `--name`, a rename from Cosmos. */
  custom: string | null;
  /** Written by Claude after the first prompt. */
  ai: string | null;
}

export function agentStart(
  id: string,
  cwd: string,
  model: string | null,
  permissionMode: string,
): Promise<void> {
  return invoke("agent_start", { id, cwd, model, permissionMode });
}

export function agentSend(id: string, line: string): Promise<void> {
  return invoke("agent_send", { id, line });
}

export function agentSnapshot(id: string, after: number): Promise<AgentLine[]> {
  return invoke("agent_snapshot", { id, after });
}

export function agentHistory(id: string, cwd: string): Promise<string[]> {
  return invoke("agent_history", { id, cwd });
}

export function agentKill(id: string): Promise<void> {
  return invoke("agent_kill", { id });
}

export function sessionTitleGet(id: string, cwd: string): Promise<SessionTitle> {
  return invoke("session_title_get", { id, cwd });
}

/** Resolves false when a live process owns the session and the transcript
 *  was left alone. */
export function sessionTitleSet(id: string, cwd: string, title: string): Promise<boolean> {
  return invoke("session_title_set", { id, cwd, title });
}
