import { createMemo, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  projectsCreate,
  projectsDelete,
  projectsList,
  projectsUpdate,
  projectsClose,
  ptyKillProject,
  runnersCreate,
  runnersDelete,
  runnersList,
  runnersResetSession,
  runnersStop,
  runnersUpdate,
  type Project,
  type Runner,
  type RunnerKind,
  type RunnerStatus,
} from "../lib/projects";
import {
  projectsReorder,
  ptyKill,
  ptyLiveIds,
  ptySpawn,
  runnersReorder,
  type AgentStatus,
} from "../lib/ipc";
import { activeSlot, forgetProject, revealRunner, slotsFor } from "./panes";
import { fsClaudeMd, fsDetectStack, type StackInfo } from "../lib/fs";

/// UI-shape runner: persisted fields + live/derived status.
export interface RunnerUI extends Runner {
  live: boolean;
  status: RunnerStatus;
}

/// Editor state that needs to survive view switches (since `<Show
/// when={view() === "editor"}>` unmounts the Editor component). Persisted to
/// localStorage so it also survives app restarts. CM6 `EditorState`s (cursor
/// position, undo history) live in a parallel in-memory Map below — they're
/// not serializable.
export interface EditorViewState {
  openPaths: string[];
  activePath: string | null;
  /// Path → "has unflushed edits" flag.
  dirty: Record<string, boolean>;
}

/// UI-shape project: persisted fields + nested runners + derived display state.
export interface ProjectUI extends Project {
  runners: RunnerUI[];
  collapsed: boolean;
  stacks: StackInfo[];
  claudeMd: string | null;
  /// Worst-of-children status, used by the sidebar pill on the project header.
  promotedStatus: AgentStatus;
  promotedLive: boolean;
  editor: EditorViewState;
}

/* ------------------------------- persistence ----------------------------- */

const KEY_COLLAPSED = "cosmos.projects.collapsed.v2";

const editorKey = (projectId: string) => `cosmos.editor.${projectId}`;

function readEditorView(projectId: string): EditorViewState {
  try {
    const raw = localStorage.getItem(editorKey(projectId));
    if (!raw) return { openPaths: [], activePath: null, dirty: {} };
    const parsed = JSON.parse(raw) as Partial<EditorViewState>;
    return {
      openPaths: Array.isArray(parsed.openPaths) ? parsed.openPaths : [],
      activePath: typeof parsed.activePath === "string" ? parsed.activePath : null,
      dirty: typeof parsed.dirty === "object" && parsed.dirty ? parsed.dirty : {},
    };
  } catch {
    return { openPaths: [], activePath: null, dirty: {} };
  }
}

function writeEditorView(projectId: string, ev: EditorViewState): void {
  try {
    localStorage.setItem(editorKey(projectId), JSON.stringify(ev));
  } catch {
    /* quota exceeded — drop silently */
  }
}

const DEFAULT_AGENT_PROGRAM = "/bin/zsh";
const DEFAULT_AGENT_ARGS = [
  "-i",
  "-l",
  "-c",
  "exec env CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions",
];
const DEFAULT_SHELL_PROGRAM = "/bin/zsh";
const DEFAULT_SHELL_ARGS = ["-i", "-l"];

function readMap<T = unknown>(key: string): Record<string, T> {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") ?? {};
  } catch {
    return {};
  }
}
function writeMap(key: string, val: Record<string, unknown>): void {
  localStorage.setItem(key, JSON.stringify(val));
}

const [collapsedMap, setCollapsedMap] = createSignal<Record<string, boolean>>(
  readMap<boolean>(KEY_COLLAPSED),
);

/* --------------------------------- helpers ------------------------------- */

const STATUS_RANK: Record<AgentStatus, number> = {
  awaiting_input: 4,
  error: 3,
  streaming: 2,
  tool_running: 2,
  idle: 1,
};

function promoteFromRunners(runners: RunnerUI[]): { status: AgentStatus; live: boolean } {
  let bestRank = 0;
  let bestStatus: AgentStatus = "idle";
  let anyLive = false;
  for (const r of runners) {
    if (r.live) anyLive = true;
    // Only agent statuses ladder up — shell "running"/"exited" doesn't promote.
    const s = r.status as AgentStatus;
    const rank = STATUS_RANK[s];
    if (rank !== undefined && rank > bestRank) {
      bestRank = rank;
      bestStatus = s;
    }
  }
  return { status: bestStatus, live: anyLive };
}

