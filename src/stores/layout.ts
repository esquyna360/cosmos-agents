import { createSignal } from "solid-js";

export type ViewMode = "terminal" | "editor" | "diff";

const VIEW_KEY = "cosmos.view";
const COMPOSER_KEY = "cosmos.composer.visible";
const WORKFLOW_KEY = "cosmos.workflow.open";

function readView(): ViewMode {
  const v = localStorage.getItem(VIEW_KEY);
  if (v === "editor" || v === "diff" || v === "terminal") return v;
  return "terminal";
}
function readBool(key: string, fallback: boolean): boolean {
  const v = localStorage.getItem(key);
  if (v === "1") return true;
  if (v === "0") return false;
  return fallback;
}

const [view, setViewRaw] = createSignal<ViewMode>(readView());
const [composerVisible, setComposerVisibleRaw] = createSignal<boolean>(
  readBool(COMPOSER_KEY, true),
);
const [workflowOpen, setWorkflowOpenRaw] = createSignal<boolean>(
  readBool(WORKFLOW_KEY, false),
);

export { view, composerVisible, workflowOpen };

export function setView(v: ViewMode): void {
  setViewRaw(v);
  localStorage.setItem(VIEW_KEY, v);
}

export function cycleView(): void {
  const order: ViewMode[] = ["terminal", "editor", "diff"];
  const i = order.indexOf(view());
  setView(order[(i + 1) % order.length]);
}

export function setComposerVisible(v: boolean): void {
  setComposerVisibleRaw(v);
  localStorage.setItem(COMPOSER_KEY, v ? "1" : "0");
}

export function toggleComposer(): void {
  setComposerVisible(!composerVisible());
}

export function setWorkflowOpen(v: boolean): void {
  setWorkflowOpenRaw(v);
  localStorage.setItem(WORKFLOW_KEY, v ? "1" : "0");
}

export function toggleWorkflow(): void {
  setWorkflowOpen(!workflowOpen());
}
