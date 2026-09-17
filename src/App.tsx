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
import { ArrowLeft, Layers, MessageSquare, SquareTerminal } from "lucide-solid";

import Sidebar from "./components/Sidebar";
import PaneGrid from "./components/PaneGrid";
import SessionView from "./components/SessionView";
import Inspector from "./components/Inspector";
import JumpPalette from "./components/JumpPalette";
import Editor from "./components/Editor";
import CommandPalette, { type PaletteMode } from "./components/CommandPalette";
import DiffView from "./components/DiffView";
import WorkflowView from "./components/WorkflowView";
import AgentCreatorModal from "./components/AgentCreatorModal";
import UpdateBanner from "./components/UpdateBanner";
import MemoryView from "./components/MemoryView";
import Browser from "./components/Browser";
import SettingsPanel from "./components/SettingsPanel";
import { MenuHost } from "./ui/Menu";
import { creator, openCreator, closeCreator } from "./stores/creator";
import {
  attachExternalChangesListener,
  attachRunnerStatusListener,
  editorOpenRequest,
  focusByProjectIndex,
  focusedProject,
  focusedRunner,
  loadProjects,
  migrateLegacyLocalStorage,
  newSession,
  newTerminal,
  projectsStore,
  setRunnerMode,
  sleepProject,
  stopRunner,
  type ProjectUI,
} from "./stores/projects";
import { attachChatListeners } from "./stores/chat";
import { jumpOpen, openJump } from "./stores/jump";
import {
  cycleView,
  inspector,
  settingsOpen,
  setView,
  setWorkflowOpen,
  sidebarOpen,
  toggleSettings,
  toggleSidebar,
  toggleWorkflow,
  view,
  workflowOpen,
  type ViewMode,
} from "./stores/layout";
import {
  LAYOUTS,
  layout,
  setActiveSlot,
  setLayout,
  toggleSplit,
} from "./stores/panes";
import { cycleTheme, initTheme } from "./stores/theme";
import { startUpdateWatch } from "./stores/updates";
import { ptyLiveIds, type AgentStatus } from "./lib/ipc";
import { isClaudeRunner } from "./lib/projects";

