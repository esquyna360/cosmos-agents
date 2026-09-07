import { createSignal } from "solid-js";

/**
 * Pane grid. A project's terminals used to be one focused runner plus an
 * optional pinned sidekick; now the workspace is a real grid and every slot
 * is addressable.
 *
 * The slot array is per-project and persisted, so switching away and back
 * restores the same arrangement. Slot 0 is the anchor: it is what the rest of
 * the app means by "the focused runner" when nothing else is selected.
 */
export type PaneLayout = "single" | "cols2" | "rows2" | "grid4" | "main-right";

export interface LayoutSpec {
  id: PaneLayout;
  label: string;
  slots: number;
  /** CSS grid-template-areas for the slot indices, ASCII-art style. */
  areas: string;
  cols: string;
  rows: string;
}

export const LAYOUTS: LayoutSpec[] = [
  {
    id: "single",
    label: "único",
    slots: 1,
    areas: '"a"',
    cols: "1fr",
    rows: "1fr",
  },
  {
    id: "cols2",
    label: "lado a lado",
    slots: 2,
    areas: '"a b"',
    cols: "1fr 1fr",
    rows: "1fr",
  },
  {
    id: "rows2",
    label: "empilhado",
    slots: 2,
    areas: '"a" "b"',
    cols: "1fr",
    rows: "1fr 1fr",
  },
  {
    id: "grid4",
    label: "quadrantes",
    slots: 4,
    areas: '"a b" "c d"',
    cols: "1fr 1fr",
    rows: "1fr 1fr",
  },
  {
    id: "main-right",
    label: "principal + 2",
    slots: 3,
    areas: '"a b" "a c"',
    cols: "1.6fr 1fr",
    rows: "1fr 1fr",
  },
];

export const AREA_NAMES = ["a", "b", "c", "d"] as const;

export function layoutSpec(id: PaneLayout): LayoutSpec {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0];
}

/* ------------------------------- persistence ----------------------------- */

const LAYOUT_KEY = "cosmos.panes.layout.v1";
const SLOTS_KEY = "cosmos.panes.slots.v1";

type SlotMap = Record<string, (string | null)[]>;

function readLayout(): PaneLayout {
  const v = localStorage.getItem(LAYOUT_KEY);
  return LAYOUTS.some((l) => l.id === v) ? (v as PaneLayout) : "single";
}

function readSlots(): SlotMap {
  try {
    const raw = JSON.parse(localStorage.getItem(SLOTS_KEY) || "{}");
    if (!raw || typeof raw !== "object") return {};
    const out: SlotMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        out[k] = v.map((x) => (typeof x === "string" ? x : null));
      }
    }
    return out;
  } catch {
    return {};
  }
}

const [layout, setLayoutRaw] = createSignal<PaneLayout>(readLayout());
const [slotMap, setSlotMap] = createSignal<SlotMap>(readSlots());
const [activeSlot, setActiveSlotRaw] = createSignal(0);

export { layout, activeSlot };

function persistSlots(next: SlotMap): void {
  setSlotMap(next);
  try {
    localStorage.setItem(SLOTS_KEY, JSON.stringify(next));
  } catch {
    /* quota — the grid just won't survive a restart */
  }
}

/** Raw slots for a project, padded/truncated to the active layout's size. */
export function slotsFor(projectId: string): (string | null)[] {
  const n = layoutSpec(layout()).slots;
  const cur = slotMap()[projectId] ?? [];
  const out: (string | null)[] = [];
  for (let i = 0; i < n; i++) out.push(cur[i] ?? null);
  return out;
}

function writeSlots(projectId: string, next: (string | null)[]): void {
  persistSlots({ ...slotMap(), [projectId]: next });
}

/**
 * Reconciles a project's slots against the runners that actually exist.
 * Drops ids that vanished, de-duplicates (one PTY can only stream to one
 * attached view), and fills empty slots with runners that aren't shown yet —
 * so switching to "quadrantes" on a project with four agents just works.
 */
export function reconcile(projectId: string, runnerIds: string[]): (string | null)[] {
  const n = layoutSpec(layout()).slots;
  const alive = new Set(runnerIds);
  const seen = new Set<string>();
  const cur = slotMap()[projectId] ?? [];
  const next: (string | null)[] = [];

  for (let i = 0; i < n; i++) {
    const id = cur[i];
    if (id && alive.has(id) && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    } else {
      next.push(null);
    }
  }
  const spare = runnerIds.filter((id) => !seen.has(id));
  for (let i = 0; i < n && spare.length > 0; i++) {
    if (next[i] === null) next[i] = spare.shift()!;
  }

  const cursor = cur.slice(0, n);
  const same =
    cursor.length === next.length && cursor.every((v, i) => (v ?? null) === next[i]);
  if (!same) writeSlots(projectId, next);
  return next;
}

export function setSlot(projectId: string, index: number, runnerId: string | null): void {
  const cur = slotsFor(projectId);
  const next = [...cur];
  // A runner can only live in one slot; assigning it elsewhere moves it and
  // leaves the old slot for whatever was displaced.
  if (runnerId) {
    const from = next.indexOf(runnerId);
    if (from >= 0 && from !== index) next[from] = next[index];
  }
  next[index] = runnerId;
  writeSlots(projectId, next);
  setActiveSlotRaw(index);
}

/** Puts a runner in the active slot — what clicking a runner tab does. */
export function assignToActiveSlot(projectId: string, runnerId: string): void {
  const n = layoutSpec(layout()).slots;
  const idx = Math.min(activeSlot(), n - 1);
  setSlot(projectId, idx, runnerId);
}

/** Focuses the slot a runner already occupies, or seats it in the active one. */
export function revealRunner(projectId: string, runnerId: string): void {
  const cur = slotsFor(projectId);
  const at = cur.indexOf(runnerId);
  if (at >= 0) {
    setActiveSlotRaw(at);
    return;
  }
  assignToActiveSlot(projectId, runnerId);
}

export function setActiveSlot(index: number): void {
  const n = layoutSpec(layout()).slots;
  setActiveSlotRaw(Math.max(0, Math.min(index, n - 1)));
}

export function setLayout(next: PaneLayout): void {
  setLayoutRaw(next);
  localStorage.setItem(LAYOUT_KEY, next);
  setActiveSlotRaw((i) => Math.min(i, layoutSpec(next).slots - 1));
}

export function cycleLayout(): void {
  const i = LAYOUTS.findIndex((l) => l.id === layout());
  setLayout(LAYOUTS[(i + 1) % LAYOUTS.length].id);
}

/** ⌘\ — one keystroke from "one terminal" to "two side by side" and back. */
export function toggleSplit(): void {
  setLayout(layout() === "single" ? "cols2" : "single");
}

export function closeSlot(projectId: string, index: number): void {
  setSlot(projectId, index, null);
}

export function forgetProject(projectId: string): void {
  const next = { ...slotMap() };
  delete next[projectId];
  persistSlots(next);
}
