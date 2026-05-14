import { createSignal } from "solid-js";

export interface CreatorState {
  mode: "project";
  /** Edit-mode flag — load existing project's name/folders/memory. */
  editingProjectId?: string;
}

const [state, setState] = createSignal<CreatorState | null>(null);
export const creator = state;

export function openCreator(s: CreatorState): void {
  setState(s);
}

export function closeCreator(): void {
  setState(null);
}