async function enrich(
  cwd: string,
): Promise<{ stacks: StackInfo[]; claudeMd: string | null }> {
  const [stacks, claudeMd] = await Promise.all([
    fsDetectStack(cwd).catch(() => [] as StackInfo[]),
    fsClaudeMd(cwd).catch(() => null),
  ]);
  return { stacks, claudeMd };
}

/* ----------------------------- store + signals --------------------------- */

interface ProjectsState {
  list: ProjectUI[];
}

const [state, setState] = createStore<ProjectsState>({ list: [] });
const [focusedProjectIdSignal, setFocusedProjectIdSignal] = createSignal<string | null>(
  null,
);
/// Bumped whenever a runner's PTY is respawned, so terminals keyed on it
/// remount and re-attach instead of streaming into a dead channel.
const [respawnTick, setRespawnTick] = createSignal(0);
export { respawnTick };

const [requestedOpenFile, setRequestedOpenFile] = createSignal<{
  path: string;
  line?: number;
} | null>(null);
export const editorOpenRequest = requestedOpenFile;
export function openFileInEditor(path: string, line?: number): void {
  setRequestedOpenFile({ path, line });
}

const [pendingRename, setPendingRename] = createSignal<string | null>(null);
export const pendingRenameId = pendingRename;
export function consumePendingRename(id: string): void {
  if (pendingRename() === id) setPendingRename(null);
}

export const projectsStore = state;
export const focusedProjectId = focusedProjectIdSignal;

export const focusedProject = createMemo<ProjectUI | null>(
  () => state.list.find((p) => p.id === focusedProjectIdSignal()) ?? null,
);

/// The runner the composer, ⌘W and the status bar act on: whatever sits in
/// the active pane, falling back to the project's first runner when the grid
/// still has an empty slot selected.
export const focusedRunner = createMemo<RunnerUI | null>(() => {
  const p = focusedProject();
  if (!p) return null;
  const slots = slotsFor(p.id);
  const inSlot = slots[activeSlot()] ?? null;
  return (
    p.runners.find((r) => r.id === inSlot) ??
    p.runners.find((r) => r.id === slots.find(Boolean)) ??
    p.runners[0] ??
    null
  );
});

export function focusProject(id: string): void {
  setFocusedProjectIdSignal(id);
}

/**
 * Selects a runner and, if its PTY is gone, brings it back. Clicking a
 * stopped agent is the natural "resume this conversation" gesture — making
 * the user hunt for a separate restart button would be the wrong default.
 */
export function focusRunner(projectId: string, runnerId: string): void {
  setFocusedProjectIdSignal(projectId);
  revealRunner(projectId, runnerId);
  const proj = state.list.find((p) => p.id === projectId);
  const runner = proj?.runners.find((r) => r.id === runnerId);
  if (runner && !runner.live) restartRunner(runnerId).catch(console.error);
}

/**
 * Moves `id` so it sits where `beforeId` was, or to the end when `beforeId`
 * is null. The store is reordered first and persisted after, so the row
 * follows the cursor instead of waiting on a round trip.
 */
export function moveProject(id: string, beforeId: string | null): void {
  const next = reinsert(
    state.list.map((p) => p.id),
    id,
    beforeId,
  );
  if (!next) return;
  setState("list", (list) => sortByIds(list, next));
  projectsReorder(next).catch(console.error);
}

export function moveRunner(
  projectId: string,
  id: string,
  beforeId: string | null,
): void {
  const proj = state.list.find((p) => p.id === projectId);
  if (!proj) return;
  const next = reinsert(
    proj.runners.map((r) => r.id),
    id,
    beforeId,
  );
  if (!next) return;
  setState("list", (p) => p.id === projectId, "runners", (rs) =>
    sortByIds(rs, next),
  );
  runnersReorder(next).catch(console.error);
}

function reinsert(ids: string[], id: string, beforeId: string | null): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0 || id === beforeId) return null;
  const rest = ids.filter((x) => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  if (beforeId !== null && at < 0) return null;
  rest.splice(at, 0, id);
  return rest.every((x, i) => x === ids[i]) ? null : rest;
}

function sortByIds<T extends { id: string }>(items: readonly T[], order: string[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...items].sort(
    (a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9),
  );
}

export function toggleProjectCollapsed(id: string): void {
  const next = { ...collapsedMap(), [id]: !collapsedMap()[id] };
  setCollapsedMap(next);
  writeMap(KEY_COLLAPSED, next);
  setState("list", (p) => p.id === id, "collapsed", !!next[id]);
}

