import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { X, FolderPlus } from "lucide-solid";

import { createAgent, createSiblingAgent } from "../stores/agents";
import { createWorkspace, updateWorkspace } from "../stores/workspaces";
import type { Workspace } from "../lib/workspaces";

type Mode = "agent" | "workspace";

interface Props {
  /** When provided, modal opens in workspace-edit mode (pre-filled, calls update). */
  initialWorkspace?: Workspace;
  /** Pre-select the workspace tab even when no initialWorkspace (creating a new ws). */
  initialMode?: Mode;
  onClose: () => void;
}

const MAX_FOLDERS = 6;

function basenameOf(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export default function AgentCreatorModal(props: Props) {
  const isEdit = !!props.initialWorkspace;
  const [mode, setMode] = createSignal<Mode>(
    isEdit ? "workspace" : props.initialMode ?? "agent",
  );

  // Agent fields
  const [agentFolder, setAgentFolder] = createSignal<string | null>(null);
  const [agentName, setAgentName] = createSignal("");

  // Workspace fields
  const [wsName, setWsName] = createSignal(props.initialWorkspace?.name ?? "");
  const [wsFolders, setWsFolders] = createSignal<string[]>(
    props.initialWorkspace?.folders ?? [],
  );
  const [wsMemory, setWsMemory] = createSignal(props.initialWorkspace?.memory ?? "");

  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function pickFolder(): Promise<string | null> {
    try {
      const picked = await open({ directory: true, multiple: false });
      return typeof picked === "string" ? picked : null;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async function addAgentFolder() {
    const f = await pickFolder();
    if (f) setAgentFolder(f);
  }

  async function addWsFolder() {
    const f = await pickFolder();
    if (!f) return;
    setWsFolders((cur) => {
      if (cur.includes(f)) return cur;
      if (cur.length >= MAX_FOLDERS) return cur;
      return [...cur, f];
    });
  }

  function removeWsFolder(path: string) {
    setWsFolders((cur) => cur.filter((p) => p !== path));
  }

  async function submit() {
    if (submitting()) return;
    setError(null);
    setSubmitting(true);
    try {
      if (mode() === "agent") {
        const folder = agentFolder();
        if (!folder) {
          setError("pick a folder first");
          return;
        }
        await createAgent(folder, {
          explicitName: agentName().trim() || undefined,
        });
      } else if (isEdit && props.initialWorkspace) {
        if (!wsName().trim()) {
          setError("workspace needs a name");
          return;
        }
        if (wsFolders().length === 0) {
          setError("add at least one folder");
          return;
        }
        await updateWorkspace(
          props.initialWorkspace.id,
          wsName().trim(),
          wsFolders(),
          wsMemory(),
        );
      } else {
        if (!wsName().trim()) {
          setError("workspace needs a name");
          return;
        }
        if (wsFolders().length === 0) {
          setError("add at least one folder");
          return;
        }
        const ws = await createWorkspace(wsName().trim(), wsFolders(), wsMemory());
        // Spawn the first agent of this workspace immediately.
        await createSiblingAgent(ws.cwd).catch(async () => {
          // If no prior agents in this cwd, createSiblingAgent still works as
          // a regular createAgent (it filters by cwd, sees none, creates one).
        });
      }
      props.onClose();
    } catch (e) {
      console.error("[modal] submit failed", e);
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  onMount(() => document.addEventListener("keydown", onKey, true));
  onCleanup(() => document.removeEventListener("keydown", onKey, true));

  return (
    <div
      class="absolute inset-0 z-50 flex items-start justify-center bg-black/45 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="mt-16 w-[640px] max-w-[92vw] overflow-hidden rounded-lg border border-white/10 bg-[#0e1116] shadow-2xl">
        <div class="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
          <div class="text-xs uppercase tracking-wider text-white/40">
            {isEdit ? "edit workspace" : "new"}
          </div>
          <button
            class="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"
            onClick={props.onClose}
            title="close (esc)"
          >
            <X size={14} />
          </button>
        </div>

        <Show when={!isEdit}>
          <div class="flex gap-1 border-b border-white/5 bg-white/[0.02] p-1.5">
            <ModeTab label="single folder" active={mode() === "agent"} onClick={() => setMode("agent")} />
            <ModeTab label="workspace" active={mode() === "workspace"} onClick={() => setMode("workspace")} />
          </div>
        </Show>

        <div class="p-4">
          <Show when={mode() === "agent"}>
            <div class="space-y-3">
              <FieldLabel>folder</FieldLabel>
              <Show
                when={agentFolder()}
                fallback={
                  <button
                    class="flex w-full items-center gap-2 rounded-md border border-dashed border-white/15 px-3 py-2.5 text-sm text-white/60 hover:border-white/30 hover:text-white"
                    onClick={addAgentFolder}
                  >
                    <FolderPlus size={14} />
                    pick a folder…
                  </button>
                }
              >
                <div class="flex items-center justify-between rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm">
                  <span class="truncate text-white/85">{agentFolder()}</span>
                  <button
                    class="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"
                    onClick={addAgentFolder}
                    title="pick another"
                  >
                    <FolderPlus size={13} />
                  </button>
                </div>
              </Show>

              <FieldLabel>name <span class="text-white/30">(optional)</span></FieldLabel>
              <input
                class="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-white/25"
                value={agentName()}
                placeholder={agentFolder() ? basenameOf(agentFolder()!) : "leave blank to use folder name"}
                onInput={(e) => setAgentName(e.currentTarget.value)}
              />
            </div>
          </Show>

          <Show when={mode() === "workspace"}>
            <div class="space-y-3">
              <FieldLabel>name</FieldLabel>
              <input
                class="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-white/25"
                value={wsName()}
                placeholder="e.g. datanomik fullstack"
                onInput={(e) => setWsName(e.currentTarget.value)}
              />

              <div class="flex items-center justify-between">
                <FieldLabel>folders ({wsFolders().length}/{MAX_FOLDERS})</FieldLabel>
                <button
                  class="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-white/60 hover:bg-white/5 hover:text-white disabled:opacity-40"
                  onClick={addWsFolder}
                  disabled={wsFolders().length >= MAX_FOLDERS}
                >
                  <FolderPlus size={12} />
                  add folder
                </button>
              </div>
              <Show
                when={wsFolders().length > 0}
                fallback={
                  <div class="rounded-md border border-dashed border-white/10 px-3 py-3 text-center text-xs text-white/35">
                    no folders yet — add at least one
                  </div>
                }
              >
                <ul class="space-y-1">
                  <For each={wsFolders()}>
                    {(f) => (
                      <li class="flex items-center justify-between rounded-md border border-white/10 bg-black/30 px-3 py-1.5 text-xs">
                        <span class="truncate text-white/85" title={f}>{f}</span>
                        <button
                          class="rounded p-0.5 text-white/40 hover:bg-white/10 hover:text-white"
                          onClick={() => removeWsFolder(f)}
                          title="remove"
                        >
                          <X size={12} />
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>

              <FieldLabel>memory <span class="text-white/30">(optional — pasted into CLAUDE.md)</span></FieldLabel>
              <textarea
                class="w-full resize-none rounded-md border border-white/10 bg-black/30 px-3 py-2 text-[12.5px] leading-5 text-white outline-none focus:border-white/25"
                style={{ "font-family": '"Fira Code", ui-monospace, monospace' }}
                rows={5}
                placeholder="context the agent should remember: stack notes, conventions, where to look first…"
                value={wsMemory()}
                onInput={(e) => setWsMemory(e.currentTarget.value)}
              />
            </div>
          </Show>

          <Show when={error()}>
            <p class="mt-3 text-[11px] text-red-400">{error()}</p>
          </Show>

          <div class="mt-4 flex items-center justify-between">
            <span class="text-[10px] text-white/30">⌘↵ submit · esc cancel</span>
            <button
              class="rounded-md bg-white/15 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={submit}
              disabled={submitting()}
            >
              {submitting()
                ? "working…"
                : isEdit
                  ? "save"
                  : mode() === "agent"
                    ? "spawn agent"
                    : "create workspace"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModeTab(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      class="flex-1 rounded px-3 py-1.5 text-sm text-white/55 transition hover:bg-white/5 hover:text-white"
      classList={{ "bg-white/15 !text-white": props.active }}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function FieldLabel(props: { children: any }) {
  return (
    <label class="text-[10px] uppercase tracking-wider text-white/40">
      {props.children}
    </label>
  );
}
