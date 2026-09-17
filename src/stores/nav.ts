import { createSignal } from "solid-js";

/**
 * Where the window is. Two fixed places (home, Hub), then whatever
 * project or session is open. Deliberately free of imports from the projects
 * store, so that store can navigate without a cycle.
 */
export type Route =
  | { kind: "home" }
  | { kind: "hub" }
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
    if (v && (v.kind === "crew" || v.kind === "board")) return { kind: "home" };
    if (v && typeof v.kind === "string") return v as Route;
  } catch {
    /* fall through */
  }
  return { kind: "home" };
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
    go({ kind: "home" });
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

/** Projects live either as tabs in the strip or as a list down the side. */
export type NavMode = "tabs" | "sidebar";
/** What is listed under each project: nothing, its agents, or terminals too. */
export type NavChildren = "none" | "agents" | "all";

const NAV_MODE_KEY = "cosmos.nav.mode";
const NAV_CHILDREN_KEY = "cosmos.nav.children";

const [navMode, setNavModeRaw] = createSignal<NavMode>(
  localStorage.getItem(NAV_MODE_KEY) === "tabs" ? "tabs" : "sidebar",
);
const [navChildren, setNavChildrenRaw] = createSignal<NavChildren>(
  ((v) => (v === "none" || v === "all" ? v : "agents"))(localStorage.getItem(NAV_CHILDREN_KEY)),
);
export { navMode, navChildren };

export function setNavMode(v: NavMode): void {
  setNavModeRaw(v);
  localStorage.setItem(NAV_MODE_KEY, v);
}

export function setNavChildren(v: NavChildren): void {
  setNavChildrenRaw(v);
  localStorage.setItem(NAV_CHILDREN_KEY, v);
}
