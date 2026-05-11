import { createEffect, onCleanup, onMount, Show } from "solid-js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import Sidebar from "./components/Sidebar";
import Terminal from "./components/Terminal";
import Editor from "./components/Editor";
import InputBar from "./components/InputBar";
import CommandPalette, { type PaletteMode } from "./components/CommandPalette";
import DiffView from "./components/DiffView";
import ViewSwitcher from "./components/ViewSwitcher";
import WorkflowView from "./components/WorkflowView";
import {
  agents,
  closeAgent,
  editorOpenRequest,
  focused,
  focusByIndex,
  focusedAgentId,
  loadFromDisk,
  pickAndCreate,
  setStatus,
} from "./stores/agents";
import {
  composerVisible,
  cycleView,
  setView,
  setWorkflowOpen,
  toggleComposer,
  toggleWorkflow,
  view,
  workflowOpen,
} from "./stores/layout";
import { createSignal } from "solid-js";
import type { AgentStatus } from "./lib/ipc";

export default function App() {
  const [palette, setPalette] = createSignal<PaletteMode | null>(null);

  // Opening a file via palette/grep auto-switches to the editor.
  createEffect(() => {
    if (editorOpenRequest()) setView("editor");
  });

  onMount(() => {
    loadFromDisk().catch(console.error);

    let notifAllowed = false;
    isPermissionGranted()
      .then(async (granted) => {
        if (!granted) granted = (await requestPermission()) === "granted";
        notifAllowed = granted;
      })
      .catch(() => {});

    const prev = new Map<string, AgentStatus>();

    let unlistenStatus: UnlistenFn | undefined;
    listen<{ id: string; status: AgentStatus }>("agent-status", (e) => {
      const { id, status } = e.payload;
      const previous = prev.get(id);
      prev.set(id, status);
      setStatus(id, status);

      const becameIdle =
        (previous === "streaming" || previous === "tool_running") &&
        status === "idle";
      if (becameIdle && id !== focusedAgentId() && notifAllowed) {
        const a = agents.list.find((x) => x.id === id);
        if (a) {
          sendNotification({
            title: `${a.name} is ready`,
            body: "Claude finished its turn.",
          });
        }
      }
    }).then((u) => {
      unlistenStatus = u;
    });

    const onKey = (e: KeyboardEvent) => {
      // Workflow view has its own Escape shortcut and ignores most modifiers
      // for typing safety.
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
        pickAndCreate();
        return;
      }
      if (key === "w") {
        e.preventDefault();
        const f = focused();
        if (f) closeAgent(f.id);
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
        if (focused()) setPalette("files");
        return;
      }
      if (key === "f" && e.shiftKey) {
        e.preventDefault();
        if (focused()) setPalette("grep");
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        focusByIndex(parseInt(e.key, 10) - 1);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      unlistenStatus?.();
    });
  });

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
            <Show when={focused()}>
              <div class="shrink-0 border-b border-white/5">
                <ViewSwitcher />
              </div>
            </Show>
          </Show>
          <Show
            when={!workflowOpen() && focused()}
            fallback={
              <div class="flex flex-1 items-center justify-center text-white/30">
                no agent — ⌘T to spawn
              </div>
            }
            keyed
          >
            {(a) => (
              <>
                <Show when={view() === "terminal"}>
                  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                    <Terminal id={a.id} cwd={a.cwd} />
                    <Show when={composerVisible()}>
                      <InputBar id={a.id} agentName={a.name} />
                    </Show>
                  </div>
                </Show>
                <Show when={view() === "editor"}>
                  <Editor root={a.cwd} />
                </Show>
                <Show when={view() === "diff"}>
                  <DiffView root={a.cwd} />
                </Show>
              </>
            )}
          </Show>
          <Show when={palette() && focused()}>
            <CommandPalette
              mode={palette()!}
              root={focused()!.cwd}
              onClose={() => setPalette(null)}
            />
          </Show>
        </main>
      </div>
    </div>
  );
}
