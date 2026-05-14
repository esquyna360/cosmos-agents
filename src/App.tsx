import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Layers, PanelRightClose } from "lucide-solid";

import Sidebar from "./components/Sidebar";
import Terminal from "./components/Terminal";
import Editor from "./components/Editor";
import InputBar from "./components/InputBar";
import CommandPalette, { type PaletteMode } from "./components/CommandPalette";
import DiffView from "./components/DiffView";
import WorkflowView from "./components/WorkflowView";
import AgentCreatorModal from "./components/AgentCreatorModal";
import ProjectTitleBar from "./components/ProjectTitleBar";
import RunnerTabs from "./components/RunnerTabs";
import MemoryView from "./components/MemoryView";
import { creator, openCreator, closeCreator } from "./stores/creator";
import {
  attachRunnerStatusListener,
  closeProject,
  closeRunner,
  createRunnerInProject,
  editorOpenRequest,
  focusByProjectIndex,
  focusedProject,
  focusedRunner,
  focusRunner,
  loadProjects,
  migrateLegacyLocalStorage,
  projectsStore,
  type RunnerUI,
} from "./stores/projects";
import {
  composerExpanded,
  composerVisible,
  cycleView,
  secondaryAgentId,
  setSecondaryAgent,
  setSplitWidthPct,
  setView,
  setWorkflowOpen,
  smartPin,
  splitWidthPct,
  toggleComposer,
  toggleWorkflow,
  view,
  workflowOpen,
} from "./stores/layout";
import type { AgentStatus } from "./lib/ipc";

