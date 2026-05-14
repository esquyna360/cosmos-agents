import { invoke } from "@tauri-apps/api/core";

export interface CliInfo {
  id: string;
  name: string;
  /// Short binary hint shown next to the name in the picker UI.
  hint: string;
  program: string;
  args: string[];
  /// True iff the binary was found on PATH at detection time.
  available: boolean;
}

export async function clisDetect(): Promise<CliInfo[]> {
  return await invoke<CliInfo[]>("clis_detect");
}

export async function clisGet(id: string): Promise<CliInfo | null> {
  const r = await invoke<CliInfo | null>("clis_get", { id });
  return r ?? null;
}
