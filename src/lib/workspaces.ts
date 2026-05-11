import { invoke } from "@tauri-apps/api/core";

export interface Workspace {
  id: string;
  name: string;
  folders: string[];
  memory: string;
  cwd: string;
  createdAt: number;
}

interface WorkspaceSnake {
  id: string;
  name: string;
  folders: string[];
  memory: string;
  cwd: string;
  created_at: number;
}

function toCamel(r: WorkspaceSnake): Workspace {
  return {
    id: r.id,
    name: r.name,
    folders: r.folders,
    memory: r.memory,
    cwd: r.cwd,
    createdAt: r.created_at,
  };
}

export async function workspacesList(): Promise<Workspace[]> {
  const rows = await invoke<WorkspaceSnake[]>("workspaces_list");
  return rows.map(toCamel);
}

export async function workspacesCreate(
  name: string,
  folders: string[],
  memory: string,
): Promise<Workspace> {
  const r = await invoke<WorkspaceSnake>("workspaces_create", { name, folders, memory });
  return toCamel(r);
}

export async function workspacesUpdate(
  id: string,
  name: string,
  folders: string[],
  memory: string,
): Promise<Workspace> {
  const r = await invoke<WorkspaceSnake>("workspaces_update", { id, name, folders, memory });
  return toCamel(r);
}

export function workspacesDelete(id: string): Promise<void> {
  return invoke("workspaces_delete", { id });
}
