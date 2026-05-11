import { createSignal } from "solid-js";

import type { Workspace } from "../lib/workspaces";

export interface CreatorState {
  mode: "agent" | "workspace";
  editing?: Workspace;
}

const [state, setState] = createSignal<CreatorState | null>(null);
export const creator = state;

export function openCreator(s: CreatorState): void {
  setState(s);
}

export function closeCreator(): void {
  setState(null);
}
