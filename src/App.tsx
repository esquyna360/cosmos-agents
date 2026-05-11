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
import { FolderPlus, Layers, PanelRightClose } from "lucide-solid";

import Sidebar from "./components/Sidebar";
import Terminal from "./components/Terminal";
import Editor from "./components/Editor";
import InputBar from "./components/InputBar";
import CommandPalette, { type PaletteMode } from "./components/CommandPalette";
import DiffView from "./components/DiffView";
import ViewSwitcher from "./components/ViewSwitcher";
import WorkflowView from "./components/WorkflowView";
import AgentCreatorModal from "./components/AgentCreatorModal";
import { loadWorkspaces, workspaceByCwd } from "./stores/workspaces";
import { creator, openCreator, closeCreator } from "./stores/creator";
import {
  agents,
  closeAgent,
  createSiblingAgent,
  editorOpenRequest,
  focused,
  focusByIndex,
  focusedAgentId,
  loadFromDisk,
  setStatus,
} from "./stores/agents";
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

function rootsFor(agentCwd: string): string[] {
  const ws = workspaceByCwd().get(agentCwd.replace(/\/+$/, ""));
  return ws ? ws.folders : [agentCwd];
}

function diffRootsFor(agentCwd: string): string[] {
  const ws = workspaceByCwd().get(agentCwd.replace(/\/+$/, ""));
  return ws ? ws.folders : [agentCwd];
}

export default function App() {
  const [palette, setPalette] = createSignal<PaletteMode | null>(null);

  // Memo so the same reactive scope drives both the diagnostic strip and the
  // split's <Show when=>. Solid tracks signal reads inside the memo, then
  // anything reading the memo re-runs when those signals change.
  const secondary = createMemo(() => {
    const id = secondaryAgentId();
    if (!id) return null;
    const a = agents.list.find((x) => x.id === id);
    if (!a) return null;
    if (focused()?.id === a.id) return null;
    return a;
  });

  // Opening a file via palette/grep auto-switches to the editor.
  createEffect(() => {
    if (editorOpenRequest()) setView("editor");
  });

  onMount(() => {
    loadFromDisk().catch(console.error);
    loadWorkspaces().catch(console.error);

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
        openCreator({ mode: "agent" });
        return;
      }
      if (key === "n" && e.shiftKey) {
        e.preventDefault();
        const f = focused();
        if (f) createSiblingAgent(f.cwd).catch(console.error);
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
      if (e.key === "\\") {
        e.preventDefault();
        const f = focused();
        if (f) {
          const fallback = agents.list.find((x) => x.id !== f.id)?.id ?? null;
          smartPin(f.id, f.id, fallback, (id) =>
            focusByIndex(agents.list.findIndex((x) => x.id === id)),
          );
        }
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
          {/* Workflow view replaces the whole main area when active. */}
          <Show when={workflowOpen()}>
            <WorkflowView />
          </Show>

          {/* Normal mode: view switcher + body + (optional) palette overlay + diagnostic */}
          <Show when={!workflowOpen()}>
            {/* When the composer is expanded the whole agent area belongs to
                it — hide ViewSwitcher and the diagnostic strip too. */}
            <Show when={focused() && !composerExpanded()}>
              <div class="shrink-0 border-b border-white/5">
                <ViewSwitcher />
              </div>
            </Show>

            <Show when={focused()} fallback={<EmptyState />} keyed>
              {(a) => (
                <div class="flex min-h-0 min-w-0 flex-1">
                  {/* Primary pane: terminal / editor / diff. When the composer
                      is focused (expanded), we hide the terminal so the
                      InputBar can claim the whole pane via flex-1 without
                      a 50/50 fight between two flex-1 siblings. */}
                  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                    <Show when={view() === "terminal"}>
                      <div
                        class="flex min-h-0 min-w-0 flex-1 flex-col"
                        classList={{ hidden: composerExpanded() }}
                      >
                        <Terminal id={a.id} cwd={a.cwd} />
                      </div>
                      <Show when={composerVisible()}>
                        <InputBar id={a.id} agentName={a.name} />
                      </Show>
                    </Show>
                    <Show when={view() === "editor"}>
                      <Editor roots={rootsFor(a.cwd)} />
                    </Show>
                    <Show when={view() === "diff"}>
                      <DiffView roots={diffRootsFor(a.cwd)} />
                    </Show>
                  </div>

                  {/* Right (pinned) pane: visible whenever secondary memo
                      resolves to an agent AND we're on the terminal view. */}
                  <Show when={secondary() && view() === "terminal"}>
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
                      <Terminal id={secondary()!.id} cwd={secondary()!.cwd} />
                    </div>
                  </Show>
                </div>
              )}
            </Show>

            <Show when={palette() && focused()}>
              <CommandPalette
                mode={palette()!}
                roots={rootsFor(focused()!.cwd)}
                onClose={() => setPalette(null)}
              />
            </Show>
          </Show>

          <Show when={creator()}>
            <AgentCreatorModal
              initialMode={creator()!.mode}
              initialWorkspace={creator()!.editing}
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
      <p class="text-sm">no agents yet</p>
      <div class="flex gap-2">
        <button
          class="flex items-center gap-2 rounded-md border border-white/15 px-3 py-2 text-sm text-white/85 hover:border-white/30 hover:bg-white/5 hover:text-white"
          onClick={() => openCreator({ mode: "agent" })}
        >
          <FolderPlus size={14} />
          new agent
        </button>
        <button
          class="flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-sm text-white/70 hover:border-white/25 hover:bg-white/5 hover:text-white"
          onClick={() => openCreator({ mode: "workspace" })}
        >
          <Layers size={14} />
          new workspace
        </button>
      </div>
      <p class="text-[11px] text-white/30">⌘T anywhere</p>
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
