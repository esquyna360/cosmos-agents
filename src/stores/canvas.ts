import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

/** World → screen: `screen = world * k + (x, y)`. */
export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Point {
  x: number;
  y: number;
}

export const CARD_W = 360;
export const CARD_H = 248;
export const GAP = 22;
export const PAD = 20;
export const HEAD = 46;
export const K_MIN = 0.15;
export const K_MAX = 1.6;
/** Below this the cards drop their detail and stop polling their screens. */
export const K_FAR = 0.42;

const VIEW_KEY = "cosmos.canvas.view";
const POS_KEY = "cosmos.canvas.pos";
const STALE_KEY = "cosmos.canvas.stale";

function read<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "null");
    return v && typeof v === "object" ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const hasSavedView = localStorage.getItem(VIEW_KEY) !== null;

const [view, setViewRaw] = createSignal<View>(read<View>(VIEW_KEY, { x: 80, y: 80, k: 0.8 }));
/** Where a card was dragged to. Cards without an entry follow the layout. */
const [placed, setPlaced] = createStore<Record<string, Point>>(read(POS_KEY, {}));
const [showStale, setShowStaleRaw] = createSignal(localStorage.getItem(STALE_KEY) === "1");

export { view, placed, showStale };

let saveTimer: number | undefined;
export function setView(next: View): void {
  setViewRaw({ x: next.x, y: next.y, k: Math.min(K_MAX, Math.max(K_MIN, next.k)) });
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => write(VIEW_KEY, view()), 300);
}

export function place(id: string, at: Point): void {
  setPlaced(id, { x: Math.round(at.x), y: Math.round(at.y) });
}

export function savePlaced(): void {
  write(POS_KEY, placed);
}

/** Hands every card back to the layout. */
export function tidy(): void {
  for (const id of Object.keys(placed)) setPlaced(id, undefined!);
  write(POS_KEY, {});
}

export function setShowStale(v: boolean): void {
  setShowStaleRaw(v);
  localStorage.setItem(STALE_KEY, v ? "1" : "0");
}

export interface Group {
  ids: string[];
}

/** The hub on the left, each project a block of cards to its right, blocks
 *  stacked into columns so the board stays roughly landscape. */
export function autoLayout(hubId: string | null, groups: Group[]): Record<string, Point> {
  const out: Record<string, Point> = {};
  const maxColumn = 2 * (HEAD + 2 * CARD_H + GAP + PAD) + 48;
  let x = hubId ? CARD_W + 170 : 0;
  let y = 0;
  let columnW = 0;
  let total = 0;
  for (const g of groups) {
    const n = g.ids.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    const w = cols * CARD_W + (cols - 1) * GAP + 2 * PAD;
    const h = rows * CARD_H + (rows - 1) * GAP + HEAD + PAD;
    if (y > 0 && y + h > maxColumn) {
      x += columnW + 64;
      y = 0;
      columnW = 0;
    }
    g.ids.forEach((id, i) => {
      out[id] = {
        x: x + PAD + (i % cols) * (CARD_W + GAP),
        y: y + HEAD + Math.floor(i / cols) * (CARD_H + GAP),
      };
    });
    total = Math.max(total, y + h);
    y += h + 48;
    columnW = Math.max(columnW, w);
  }
  if (hubId) out[hubId] = { x: 0, y: Math.max(0, (total - CARD_H) / 2) };
  return out;
}
