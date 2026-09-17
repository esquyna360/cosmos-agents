import {
  createEffect,
  createSignal,
  on,
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
import { MessageSquare, SquareTerminal } from "lucide-solid";

import TopStrip, { ChildStrip } from "./components/TopStrip";
import HubView from "./components/HubView";
import HomeView from "./components/HomeView";
import SideNav from "./components/SideNav";
import ProjectView from "./components/ProjectView";
import NewAgentModal from "./components/NewAgentModal";
import AddProjectModal from "./components/AddProjectModal";
import { DeleteProjectDialog } from "./components/menus";
import SessionView from "./components/SessionView";
import Inspector from "./components/Inspector";
import JumpPalette from "./components/JumpPalette";
import CommandPalette, { type PaletteMode } from "./components/CommandPalette";
import AgentCreatorModal from "./components/AgentCreatorModal";
import UpdateBanner from "./components/UpdateBanner";
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
  go,
  navMode,
  projectTab,
  route,
  routeProjectId,
  setNavMode,
  setProjectTab,
  type ProjectTab,
} from "./stores/nav";
import { startGitWatch } from "./stores/git";
import {
  inspector,
  settingsOpen,
  toggleSettings,
  toggleSidebar,
} from "./stores/layout";
import { cycleTheme, initTheme } from "./stores/theme";
import { startUpdateWatch } from "./stores/updates";
import { ptyLiveIds, type AgentStatus } from "./lib/ipc";
import { isClaudeRunner } from "./lib/projects";

export default function App() {
  const [palette, setPalette] = createSignal<PaletteMode | null>(null);

  // Opening a file via palette/grep auto-switches to the editor.
  // Only a new request navigates: tracking the route here would bounce every
  // later navigation back to the project.
  createEffect(
    on(editorOpenRequest, (req) => {
      if (!req) return;
      const id = routeProjectId();
      if (!id) return;
      if (route().kind !== "project") go({ kind: "project", projectId: id });
      setProjectTab("files");
    }),
  );

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
    startGitWatch();
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
      if (!e.metaKey) return;
      const key = e.key.toLowerCase();
      if (e.key === ",") {
        e.preventDefault();
        toggleSettings();
        return;
      }
      if (key === "b") {
        e.preventDefault();
        if (navMode() === "tabs") setNavMode("sidebar");
        else toggleSidebar();
        return;
      }
      if (key === "h" && e.shiftKey) {
        e.preventDefault();
        go({ kind: "hub" });
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        go({ kind: "home" });
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
        const id = routeProjectId();
        if (!e.shiftKey) openCreator({ mode: "agent", projectId: id ?? undefined });
        else if (id) newTerminal(id).catch(console.error);
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
        const id = routeProjectId();
        if (!id) return;
        if (route().kind !== "project") {
          go({ kind: "project", projectId: id });
          setProjectTab("files");
          return;
        }
        const i = PROJECT_TABS.indexOf(projectTab());
        setProjectTab(PROJECT_TABS[(i + 1) % PROJECT_TABS.length]);
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
    <div class="flex h-screen w-screen flex-col overflow-hidden bg-void text-ink">
      <TopStrip />
      <ChildStrip />

      <div class="flex min-h-0 flex-1">
      <Show when={navMode() === "sidebar"}>
        <SideNav />
      </Show>
      <main class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-void">
          <Show when={route().kind === "home"}>
            <HomeView />
          </Show>
          <Show when={route().kind === "hub"}>
            <HubView />
          </Show>
          <Show when={route().kind === "project" && focusedProject()} keyed>
            {(p) => <ProjectView project={p} />}
          </Show>
          <Show when={route().kind === "session" && focusedProject()} keyed>
            {(p) => (
              <div class="flex min-h-0 min-w-0 flex-1">
                <Show when={focusedRunner()} fallback={<NoSession project={p} />}>
                  {(r) => <SessionView project={p} runner={r()} />}
                </Show>
                <Show when={inspector()}>
                  <Inspector project={p} runner={focusedRunner()} />
                </Show>
              </div>
            )}
          </Show>

          <Show when={palette() && focusedProject()}>
            <CommandPalette mode={palette()!} roots={roots()} onClose={() => setPalette(null)} />
          </Show>
      </main>
      </div>

      <Show when={creator()} keyed>
        {(c) => (
          <Show
            when={c.mode === "agent"}
            fallback={
              <Show
                when={"editingProjectId" in c && c.editingProjectId}
                fallback={<AddProjectModal onClose={closeCreator} />}
              >
                {(id) => <AgentCreatorModal editingProjectId={id()} onClose={closeCreator} />}
              </Show>
            }
          >
            <NewAgentModal projectId={"projectId" in c ? c.projectId : undefined} onClose={closeCreator} />
          </Show>
        )}
      </Show>
      <DeleteProjectDialog />
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

const PROJECT_TABS: ProjectTab[] = ["overview", "files", "diff", "memory", "browser"];

function NoSession(props: { project: ProjectUI }) {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-3">
      <p class="font-heading text-[20px] text-ink">Esse agente não existe mais</p>
      <div class="mt-1 flex gap-2">
        <button class="cx-btn-primary" onClick={() => openCreator({ mode: "agent", projectId: props.project.id })}>
          <MessageSquare size={13} />
          Novo agente
        </button>
        <button class="cx-pill cx-pill-line" onClick={() => void newTerminal(props.project.id)}>
          <SquareTerminal size={13} />
          Novo terminal
        </button>
      </div>
    </div>
  );
}