/* ------------------------- one-shot LS cleanup --------------------------- */

const MIGRATION_STAMP_V2 = "cosmos.migration.v2";
const MIGRATION_STAMP_V3 = "cosmos.migration.v3";

/// Drop localStorage keys that became stale across releases. Idempotent —
/// gated by per-version stamps so each cleanup runs exactly once.
/// Called from App.tsx on mount.
export function migrateLegacyLocalStorage(): void {
  try {
    // v2: Workspaces+Agents → Projects+Runners cleanup.
    if (!localStorage.getItem(MIGRATION_STAMP_V2)) {
      localStorage.removeItem("cosmos.projects.collapsed");
      localStorage.removeItem("cosmos.projects.names");
      localStorage.removeItem("cosmos.agents.names");
      localStorage.removeItem("cosmos.split.secondaryAgentId");
      localStorage.setItem(MIGRATION_STAMP_V2, "1");
    }
    // v3: ViewMode "terminal" → "runners" rename. The fallback in
    // layout.ts::readView already handles the live read, but we rewrite the
    // stored value so subsequent saves don't keep the stale string.
    if (!localStorage.getItem(MIGRATION_STAMP_V3)) {
      const view = localStorage.getItem("cosmos.view");
      if (view === "terminal") localStorage.setItem("cosmos.view", "runners");
      localStorage.setItem(MIGRATION_STAMP_V3, "1");
    }
  } catch {
    /* ignore */
  }
}

/* ------------------------------ loader ----------------------------------- */

/// Kept in sync with `master::MASTER_NAME` on the Rust side.
const MASTER_NAME = "geral";

export async function loadProjects(): Promise<void> {
  const [projects, runners, live] = await Promise.all([
    projectsList(),
    runnersList(),
    ptyLiveIds(),
  ]);
  const liveSet = new Set(live);
  const projectsById = new Map<string, ProjectUI>();
  for (const p of projects) {
    projectsById.set(p.id, toUI(p));
  }
  for (const r of runners) {
    const proj = projectsById.get(r.projectId);
    if (!proj) continue;
    proj.runners.push({
      ...r,
      live: liveSet.has(r.id),
      // Initial guess: agents start as 'idle' (FSM will correct); shells in
      // 'exited' until a runner-status event flips them. Live PTYs send their
      // current state via the initial emit_status in supervisor.spawn so this
      // is just a placeholder.
      status: r.kind === "shell" ? (liveSet.has(r.id) ? "running" : "exited") : "idle",
    });
  }
  for (const p of projectsById.values()) {
    const promo = promoteFromRunners(p.runners);
    p.promotedStatus = promo.status;
    p.promotedLive = promo.live;
  }
  const list = Array.from(projectsById.values());
  setState("list", list);

  if (list.length > 0 && focusedProjectIdSignal() === null) {
    // The master agent owns the first screen: Cosmos opens on `geral`, not on
    // whichever project happens to sort first.
    const master = list.find((p) => p.name.toLowerCase() === MASTER_NAME);
    setFocusedProjectIdSignal((master ?? list[0]).id);
  }

  // Enrich each project's cwd asynchronously (stacks + CLAUDE.md).
  for (const p of list) {
    enrich(p.cwd).then(({ stacks, claudeMd }) => {
      setState(
        "list",
        (x) => x.id === p.id,
        (cur) => ({ ...cur, stacks, claudeMd }),
      );
    });
  }
}

/* --------------------------- external mutations -------------------------- */

let unlistenChanges: UnlistenFn | null = null;

/// Subscribe to backend events that signal a project/runner was created or
/// modified outside of the UI (currently: `cosmos` CLI invocations from
/// inside a spawned agent's PTY). Re-runs `loadProjects` to fold the new
/// rows in. Cheap because loadProjects is two SQLite SELECTs + a fan-out.
export async function attachExternalChangesListener(): Promise<void> {
  if (unlistenChanges) return;
  const handler = () => {
    void loadProjects();
  };
  const u1 = await listen<{ reason?: string; projectId?: string }>(
    "runners-changed",
    handler,
  );
  const u2 = await listen<{ reason?: string }>("projects-changed", handler);
  unlistenChanges = () => {
    u1();
    u2();
  };
}

export function detachExternalChangesListener(): void {
  unlistenChanges?.();
  unlistenChanges = null;
}

/* --------------------------- runner-status events ------------------------ */

let unlistenRunnerStatus: UnlistenFn | null = null;

