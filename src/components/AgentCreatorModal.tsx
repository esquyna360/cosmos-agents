import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { Bot, X, FolderPlus } from "lucide-solid";

import {
  createProjectWithAgent,
  projectsStore,
  updateProject,
  type ProjectUI,
} from "../stores/projects";
import { clisList, ensureClisDetected } from "../stores/clis";
import type { CliInfo } from "../lib/clis";

interface Props {
  /** When set, modal opens in edit mode (pre-filled, calls projectsUpdate). */
  editingProjectId?: string;
  onClose: () => void;
}

const MAX_FOLDERS = 6;

function basenameOf(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export default function AgentCreatorModal(props: Props) {
  const editing = (): ProjectUI | undefined =>
    props.editingProjectId
      ? projectsStore.list.find((p) => p.id === props.editingProjectId)
      : undefined;
  const isEdit = !!editing();

  const [name, setName] = createSignal(editing()?.name ?? "");
  const [folders, setFolders] = createSignal<string[]>(editing()?.folders ?? []);
  const [memory, setMemory] = createSignal(editing()?.memory ?? "");
  const [selectedCliId, setSelectedCliId] = createSignal<string | null>(null);

  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Probe installed CLIs lazily on mount. Default selection = first available.
  onMount(() => {
    ensureClisDetected().then((list) => {
      const firstAvailable = list.find((c) => c.available);
      if (firstAvailable) setSelectedCliId(firstAvailable.id);
    });
  });

  const pickedCli = (): CliInfo | null =>
    clisList().find((c) => c.id === selectedCliId()) ?? null;

  async function pickFolder(): Promise<string | null> {
    try {
      const picked = await open({ directory: true, multiple: false });
      return typeof picked === "string" ? picked : null;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async function addFolder() {
    const f = await pickFolder();
    if (!f) return;
    setFolders((cur) => {
      if (cur.includes(f)) return cur;
      if (cur.length >= MAX_FOLDERS) return cur;
      return [...cur, f];
    });
    // If name was empty, default to the basename of the first folder picked.
    if (!name().trim()) setName(basenameOf(f));
  }

  function removeFolder(path: string) {
    setFolders((cur) => cur.filter((p) => p !== path));
  }

  async function submit() {
    if (submitting()) return;
    setError(null);
    if (folders().length === 0) {
      setError("add at least one folder");
      return;
    }
    const resolvedName = name().trim() || basenameOf(folders()[0]);
    setSubmitting(true);
    try {
      if (isEdit && props.editingProjectId) {
        await updateProject(props.editingProjectId, resolvedName, folders(), memory());
      } else {
        const cli = pickedCli();
        await createProjectWithAgent({
          name: resolvedName,
          folders: folders(),
          memory: memory(),
          agentName: cli?.id ?? "main",
          agentProgram: cli?.program,
          agentArgs: cli?.args,
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
            {isEdit ? "edit project" : "new project"}
          </div>
          <button
            class="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"
            onClick={props.onClose}
            title="close (esc)"
          >
            <X size={14} />
          </button>
        </div>

        <div class="space-y-3 p-4">
          <FieldLabel>name</FieldLabel>
          <input
            class="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-white/25"
            value={name()}
            placeholder={folders()[0] ? basenameOf(folders()[0]) : "e.g. cosmos fullstack"}
            onInput={(e) => setName(e.currentTarget.value)}
          />

          <div class="flex items-center justify-between">
            <FieldLabel>
              folders ({folders().length}/{MAX_FOLDERS})
            </FieldLabel>
            <button
              class="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-white/60 hover:bg-white/5 hover:text-white disabled:opacity-40"
              onClick={addFolder}
              disabled={folders().length >= MAX_FOLDERS}
            >
              <FolderPlus size={12} />
              add folder
            </button>
          </div>
          <Show
            when={folders().length > 0}
            fallback={
              <div class="rounded-md border border-dashed border-white/10 px-3 py-3 text-center text-xs text-white/35">
                no folders yet — add at least one
              </div>
            }
          >
            <ul class="space-y-1">
              <For each={folders()}>
                {(f) => (
                  <li class="flex items-center justify-between rounded-md border border-white/10 bg-black/30 px-3 py-1.5 text-xs">
                    <span class="truncate text-white/85" title={f}>
                      {f}
                    </span>
                    <button
                      class="rounded p-0.5 text-white/40 hover:bg-white/10 hover:text-white"
                      onClick={() => removeFolder(f)}
                      title="remove"
                    >
                      <X size={12} />
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <Show when={!isEdit}>
            <FieldLabel>initial agent</FieldLabel>
            <Show
              when={clisList().length > 0}
              fallback={
                <div class="rounded-md border border-dashed border-white/10 px-3 py-2 text-[11px] text-white/35">
                  scanning $PATH…
                </div>
              }
            >
              <div class="flex flex-wrap gap-1.5">
                <For each={clisList()}>
                  {(cli) => (
                    <button
                      class="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40"
                      classList={{
                        "border-white/30 bg-white/10 text-white":
                          cli.available && selectedCliId() === cli.id,
                        "border-white/10 text-white/65 hover:border-white/20 hover:text-white":
                          cli.available && selectedCliId() !== cli.id,
                        "border-white/5 text-white/35": !cli.available,
                      }}
                      disabled={!cli.available}
                      onClick={() => setSelectedCliId(cli.id)}
                      title={
                        cli.available
                          ? cli.hint
                          : `${cli.hint} — not on $PATH`
                      }
                    >
                      <Bot size={11} class="shrink-0" />
                      <span class="font-medium">{cli.name}</span>
                      <span class="text-[10px] text-white/40">{cli.hint}</span>
                      <Show when={!cli.available}>
                        <span class="text-[10px] text-amber-300/70">
                          · not installed
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          <FieldLabel>
            memory <span class="text-white/30">(optional — pasted into CLAUDE.md)</span>
          </FieldLabel>
          <textarea
            class="w-full resize-none rounded-md border border-white/10 bg-black/30 px-3 py-2 text-[12.5px] leading-5 text-white outline-none focus:border-white/25"
            style={{ "font-family": '"Fira Code", ui-monospace, monospace' }}
            rows={5}
            placeholder="context the agent should remember: stack notes, conventions, where to look first…"
            value={memory()}
            onInput={(e) => setMemory(e.currentTarget.value)}
          />

          <Show when={error()}>
            <p class="text-[11px] text-red-400">{error()}</p>
          </Show>

          <div class="mt-1 flex items-center justify-between">
            <span class="text-[10px] text-white/30">⌘↵ submit · esc cancel</span>
            <button
              class="rounded-md bg-white/15 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={submit}
              disabled={submitting()}
            >
              {submitting() ? "working…" : isEdit ? "save" : "create project"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldLabel(props: { children: any }) {
  return (
    <label class="text-[10px] uppercase tracking-wider text-white/40">
      {props.children}
    </label>
  );
}
