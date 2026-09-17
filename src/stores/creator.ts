import { createSignal } from "solid-js";

export type CreatorState =
  /** Add a project: a folder and a name. */
  | { mode: "project" }
  /** Folders, memory and deletion of an existing project. */
  | { mode: "project"; editingProjectId: string }
  /** Add an agent, optionally with the project already picked. */
  | { mode: "agent"; projectId?: string };

const [state, setState] = createSignal<CreatorState | null>(null);
export const creator = state;

export function openCreator(s: CreatorState): void {
  setState(s);
}

export function closeCreator(): void {
  setState(null);
}
