import { createMemo, createSignal } from "solid-js";
import { listen } from "@tauri-apps/api/event";

import { brainIndex, brainOpen, type BrainIndex, type Note, type Opened, type Source } from "../lib/brain";

const OPEN_KEY = "cosmos.brain.open";
const PANE_KEY = "cosmos.brain.pane";
const ORPHANS_KEY = "cosmos.brain.orphans";

export type Pane = "graph" | "note";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const [index, setIndex] = createSignal<BrainIndex>({ notes: [], tags: [] });
const [loaded, setLoaded] = createSignal(false);
const [openId, setOpenId] = createSignal<string | null>(stored(OPEN_KEY));
const [opened, setOpened] = createSignal<Opened | null>(null);
const [pane, setPaneRaw] = createSignal<Pane>(stored(PANE_KEY) === "note" ? "note" : "graph");
const [sourceFilter, setSourceFilter] = createSignal<Source | null>(null);
const [tagFilter, setTagFilter] = createSignal<string | null>(null);
const [showOrphans, setShowOrphansRaw] = createSignal(stored(ORPHANS_KEY) === "1");

export { index, loaded, openId, opened, pane, sourceFilter, setSourceFilter, tagFilter, setTagFilter, showOrphans };

export const byId = createMemo(() => new Map(index().notes.map((n) => [n.id, n])));

export function noteOf(id: string | null): Note | undefined {
  return id ? byId().get(id) : undefined;
}

export function setPane(next: Pane): void {
  setPaneRaw(next);
  store(PANE_KEY, next);
}

export function setShowOrphans(on: boolean): void {
  setShowOrphansRaw(on);
  store(ORPHANS_KEY, on ? "1" : "0");
}

let loading: Promise<void> | null = null;

export function refreshBrain(): Promise<void> {
  if (loading) return loading;
  loading = brainIndex()
    .then((next) => {
      setIndex(next ?? { notes: [], tags: [] });
      setLoaded(true);
    })
    .catch(console.error)
    .finally(() => {
      loading = null;
    });
  return loading;
}

let ticket = 0;

async function load(id: string): Promise<void> {
  const mine = ++ticket;
  try {
    const next = await brainOpen(id);
    if (mine === ticket) setOpened(next);
  } catch {
    if (mine === ticket) {
      setOpened(null);
      setOpenId(null);
      store(OPEN_KEY, null);
    }
  }
}

/** Opens a note in the reading pane. */
export function openNote(id: string, show: Pane | null = "note"): void {
  setOpenId(id);
  store(OPEN_KEY, id);
  if (show) setPane(show);
  void load(id);
}

export function closeNote(): void {
  ticket++;
  setOpenId(null);
  setOpened(null);
  store(OPEN_KEY, null);
}

export function reloadOpen(): void {
  const id = openId();
  if (id) void load(id);
}

let watchers = 0;
let stop: (() => void) | null = null;

/** Keeps the vault fresh while the view is on screen: agents write to it. */
export function watchBrain(): () => void {
  watchers++;
  if (watchers === 1) {
    void refreshBrain();
    reloadOpen();
    let unlisten: (() => void) | null = null;
    listen("brain-changed", () => {
      void refreshBrain();
      reloadOpen();
    })
      .then((u) => {
        if (watchers === 0) u();
        else unlisten = u;
      })
      .catch(() => {});
    const onFocus = () => {
      void refreshBrain();
    };
    window.addEventListener("focus", onFocus);
    stop = () => {
      unlisten?.();
      window.removeEventListener("focus", onFocus);
    };
  }
  return () => {
    watchers--;
    if (watchers === 0) {
      stop?.();
      stop = null;
    }
  };
}