/// Subscribe once; safe to call multiple times (idempotent).
export async function attachRunnerStatusListener(): Promise<void> {
  if (unlistenRunnerStatus) return;
  unlistenRunnerStatus = await listen<{
    projectId: string;
    runnerId: string;
    status: RunnerStatus;
  }>("runner-status", (e) => {
    const { projectId, runnerId, status } = e.payload;
    setState(
      "list",
      (p) => p.id === projectId,
      "runners",
      (r) => r.id === runnerId,
      (cur) => ({
        ...cur,
        status,
        live: status !== "exited",
      }),
    );
    const proj = state.list.find((p) => p.id === projectId);
    if (proj) {
      const promo = promoteFromRunners(proj.runners);
      setState(
        "list",
        (p) => p.id === projectId,
        (cur) => ({ ...cur, promotedStatus: promo.status, promotedLive: promo.live }),
      );
    }
  });
}

export function detachRunnerStatusListener(): void {
  unlistenRunnerStatus?.();
  unlistenRunnerStatus = null;
}

/* ------------------------------- mutators -------------------------------- */

function toUI(project: Project): ProjectUI {
  return {
    ...project,
    runners: [],
    collapsed: !!collapsedMap()[project.id],
    stacks: [],
    claudeMd: null,
    promotedStatus: "idle",
    promotedLive: false,
    editor: readEditorView(project.id),
  };
}

function runnerToUI(r: Runner, live: boolean): RunnerUI {
  return {
    ...r,
    live,
    status: r.kind === "shell" ? (live ? "running" : "exited") : "idle",
  };
}

/**
 * Creates a Project + auto-spawns one agent Runner inside it. PTY is spawned
 * synchronously after the rows are persisted so the user can attach
 * immediately. If PTY spawn fails the project is left in place so the user can
 * retry — we don't roll back, since the cwd materialization may have side
 * effects on disk we don't want to undo.
 */
export async function createProjectWithAgent(opts: {
  name: string;
  folders: string[];
  memory?: string;
  cols?: number;
  rows?: number;
  agentName?: string;
  /// Override the spawned runner's program/args. Used when the user picks
  /// a specific AI CLI in the creator modal. Defaults (Claude) come from
  /// the Rust side if these are omitted.
  agentProgram?: string;
  agentArgs?: string[];
}): Promise<ProjectUI> {
  const project = await projectsCreate(opts.name, opts.folders, opts.memory ?? "");
  const ui = toUI(project);

  const runnerName = opts.agentName?.trim() || "main";
  const runner = await runnersCreate({
    projectId: project.id,
    kind: "agent",
    name: runnerName,
    program: opts.agentProgram,
    args: opts.agentArgs,
  });

  try {
    await ptySpawn({
      id: runner.id,
      cwd: project.cwd,
      program: runner.program,
      args: runner.args,
      cols: opts.cols ?? 100,
      rows: opts.rows ?? 30,
      projectId: project.id,
      kind: "agent",
    });
  } catch (e) {
    console.error("[cosmos] pty spawn failed during createProject", e);
  }

  ui.runners.push(runnerToUI(runner, true));
  setState("list", (list) => [ui, ...list]);
  setFocusedProjectIdSignal(project.id);
  revealRunner(project.id, runner.id);
  enrich(project.cwd).then(({ stacks, claudeMd }) => {
    setState(
      "list",
      (p) => p.id === project.id,
      (cur) => ({ ...cur, stacks, claudeMd }),
    );
  });
  return ui;
}

/**
 * Spawns another Runner inside an existing Project. `kind` defaults to 'agent'
 * (the AI CLI). For `kind='shell'` the runner runs an interactive zsh and
 * skips the StatusFSM (status pill = running/exited only).
 *
 * `opts.program` / `opts.args` override the kind's default command — used by
 * the "+ shell" dropdown to spawn `pnpm run dev` etc. as a shell runner.
 * `opts.cwd` overrides the project's cwd, so a script can run in a specific
 * sub-folder (essential for multi-folder projects).
 */
