import { createSignal } from "solid-js";

export type ViewMode = "runners" | "editor" | "diff" | "memory";

const VIEW_KEY = "cosmos.view";
const COMPOSER_KEY = "cosmos.composer.visible";
const WORKFLOW_KEY = "cosmos.workflow.open";

function readView(): ViewMode {
  const v = localStorage.getItem(VIEW_KEY);
  // Legacy value "terminal" maps to the new default. Cleanup of the stored
  // key happens in projects.ts::migrateLegacyLocalStorage (v3 stamp).
  if (v === "terminal") return "runners";
  if (v === "editor" || v === "diff" || v === "memory" || v === "runners") return v;
  return "runners";
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

const SECONDARY_KEY = "cosmos.split.secondaryAgentId";
const SPLIT_WIDTH_KEY = "cosmos.split.width";
const SIDEBAR_WIDTH_KEY = "cosmos.sidebar.width";

const [secondaryAgentId, setSecondaryAgentIdRaw] = createSignal<string | null>(
  localStorage.getItem(SECONDARY_KEY),
);
const [splitWidthPct, setSplitWidthPctRaw] = createSignal<number>(
  Number(localStorage.getItem(SPLIT_WIDTH_KEY)) || 38,
);
const [sidebarWidthPx, setSidebarWidthPxRaw] = createSignal<number>(
  Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || 240,
);

// Toggled from InputBar when the textarea gains/loses focus. App reads it to
// hide the terminal so the composer can claim the full pane height.
const [composerExpanded, setComposerExpandedRaw] = createSignal<boolean>(false);

export {
  view,
  composerVisible,
  workflowOpen,
  secondaryAgentId,
  splitWidthPct,
  sidebarWidthPx,
  composerExpanded,
};

export function setComposerExpanded(v: boolean): void {
  setComposerExpandedRaw(v);
}

export function setView(v: ViewMode): void {
  setViewRaw(v);
  localStorage.setItem(VIEW_KEY, v);
}

export function cycleView(): void {
  const order: ViewMode[] = ["runners", "editor", "diff", "memory"];
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

export function setSecondaryAgent(id: string | null): void {
  setSecondaryAgentIdRaw(id);
  if (id) localStorage.setItem(SECONDARY_KEY, id);
  else localStorage.removeItem(SECONDARY_KEY);
}

export function togglePinSecondary(id: string): void {
  setSecondaryAgent(secondaryAgentId() === id ? null : id);
}

/**
 * Pinning an agent that is currently focused would render the same terminal
 * on both sides — instead, pin it AND focus a different agent so the split
 * becomes visible immediately. The caller passes the focused id and a
 * fallback (next-other-agent) id.
 */
export function smartPin(
  pinId: string,
  focusedId: string | null,
  fallbackFocusId: string | null,
  setFocus: (id: string) => void,
): void {
  if (secondaryAgentId() === pinId) {
    setSecondaryAgent(null);
    return;
  }
  setSecondaryAgent(pinId);
  if (pinId === focusedId && fallbackFocusId) {
    setFocus(fallbackFocusId);
  }
}

export function setSplitWidthPct(pct: number): void {
  const clamped = Math.max(20, Math.min(70, pct));
  setSplitWidthPctRaw(clamped);
  localStorage.setItem(SPLIT_WIDTH_KEY, String(clamped));
}

export function setSidebarWidthPx(px: number): void {
  const clamped = Math.max(160, Math.min(520, px));
  setSidebarWidthPxRaw(clamped);
  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
}
