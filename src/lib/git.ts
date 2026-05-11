import { invoke } from "@tauri-apps/api/core";

export function gitDiff(cwd: string): Promise<string> {
  return invoke("git_diff", { cwd });
}