export async function createRunnerInProject(
  projectId: string,
  kind: RunnerKind = "agent",
  opts?: {
    name?: string;
    cols?: number;
    rows?: number;
    program?: string;
    args?: string[];
    cwd?: string;
  },
): Promise<RunnerUI> {
  const project = state.list.find((p) => p.id === projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);

  const sameKindCount = project.runners.filter((r) => r.kind === kind).length;
  const defaultName =
    kind === "shell" ? `shell-${sameKindCount + 1}` : `agent-${sameKindCount + 1}`;
  const name = opts?.name?.trim() || defaultName;

  const runner = await runnersCreate({
    projectId,
    kind,
    name,
    program: opts?.program,
    args: opts?.args,
  });
  // Agents run from project.cwd (the synthetic ~/.cosmos/projects/<slug>/ dir)
  // so they read the generated CLAUDE.md with pinned cards + @-included repo
  // memory. Blank shells default to folders[0] — opening a terminal lands you
  // in a real repo, not the synthetic dir. Scripts always pass cwd explicitly.
  const defaultCwd =
    kind === "shell" ? (project.folders[0] ?? project.cwd) : project.cwd;
  const spawnCwd = opts?.cwd ?? defaultCwd;
  try {
    await ptySpawn({
      id: runner.id,
      cwd: spawnCwd,
      program: runner.program,
      args: runner.args,
      cols: opts?.cols ?? 100,
      rows: opts?.rows ?? 30,
      projectId,
      kind,
    });
  } catch (e) {
    console.error("[cosmos] pty spawn failed for new runner", e);
  }

  const ui = runnerToUI(runner, true);
  setState(
    "list",
    (p) => p.id === projectId,
    "runners",
    (rs) => [...rs, ui],
  );
  setFocusedProjectIdSignal(projectId);
  revealRunner(projectId, runner.id);
  setPendingRename(runner.id);
  return ui;
}

export async function updateProject(
  id: string,
  name: string,
  folders: string[],
  memory: string,
): Promise<void> {
  const updated = await projectsUpdate(id, name, folders, memory);
  setState(
    "list",
    (p) => p.id === id,
    (cur) => ({ ...cur, ...updated }),
  );
}

export async function renameRunner(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await runnersUpdate(id, trimmed);
  setState(
    "list",
    () => true,
    "runners",
    (r) => r.id === id,
    "name",
    trimmed,
  );
}

/**
 * Stops a runner: the PTY dies, the row survives. Reopening the tab respawns
 * Claude with `--resume <session>`, so the thread picks up where it stopped.
 * This used to delete the row outright, which is why sessions could never be
 * revived — the handle went with it.
 */
export async function stopRunner(id: string): Promise<void> {
  try {
    await runnersStop(id);
  } catch (e) {
    console.error("[cosmos] runners_stop failed", e);
  }
  setState(
    "list",
    () => true,
    "runners",
    (r) => r.id === id,
    (cur) => ({ ...cur, live: false, status: "exited" as RunnerStatus }),
  );
  recomputePromotion();
}

/** Kills and respawns a runner in place, resuming its session. */
export async function restartRunner(id: string): Promise<void> {
  const project = state.list.find((p) => p.runners.some((r) => r.id === id));
  const runner = project?.runners.find((r) => r.id === id);
  if (!project || !runner) return;
  try {
    await ptyKill(id);
  } catch {
    /* already dead */
  }
  setState(
    "list",
    (p) => p.id === project.id,
    "runners",
    (r) => r.id === id,
    (cur) => ({ ...cur, live: false, status: "exited" as RunnerStatus }),
  );
  // Terminal remounts on the live flag flipping back and does the spawn, but
  // a runner that is already on screen won't remount — so spawn here too and
  // let the attach path in Terminal find a live PTY.
  const cwd = runner.kind === "shell" ? (project.folders[0] ?? project.cwd) : project.cwd;
  try {
    await ptySpawn({
      id,
      cwd,
      program: runner.program,
      args: runner.args,
      cols: 100,
      rows: 30,
      projectId: project.id,
      kind: runner.kind,
    });
    markRunnerLive(id, true);
    setRespawnTick(respawnTick() + 1);
  } catch (e) {
    console.error("[cosmos] restart spawn failed", e);
  }
}

/** Throws away the resumable thread and restarts on a clean one. */
export async function resetRunnerSession(id: string): Promise<void> {
  try {
    await runnersResetSession(id);
  } catch (e) {
    console.error("[cosmos] runners_reset_session failed", e);
    return;
  }
  await loadProjects();
  await restartRunner(id);
}

/** Permanently removes a runner and its row. */
export async function deleteRunner(id: string): Promise<void> {
  const project = state.list.find((p) => p.runners.some((r) => r.id === id));
  if (!project) return;
  try {
    await runnersDelete(id);
  } catch (e) {
    console.error("[cosmos] runners_delete failed", e);
  }
  setState(
    "list",
    (p) => p.id === project.id,
    "runners",
    (rs) => rs.filter((r) => r.id !== id),
  );
  recomputePromotion();
}

