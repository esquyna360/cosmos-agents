import { invoke } from "@tauri-apps/api/core";

export type Tier = "deep" | "work" | "cheap";

export interface Model {
  id: string;
  label: string;
  tier: Tier;
}

export interface Provider {
  id: string;
  name: string;
  base_url: string;
  key_file: string;
  models: Model[];
  available: boolean;
}

export interface Candidate {
  project: string;
  projectName: string;
  runnerId: string;
  runnerName: string;
  status: string;
  live: boolean;
  score: number;
  reasons: string[];
}

export interface ModelPick {
  provider: string;
  model: string;
  label: string;
  tier: Tier;
  reason: string;
}

export interface Suggestion {
  action: "send" | "spawn" | "self";
  summary: string;
  command: string;
  model: ModelPick;
  candidates: Candidate[];
}

export function modelsList(): Promise<Provider[]> {
  return invoke<Provider[]>("models_list");
}

export function routeSuggest(task: string): Promise<Suggestion> {
  return invoke<Suggestion>("route_suggest", { task });
}

/** Types a message into an agent; a stopped one wakes up on its session. */
export function runnerSend(id: string, message: string): Promise<{ woke?: boolean }> {
  return invoke("runner_send", { id, message });
}
