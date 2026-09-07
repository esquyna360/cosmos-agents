import {
  createEffect,
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
import { Layers, Layers2 } from "lucide-solid";

import Sidebar from "./components/Sidebar";
import TitleBar from "./components/TitleBar";
import ProjectBar from "./components/ProjectBar";
import PaneGrid from "./components/PaneGrid";
import Editor from "./components/Editor";
import InputBar from "./components/InputBar";
import CommandPalette, { type PaletteMode } from "./components/CommandPalette";
import DiffView from "./components/DiffView";
import WorkflowView from "./components/WorkflowView";
import AgentCreatorModal from "./components/AgentCreatorModal";
import UpdateBanner from "./components/UpdateBanner";
import RunnerTabs from "./components/RunnerTabs";
import MemoryView from "./components/MemoryView";
import InlineEdit from "./components/InlineEdit";
import { colorForPath } from "./lib/colorHash";
import { creator, openCreator, closeCreator } from "./stores/creator";
import {
  attachExternalChangesListener,
  attachRunnerStatusListener,
  createRunnerInProject,
  editorOpenRequest,
  focusByProjectIndex,
  focusedProject,
  focusedRunner,
  loadProjects,
  migrateLegacyLocalStorage,
  projectsStore,
  sleepProject,
  stopRunner,
  updateProject,
  type ProjectUI,
} from "./stores/projects";
import {
  composerExpanded,
  composerVisible,
  cycleView,
  setView,
  setWorkflowOpen,
  sidebarOpen,
  toggleComposer,
  toggleSidebar,
  toggleWorkflow,
  view,
  workflowOpen,
} from "./stores/layout";
import {
  LAYOUTS,
  setActiveSlot,
  setLayout,
  toggleSplit,
} from "./stores/panes";
import type { AgentStatus } from "./lib/ipc";

export default function App() {
  const [palette, setPalette] = createSignal<PaletteMode | null>(null);

  // Opening a file via palette/grep auto-switches to the editor.
  createEffect(() => {
    if (editorOpenRequest()) setView("editor");
  });

  onMount(() => {
    migrateLegacyLocalStorage();
    loadProjects().catch(console.error);
    attachRunnerStatusListener().catch(console.error);
    attachExternalChangesListener().catch(console.error);
    // Probe installed AI CLIs in the background — the result fills the
    // "agent" dropdown. Probe is cheap (~50ms) and cached.
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
              title: `${r.name} terminou`,
              body: `${proj?.name ?? "projeto"} · pronto para o próximo passo.`,
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
      // ⌃1–4 focuses a pane. Kept off ⌘ so ⌘1–9 stays on projects.
      if (e.ctrlKey && !e.metaKey && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        setActiveSlot(parseInt(e.key, 10) - 1);
        return;
      }
      if (!e.metaKey) return;
      const key = e.key.toLowerCase();
      // ⌘⌥1–5 switches the grid layout.
      if (e.altKey && /^[1-9]$/.test(e.code.replace("Digit", ""))) {
        const n = parseInt(e.code.replace("Digit", ""), 10);
        if (n >= 1 && n <= LAYOUTS.length) {
          e.preventDefault();
          setLayout(LAYOUTS[n - 1].id);
          return;
        }
      }
      if (key === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
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
        if (p) sleepProject(p.id).catch(console.error);
        return;
      }
      if (key === "w") {
        e.preventDefault();
        const r = focusedRunner();
        if (r) stopRunner(r.id).catch(console.error);
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
      if (key === "p" || (key === "k" && !e.shiftKey)) {
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
        toggleSplit();
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
    <div class="flex h-screen w-screen flex-col overflow-hidden bg-void text-ink">
      <TitleBar center={<ProjectIdentity />} />

      <div class="relative flex min-h-0 min-w-0 flex-1">
        <Show when={sidebarOpen()}>
          <Sidebar />
        </Show>

        <main class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-void">
          <Show when={workflowOpen()}>
            <WorkflowView />
          </Show>

          <Show when={!workflowOpen()}>
            <Show when={focusedProject()} fallback={<EmptyState />} keyed>
              {(p) => (
                <>
                  <Show when={!composerExpanded()}>
                    <ProjectBar project={p} />
                    <Show when={view() === "runners"}>
                      <RunnerTabs project={p} />
                    </Show>
                  </Show>

                  <Show when={view() === "runners"}>
                    <div
                      class="flex min-h-0 min-w-0 flex-1 flex-col"
                      classList={{ hidden: composerExpanded() }}
                    >
                      <PaneGrid project={p} />
                    </div>
                    <Show when={composerVisible() && focusedRunner()} keyed>
                      {(r) => <InputBar id={r.id} agentName={r.name} />}
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
      <UpdateBanner />
    </div>
  );
}

/** The project's name and shape, shown in the middle of the title bar. */
function ProjectIdentity() {
  const p = () => focusedProject() as ProjectUI | null;
  return (
    <Show when={p()} keyed>
      {(proj) => (
        <div data-no-drag class="flex min-w-0 items-center gap-2">
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            style={{
              "background-color": colorForPath(proj.cwd),
              "box-shadow": proj.promotedLive
                ? `0 0 8px ${colorForPath(proj.cwd)}`
                : "none",
              opacity: proj.promotedLive ? 1 : 0.4,
            }}
          />
          <Show when={proj.folders.length > 1}>
            <Layers2 size={12} class="shrink-0 text-faint" />
          </Show>
          <span class="min-w-0 truncate text-[13px] font-medium">
            <InlineEdit
              value={proj.name}
              onCommit={(next) => {
                const trimmed = next.trim();
                if (!trimmed || trimmed === proj.name) return;
                updateProject(proj.id, trimmed, proj.folders, proj.memory).catch(
                  console.error,
                );
              }}
            >
              {(name) => (
                <span
                  class="truncate"
                  title={`slug: ${proj.slug} — renomear muda o rótulo, não a pasta`}
                >
                  {name}
                </span>
              )}
            </InlineEdit>
          </span>
        </div>
      )}
    </Show>
  );
}

function EmptyState() {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-4 text-faint">
      <div class="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-white/[0.03]">
        <Layers size={22} class="text-dim" />
      </div>
      <p class="text-[13px] text-dim">nenhum projeto ainda</p>
      <button
        class="flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-[12.5px] text-ink transition hover:border-white/30 hover:bg-white/6"
        onClick={() => openCreator({ mode: "project" })}
      >
        <Layers size={13} />
        criar projeto
      </button>
      <p class="text-[11px]">⌘T de qualquer lugar</p>
    </div>
  );
}