/**
 * Puts a project to sleep: every PTY stops, nothing is deleted. The project
 * stays in the sidebar, greyed, and one click brings its agents back with
 * their history intact.
 */
export async function sleepProject(id: string): Promise<void> {
  try {
    await projectsClose(id);
  } catch (e) {
    console.error("[cosmos] projects_close failed", e);
  }
  setState(
    "list",
    (p) => p.id === id,
    (cur) => ({
      ...cur,
      runners: cur.runners.map((r) => ({
        ...r,
        live: false,
        status: "exited" as RunnerStatus,
      })),
      promotedLive: false,
      promotedStatus: "idle" as AgentStatus,
    }),
  );
}

/** Deletes a project and every runner under it. Irreversible. */
export async function deleteProject(id: string): Promise<void> {
  try {
    await ptyKillProject(id);
  } catch (e) {
    console.error("[cosmos] pty_kill_project failed", e);
  }
  try {
    await projectsDelete(id);
  } catch (e) {
    console.error("[cosmos] projects_delete failed", e);
  }
  setState("list", (list) => list.filter((p) => p.id !== id));
  fileStatesByProject.delete(id);
  forgetProject(id);
  try {
    localStorage.removeItem(editorKey(id));
  } catch {
    /* ignore */
  }
  if (focusedProjectIdSignal() === id) {
    setFocusedProjectIdSignal(state.list[0]?.id ?? null);
  }
}

function recomputePromotion(): void {
  for (const proj of state.list) {
    const promo = promoteFromRunners(proj.runners);
    setState(
      "list",
      (p) => p.id === proj.id,
      (cur) => ({ ...cur, promotedStatus: promo.status, promotedLive: promo.live }),
    );
  }
}

export function markRunnerLive(id: string, live: boolean): void {
  setState(
    "list",
    () => true,
    "runners",
    (r) => r.id === id,
    "live",
    live,
  );
}

export function focusByProjectIndex(idx: number): void {
  const p = state.list[idx];
  if (p) setFocusedProjectIdSignal(p.id);
}

/* --------------------------- default-spawn helper ------------------------ */

export function defaultAgentSpawn(): { program: string; args: string[] } {
  return { program: DEFAULT_AGENT_PROGRAM, args: DEFAULT_AGENT_ARGS };
}
export function defaultShellSpawn(): { program: string; args: string[] } {
  return { program: DEFAULT_SHELL_PROGRAM, args: DEFAULT_SHELL_ARGS };
}

/* ----------------------------- editor state ------------------------------ */

/// In-memory only (per session). CM6 EditorState isn't serializable and we
/// don't care about cursor-position persistence across app restarts.
/// Structure: projectId → (filePath → opaque CM6 state).
const fileStatesByProject = new Map<string, Map<string, unknown>>();

export function getFileState<T = unknown>(
  projectId: string,
  path: string,
): T | undefined {
  return fileStatesByProject.get(projectId)?.get(path) as T | undefined;
}

export function setFileState(
  projectId: string,
  path: string,
  fileState: unknown,
): void {
  let m = fileStatesByProject.get(projectId);
  if (!m) {
    m = new Map();
    fileStatesByProject.set(projectId, m);
  }
  m.set(path, fileState);
}

export function deleteFileState(projectId: string, path: string): void {
  fileStatesByProject.get(projectId)?.delete(path);
}

function patchEditor(
  projectId: string,
  patch: (cur: EditorViewState) => EditorViewState,
): void {
  setState(
    "list",
    (p) => p.id === projectId,
    "editor",
    (cur) => {
      const next = patch(cur);
      writeEditorView(projectId, next);
      return next;
    },
  );
}

export function setEditorOpenPaths(projectId: string, paths: string[]): void {
  patchEditor(projectId, (cur) => ({ ...cur, openPaths: paths }));
}

export function setEditorActivePath(
  projectId: string,
  path: string | null,
): void {
  patchEditor(projectId, (cur) => ({ ...cur, activePath: path }));
}

export function setEditorDirty(
  projectId: string,
  path: string,
  isDirty: boolean,
): void {
  patchEditor(projectId, (cur) => {
    const dirty = { ...cur.dirty };
    if (isDirty) dirty[path] = true;
    else delete dirty[path];
    return { ...cur, dirty };
  });
}

export function clearEditorDirtyAll(projectId: string): void {
  patchEditor(projectId, (cur) => ({ ...cur, dirty: {} }));
}