export default function App() {
  const [palette, setPalette] = createSignal<PaletteMode | null>(null);

  // Opening a file via palette/grep auto-switches to the editor.
  createEffect(() => {
    if (editorOpenRequest()) setView("editor");
  });

  onMount(() => {
    initTheme();
    startUpdateWatch();
    migrateLegacyLocalStorage();
    loadProjects()
      .then(ptyLiveIds)
      .then(attachChatListeners)
      .catch(console.error);
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
        const needsYou = status === "awaiting_input" && previous !== "awaiting_input";
        const watching = runnerId === (focusedRunner()?.id ?? null) && document.hasFocus();
        if ((becameIdle || needsYou) && !watching && notifAllowed) {
          const proj = projectsStore.list.find((p) => p.id === projectId);
          const r = proj?.runners.find((x) => x.id === runnerId);
          if (r) {
            sendNotification({
              title: needsYou ? `${r.name} precisa de você` : `${r.name} terminou`,
              body: proj?.name ?? "",
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
      if (e.key === ",") {
        e.preventDefault();
        toggleSettings();
        return;
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
      if (key === "t" && e.shiftKey) {
        e.preventDefault();
        cycleTheme();
        return;
      }
      if (key === "t") {
        e.preventDefault();
        openCreator({ mode: "project" });
        return;
      }
      if (key === "n") {
        e.preventDefault();
        const p = focusedProject();
        if (!p) return;
        setView("runners");
        (e.shiftKey ? newTerminal(p.id) : newSession(p.id)).catch(console.error);
        return;
      }
      if (key === "j") {
        e.preventDefault();
        const r = focusedRunner();
        if (r && isClaudeRunner(r)) setRunnerMode(r.id, r.mode === "chat" ? "tty" : "chat").catch(console.error);
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
      if (key === "k" && !e.shiftKey) {
        // ⌘K clears a shell's screen; the terminal claims it first there.
        if (e.defaultPrevented) return;
        e.preventDefault();
        openJump();
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

  const roots = () => focusedProject()?.folders ?? [];

  return (
    <div class="flex h-screen w-screen overflow-hidden bg-void text-ink">
      <Show when={sidebarOpen()}>
        <Sidebar />
      </Show>

      <main class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-void">
        <Show when={workflowOpen()}>
          <WorkflowView />
        </Show>

        <Show when={!workflowOpen()}>
          <Show when={focusedProject()} fallback={<NoProjects />} keyed>
            {(p) => (
              <>
                <Show when={view() === "runners"}>
                  <div class="flex min-h-0 min-w-0 flex-1">
                    <Show
                      when={layout() === "single"}
                      fallback={
                        <div class="flex min-h-0 min-w-0 flex-1 flex-col pt-7" data-tauri-drag-region>
                          <PaneGrid project={p} />
                        </div>
                      }
                    >
                      <Show when={focusedRunner()} fallback={<NoSessions project={p} />}>
                        {(r) => <SessionView project={p} runner={r()} />}
                      </Show>
                    </Show>
                    <Show when={inspector()}>
                      <Inspector project={p} runner={focusedRunner()} />
                    </Show>
                  </div>
                </Show>
                <Show when={view() !== "runners"}>
                  <ViewBar project={p} />
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
                <Show when={view() === "browser"}>
                  <Browser projectId={p.id} />
                </Show>
              </>
            )}
          </Show>

          <Show when={palette() && focusedProject()}>
            <CommandPalette mode={palette()!} roots={roots()} onClose={() => setPalette(null)} />
          </Show>
        </Show>

        <Show when={creator()}>
          <AgentCreatorModal editingProjectId={creator()!.editingProjectId} onClose={closeCreator} />
        </Show>
      </main>

      <Show when={jumpOpen()}>
        <JumpPalette />
      </Show>
      <Show when={settingsOpen()}>
        <SettingsPanel />
      </Show>
      <MenuHost />
      <UpdateBanner />
    </div>
  );
}

const VIEW_NAMES: Record<ViewMode, string> = {
  runners: "Sessões",
  editor: "Arquivos",
  diff: "Mudanças",
  memory: "Memória",
  browser: "Navegador",
};

/** Header for the project-level tools; the way back to the sessions. */
function ViewBar(props: { project: ProjectUI }) {
  const others: ViewMode[] = ["editor", "diff", "memory", "browser"];
  return (
    <header
      data-tauri-drag-region
      class="flex h-[46px] shrink-0 items-center gap-1 border-b border-line pr-3"
      classList={{ "pl-[84px]": !sidebarOpen(), "pl-2.5": sidebarOpen() }}
    >
      <button
        class="mr-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-dim transition hover:bg-fill-2 hover:text-ink"
        onClick={() => setView("runners")}
      >
        <ArrowLeft size={13} />
        Sessões
      </button>
      {others.map((id) => (
        <button
          class="rounded-md px-2.5 py-1 text-[12.5px] transition"
          classList={{
            "bg-fill-2 text-ink": view() === id,
            "text-faint hover:text-ink": view() !== id,
          }}
          onClick={() => setView(id)}
        >
          {VIEW_NAMES[id]}
        </button>
      ))}
      <span class="ml-auto truncate text-[12px] text-faint">{props.project.name}</span>
    </header>
  );
}

function NoSessions(props: { project: ProjectUI }) {
  return (
    <div data-tauri-drag-region class="flex flex-1 flex-col items-center justify-center gap-3">
      <p class="text-[15px] font-medium text-ink">{props.project.name} ainda não tem sessões</p>
      <p class="max-w-[360px] text-center text-[13px] leading-relaxed text-dim">
        Uma sessão é uma conversa com o Claude sobre uma coisa só. Abra quantas precisar; cada uma
        ganha um nome sozinha.
      </p>
      <div class="mt-1 flex gap-2">
        <button
          class="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink transition hover:opacity-90"
          onClick={() => void newSession(props.project.id)}
        >
          <MessageSquare size={13} />
          Nova sessão
          <span class="opacity-70">⌘N</span>
        </button>
        <button
          class="flex items-center gap-2 rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] text-ink transition hover:bg-fill-2"
          onClick={() => void newTerminal(props.project.id)}
        >
          <SquareTerminal size={13} />
          Novo terminal
        </button>
      </div>
    </div>
  );
}

function NoProjects() {
  return (
    <div data-tauri-drag-region class="flex flex-1 flex-col items-center justify-center gap-3">
      <p class="text-[15px] font-medium text-ink">Nenhum projeto ainda</p>
      <p class="max-w-[340px] text-center text-[13px] leading-relaxed text-dim">
        Um projeto junta as pastas em que você trabalha. As sessões do Claude e os terminais ficam
        dentro dele.
      </p>
      <button
        class="mt-1 flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink transition hover:opacity-90"
        onClick={() => openCreator({ mode: "project" })}
      >
        <Layers size={13} />
        Criar projeto
        <span class="opacity-70">⌘T</span>
      </button>
    </div>
  );
}
