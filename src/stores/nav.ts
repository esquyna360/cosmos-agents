import { createSignal } from "solid-js";

/**
 * Where the window is. Three fixed places (Crew, Hub, Board), then whatever
 * project or session is open. Deliberately free of imports from the projects
 * store, so that store can navigate without a cycle.
 */
export type Route =
  | { kind: "crew" }
  | { kind: "hub" }
  | { kind: "board" }
  | { kind: "project"; projectId: string }
  | { kind: "session"; projectId: string; runnerId: string };

/** Tools that belong to a project rather than to one session. */
export type ProjectTab = "overview" | "files" | "diff" | "memory" | "browser";

const ROUTE_KEY = "cosmos.route";
const TABS_KEY = "cosmos.tabs";
const PROJECT_TAB_KEY = "cosmos.projectTab";

function readRoute(): Route {
  try {
    const v = JSON.parse(localStorage.getItem(ROUTE_KEY) || "null");
    if (v && typeof v.kind === "string") return v as Route;
  } catch {
    /* fall through */
  }
  return { kind: "crew" };
}

function readTabs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(TABS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const [route, setRoute] = createSignal<Route>(readRoute());
const [openTabs, setOpenTabs] = createSignal<string[]>(readTabs());
const [projectTab, setProjectTabRaw] = createSignal<ProjectTab>(
  ((v) =>
    v === "files" || v === "diff" || v === "memory" || v === "browser" ? v : "overview")(
    localStorage.getItem(PROJECT_TAB_KEY),
  ),
);

export { route, openTabs, projectTab };

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function go(next: Route): void {
  setRoute(next);
  persist(ROUTE_KEY, next);
  if (next.kind === "project" || next.kind === "session") pinTab(next.projectId);
}

export function setProjectTab(tab: ProjectTab): void {
  setProjectTabRaw(tab);
  localStorage.setItem(PROJECT_TAB_KEY, tab);
}

export function pinTab(projectId: string): void {
  if (openTabs().includes(projectId)) return;
  const next = [...openTabs(), projectId];
  setOpenTabs(next);
  persist(TABS_KEY, next);
}

export function closeTab(projectId: string): void {
  const next = openTabs().filter((id) => id !== projectId);
  setOpenTabs(next);
  persist(TABS_KEY, next);
  const r = route();
  if ((r.kind === "project" || r.kind === "session") && r.projectId === projectId)
    go({ kind: "crew" });
}

/** Drops tabs whose project no longer exists. */
export function pruneTabs(known: string[]): void {
  const next = openTabs().filter((id) => known.includes(id));
  if (next.length !== openTabs().length) {
    setOpenTabs(next);
    persist(TABS_KEY, next);
  }
}

export function routeProjectId(): string | null {
  const r = route();
  return r.kind === "project" || r.kind === "session" ? r.projectId : null;
}