export default function App() {
  const [palette, setPalette] = createSignal<PaletteMode | null>(null);

  // Secondary pane runner — scoped to the current project. If the pinned id
  // doesn't belong to the focused project (or matches the focused runner),
  // the memo returns null and the split collapses. This is intentional:
  // cross-project pinning is out of scope — `rootsFor` and Editor only see
  // the focused project's folders anyway.
  const secondary = createMemo<RunnerUI | null>(() => {
    const pinned = secondaryAgentId();
    if (!pinned) return null;
    const proj = focusedProject();
    if (!proj) return null;
    const r = proj.runners.find((x) => x.id === pinned);
    if (!r) return null;
    if (focusedRunner()?.id === r.id) return null;
    return r;
  });

  // Opening a file via palette/grep auto-switches to the editor.
  createEffect(() => {
    if (editorOpenRequest()) setView("editor");
  });

  onMount(() => {
    migrateLegacyLocalStorage();
    loadProjects().catch(console.error);
    attachRunnerStatusListener().catch(console.error);
    // Probe installed AI CLIs in the background — the result fills the
    // "+ agent" dropdown. Probe is cheap (~50ms) and cached.
    import("./stores/clis").then((m) => m.ensureClisDetected().catch(console.error));

    let notifAllowed = false;
    isPermissionGranted()
      .then(async (granted) => {
        if (!granted) granted = (await requestPermission()) === "granted";
        notifAllowed = granted;
      })
      .catch(() => {});

    // Notify on idle transitions: detect a runner's status going from a
    // working state back to idle, and surface it via system notification.
    const prev = new Map<string, AgentStatus>();
    let unlistenStatus: UnlistenFn | undefined;
    listen<{ projectId: string; runnerId: string; status: AgentStatus }>(
      "runner-status",
      (e) => {
        const { projectId, runnerId, status } = e.payload;
        const previous = prev.get(runnerId);
        prev.set(runnerId, status);
        const becameIdle =
          (previous === "streaming" || previous === "tool_running") &&
          status === "idle";
        const focusedId = focusedRunner()?.id ?? null;
        if (becameIdle && runnerId !== focusedId && notifAllowed) {
          const proj = projectsStore.list.find((p) => p.id === projectId);
          const r = proj?.runners.find((x) => x.id === runnerId);
          if (r) {
            sendNotification({
              title: `${r.name} is ready`,
              body: "Claude finished its turn.",
            });
          }
        }
      },
    ).then((u) => {
      unlistenStatus = u;
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && workflowOpen()) {
        e.preventDefault();
        setWorkflowOpen(false);
        return;
      }
      if (!e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key === "d") {
        e.preventDefault();
        toggleWorkflow();
        return;
      }
      if (key === "t") {
        e.preventDefault();
        openCreator({ mode: "project" });
        return;
      }
      if (key === "n" && e.shiftKey) {
        e.preventDefault();
        const p = focusedProject();
        if (p) createRunnerInProject(p.id, "agent").catch(console.error);
        return;
      }
      if (key === "w" && e.shiftKey) {
        e.preventDefault();
        const p = focusedProject();
        if (p) closeProject(p.id).catch(console.error);
        return;
      }
      if (key === "w") {
        e.preventDefault();
        const r = focusedRunner();
        if (r) closeRunner(r.id).catch(console.error);
        return;
      }
      if (key === "e") {
        e.preventDefault();
        cycleView();
        return;
      }
      if (key === "i") {
        e.preventDefault();
        toggleComposer();
        return;
      }
      if (key === "p") {
        e.preventDefault();
        if (focusedProject()) setPalette("files");
        return;
      }
      if (key === "f" && e.shiftKey) {
        e.preventDefault();
        if (focusedProject()) setPalette("grep");
        return;
      }
      if (e.key === "\\") {
        e.preventDefault();
        const r = focusedRunner();
        const p = focusedProject();
        if (r && p) {
          const fallback = p.runners.find((x) => x.id !== r.id)?.id ?? null;
          smartPin(r.id, r.id, fallback, (id) => focusRunner(p.id, id));
        }
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        focusByProjectIndex(parseInt(e.key, 10) - 1);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      unlistenStatus?.();
    });
  });

  // Computes the folder roots Editor/Diff use. With the new model the
  // project IS the source of truth (no separate workspace lookup needed).
  const roots = () => focusedProject()?.folders ?? [];

  return (
    <div class="flex h-screen w-screen flex-col overflow-hidden bg-[#0b0d10] text-[#e6e6e6]">
      <div
        class="h-7 shrink-0 select-none"
        data-tauri-drag-region
        title="Cosmos"
      />
      <div class="relative flex min-h-0 min-w-0 flex-1">
        <Sidebar />
        <main class="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <Show when={workflowOpen()}>
            <WorkflowView />
          </Show>

          <Show when={!workflowOpen()}>
            <Show when={focusedProject()} fallback={<EmptyState />} keyed>
              {(p) => (
                <>
                  <Show when={!composerExpanded()}>
                    <ProjectTitleBar project={p} />
                    <Show when={view() === "runners"}>
                      <RunnerTabs project={p} />
                    </Show>
                  </Show>

                  <div class="flex min-h-0 min-w-0 flex-1">
                    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                      <Show when={view() === "runners"}>
                        <Show
                          when={focusedRunner()}
                          fallback={<NoRunnerState />}
                          keyed
                        >
                          {(r) => (
                            <>
                              <div
                                class="flex min-h-0 min-w-0 flex-1 flex-col"
                                classList={{ hidden: composerExpanded() }}
                              >
                                <Terminal
                                  runner={r}
                                  projectId={p.id}
                                  cwd={p.cwd}
                                />
                              </div>
                              <Show when={composerVisible()}>
                                <InputBar id={r.id} agentName={r.name} />
                              </Show>
                            </>
                          )}
                        </Show>
                      </Show>
                      <Show when={view() === "editor"}>
                        <Editor roots={roots()} />
                      </Show>
                      <Show when={view() === "diff"}>
                        <DiffView roots={roots()} />
                      </Show>
                      <Show when={view() === "memory"}>
                        <MemoryView project={p} />
                      </Show>
                    </div>

                    <Show when={secondary() && view() === "runners"}>
                      <SplitDivider />
                      <div
                        class="flex min-h-0 flex-col border-l border-white/10 bg-[#0b0d10]"
                        style={{
                          width: `${splitWidthPct()}%`,
                          "min-width": "240px",
                          "max-width": "70%",
                        }}
                      >
                        <div class="flex h-7 shrink-0 items-center justify-between border-b border-white/5 px-3 text-[11px] text-white/45">
                          <span class="truncate">
                            pinned · {secondary()!.name}
                          </span>
                          <button
                            class="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"
                            onClick={() => setSecondaryAgent(null)}
                            title="unpin"
                          >
                            <PanelRightClose size={12} />
                          </button>
                        </div>
                        <Terminal
                          runner={secondary()!}
                          projectId={p.id}
                          cwd={p.cwd}
                        />
                      </div>
                    </Show>
                  </div>
                </>
              )}
            </Show>

            <Show when={palette() && focusedProject()}>
              <CommandPalette
                mode={palette()!}
                roots={roots()}
                onClose={() => setPalette(null)}
              />
            </Show>
          </Show>

          <Show when={creator()}>
            <AgentCreatorModal
              editingProjectId={creator()!.editingProjectId}
              onClose={closeCreator}
            />
          </Show>
        </main>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-white/40">
      <p class="text-sm">no projects yet</p>
      <button
        class="flex items-center gap-2 rounded-md border border-white/15 px-3 py-2 text-sm text-white/85 hover:border-white/30 hover:bg-white/5 hover:text-white"
        onClick={() => openCreator({ mode: "project" })}
      >
        <Layers size={14} />
        new project
      </button>
      <p class="text-[11px] text-white/30">⌘T anywhere</p>
    </div>
  );
}

function NoRunnerState() {
  return (
    <div class="flex flex-1 items-center justify-center text-[12px] text-white/35">
      no runner — pick "+ agent" or "+ shell" above
    </div>
  );
}


function SplitDivider() {
  let dragging = false;
  function onMouseDown(e: MouseEvent) {
    dragging = true;
    e.preventDefault();
    const main = (e.target as HTMLElement).closest("main");
    const move = (ev: MouseEvent) => {
      if (!dragging || !main) return;
      const rect = main.getBoundingClientRect();
      const fromRight = rect.right - ev.clientX;
      const pct = (fromRight / rect.width) * 100;
      setSplitWidthPct(pct);
    };
    const up = () => {
      dragging = false;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  return (
    <div
      class="w-1 shrink-0 cursor-col-resize bg-white/0 transition hover:bg-white/15"
      onMouseDown={onMouseDown}
    />
  );
}
