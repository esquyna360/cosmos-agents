import { createMemo } from "solid-js";
import { createStore } from "solid-js/store";

import {
  workspacesCreate,
  workspacesDelete,
  workspacesList,
  workspacesUpdate,
  type Workspace,
} from "../lib/workspaces";

interface WorkspacesState {
  items: Workspace[];
}

const [state, setState] = createStore<WorkspacesState>({ items: [] });
export const workspaces = state;

/** Lookup by absolute cwd (the workspace's own dir under ~/.cosmos/workspaces). */
export const workspaceByCwd = createMemo(() => {
  const m = new Map<string, Workspace>();
  for (const w of state.items) m.set(canonical(w.cwd), w);
  return m;
});

/** Lookup by id. */
export const workspaceById = createMemo(() => {
  const m = new Map<string, Workspace>();
  for (const w of state.items) m.set(w.id, w);
  return m;
});

function canonical(p: string): string {
  return p.replace(/\/+$/, "");
}

export async function loadWorkspaces(): Promise<void> {
  try {
    const list = await workspacesList();
    setState("items", list);
  } catch (e) {
    console.error("[workspaces] load failed", e);
  }
}

export async function createWorkspace(
  name: string,
  folders: string[],
  memory: string,
): Promise<Workspace> {
  const w = await workspacesCreate(name, folders, memory);
  setState("items", (list) => [w, ...list]);
  return w;
}

export async function updateWorkspace(
  id: string,
  name: string,
  folders: string[],
  memory: string,
): Promise<Workspace> {
  const w = await workspacesUpdate(id, name, folders, memory);
  setState(
    "items",
    (it) => it.id === id,
    (cur) => ({ ...cur, ...w }),
  );
  return w;
}

export async function deleteWorkspace(id: string): Promise<void> {
  await workspacesDelete(id);
  setState("items", (list) => list.filter((w) => w.id !== id));
}
