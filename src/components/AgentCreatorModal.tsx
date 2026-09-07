import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Bot, X, FolderPlus } from "lucide-solid";

import {
  createProjectWithAgent,
  deleteProject,
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
  // Deleting a project used to be one stray click on an X in the sidebar.
  // It now lives here, behind a typed confirmation, because it takes every
  // runner and every resumable session with it.
  const [confirmDelete, setConfirmDelete] = createSignal("");

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
      setError("adicione pelo menos uma pasta");
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
      <div class="cx-sheet mt-16 w-[640px] max-w-[92vw] overflow-hidden rounded-cx border border-line bg-float shadow-2xl">
        <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
          <div class="text-[10px] font-medium uppercase tracking-wider text-faint">
            {isEdit ? "editar projeto" : "novo projeto"}
          </div>
          <button
            class="rounded-md p-1 text-faint transition hover:bg-white/10 hover:text-ink"
            onClick={props.onClose}
            title="fechar (esc)"
          >
            <X size={14} />
          </button>
        </div>

        <div class="space-y-3 p-4">
          <FieldLabel>nome</FieldLabel>
          <input
            class="w-full rounded-lg border border-line bg-black/30 px-3 py-2 text-[13px] text-ink outline-none transition focus:border-white/25"
            value={name()}
            placeholder={folders()[0] ? basenameOf(folders()[0]) : "ex.: cosmos fullstack"}
            onInput={(e) => setName(e.currentTarget.value)}
          />

          <div class="flex items-center justify-between">
            <FieldLabel>
              pastas ({folders().length}/{MAX_FOLDERS})
            </FieldLabel>
            <button
              class="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-dim transition hover:border-white/25 hover:bg-white/6 hover:text-ink disabled:opacity-40"
              onClick={addFolder}
              disabled={folders().length >= MAX_FOLDERS}
            >
              <FolderPlus size={12} />
              adicionar pasta
            </button>
          </div>
          <Show
            when={folders().length > 0}
            fallback={
              <div class="rounded-lg border border-dashed border-line px-3 py-3 text-center text-[11px] text-faint">
                nenhuma pasta ainda — adicione pelo menos uma
              </div>
            }
          >
            <ul class="space-y-1">
              <For each={folders()}>
                {(f) => (
                  <li class="flex items-center justify-between rounded-lg border border-line bg-black/30 px-3 py-1.5 text-[11.5px]">
                    <span class="truncate text-dim" title={f}>
                      {f}
                    </span>
                    <button
                      class="rounded p-0.5 text-faint transition hover:bg-white/10 hover:text-ink"
                      onClick={() => removeFolder(f)}
                      title="remover"
                    >
                      <X size={12} />
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <Show when={!isEdit}>
            <FieldLabel>agente inicial</FieldLabel>
            <Show
              when={clisList().length > 0}
              fallback={
                <div class="rounded-lg border border-dashed border-line px-3 py-2 text-[11px] text-faint">
                  lendo $PATH…
                </div>
              }
            >
              <div class="flex flex-wrap gap-1.5">
                <For each={clisList()}>
                  {(cli) => (
                    <button
                      class="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40"
                      classList={{
                        "border-white/30 bg-white/10 text-ink":
                          cli.available && selectedCliId() === cli.id,
                        "border-line text-dim hover:border-white/20 hover:text-ink":
                          cli.available && selectedCliId() !== cli.id,
                        "border-line text-faint": !cli.available,
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
                      <span class="text-[10px] text-faint">{cli.hint}</span>
                      <Show when={!cli.available}>
                        <span class="text-[10px] text-busy">
                          · não instalado
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          <FieldLabel>
            memória <span class="text-faint">(opcional — entra no CLAUDE.md)</span>
          </FieldLabel>
          <textarea
            class="w-full resize-none rounded-lg border border-line bg-black/30 px-3 py-2 text-[12.5px] leading-5 text-ink outline-none transition focus:border-white/25"
            style={{ "font-family": '"Fira Code", ui-monospace, monospace' }}
            rows={5}
            placeholder="o que o agente precisa lembrar: stack, convenções, onde olhar primeiro…"
            value={memory()}
            onInput={(e) => setMemory(e.currentTarget.value)}
          />

          <Show when={error()}>
            <p class="text-[11px] text-alert">{error()}</p>
          </Show>

          <Show when={isEdit && props.editingProjectId}>
            <div class="mt-2 rounded-lg border border-alert/25 bg-alert/[0.06] p-3">
              <div class="flex items-center gap-1.5 text-[11px] font-medium text-alert">
                <AlertTriangle size={12} />
                excluir projeto
              </div>
              <p class="mt-1 text-[11px] leading-relaxed text-faint">
                apaga o projeto, todos os runners e as sessões retomáveis. as
                pastas de trabalho no disco não são tocadas. digite{" "}
                <b class="text-dim">{editing()?.name}</b> para liberar.
              </p>
              <div class="mt-2 flex items-center gap-2">
                <input
                  class="min-w-0 flex-1 rounded-lg border border-line bg-black/30 px-2.5 py-1.5 text-[12px] text-ink outline-none transition focus:border-alert/50"
                  placeholder={editing()?.name}
                  value={confirmDelete()}
                  onInput={(e) => setConfirmDelete(e.currentTarget.value)}
                />
                <button
                  class="shrink-0 rounded-lg border border-alert/40 px-3 py-1.5 text-[12px] font-medium text-alert transition hover:bg-alert/15 disabled:cursor-not-allowed disabled:opacity-35"
                  disabled={confirmDelete().trim() !== editing()?.name}
                  onClick={() => {
                    const id = props.editingProjectId;
                    if (!id) return;
                    deleteProject(id).catch(console.error);
                    props.onClose();
                  }}
                >
                  excluir
                </button>
              </div>
            </div>
          </Show>

          <div class="mt-1 flex items-center justify-between">
            <span class="text-[10px] text-faint">⌘↵ salvar · esc cancelar</span>
            <button
              class="rounded-lg bg-white/15 px-3.5 py-1.5 text-[13px] font-medium text-ink transition hover:bg-white/25 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={submit}
              disabled={submitting()}
            >
              {submitting() ? "trabalhando…" : isEdit ? "salvar" : "criar projeto"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldLabel(props: { children: any }) {
  return (
    <label class="text-[10px] font-medium uppercase tracking-wider text-faint">
      {props.children}
    </label>
  );
}
