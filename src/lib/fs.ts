import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface DirEntrySnake {
  name: string;
  path: string;
  is_dir: boolean;
}

export async function fsReadDir(path: string): Promise<DirEntry[]> {
  const rows = await invoke<DirEntrySnake[]>("fs_read_dir", { path });
  return rows.map((r) => ({ name: r.name, path: r.path, isDir: r.is_dir }));
}

export function fsReadFile(path: string): Promise<string> {
  return invoke("fs_read_file", { path });
}

export function fsWriteFile(path: string, content: string): Promise<void> {
  return invoke("fs_write_file", { path, content });
}

export function fsWalk(root: string): Promise<string[]> {
  return invoke("fs_walk", { root });
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export function fsGrep(root: string, query: string): Promise<GrepMatch[]> {
  return invoke("fs_grep", { root, query });
}

export interface StackInfo {
  label: string;
  color: string;
}

export function fsDetectStack(cwd: string): Promise<StackInfo[]> {
  return invoke("fs_detect_stack", { cwd });
}

export function fsClaudeMd(cwd: string): Promise<string | null> {
  return invoke("fs_claude_md", { cwd });
}

/** Upload pasted image bytes via raw IPC body. Returns the temp file path. */
export function fsSaveTempImage(bytes: Uint8Array, ext: string): Promise<string> {
  return invoke("fs_save_temp_image", bytes, {
    headers: { "X-Ext": ext },
  });
}
