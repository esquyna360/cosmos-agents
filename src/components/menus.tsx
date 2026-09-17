import { createSignal, Show } from "solid-js";
import {
  Bot,
  FolderOpen,
  MessageSquare,
  Pencil,
  Power,
  RotateCcw,
  Settings2,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-solid";

import {
  deleteProject,
  deleteRunner,
  isMasterProject,
  masterRunner,
  newTerminal,
  projectsStore,
  resetRunnerSession,
  restartRunner,
  setRunnerMode,
  sleepProject,
  stopRunner,
  workFolder,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import { openCreator } from "../stores/creator";
import { closeTab, openTabs } from "../stores/nav";
import { CHAT_ENABLED, isClaudeRunner, openPath } from "../lib/projects";
import { startInlineEdit } from "./InlineEdit";
import type { MenuItem } from "../ui/Menu";

/** One menu per thing, wherever the thing is drawn: card, row, tab, header. */
export function runnerMenu(project: ProjectUI, r: RunnerUI, editKey?: string): MenuItem[] {
  const isAgent = r.kind === "agent";
  const isMaster = masterRunner()?.id === r.id;
  return [
    ...(editKey
      ? [{ label: "Renomear", icon: Pencil, onSelect: () => startInlineEdit(editKey) } satisfies MenuItem]
      : []),
    ...(CHAT_ENABLED && isAgent && r.sessionId && isClaudeRunner(r)
      ? [
          {
            label: r.mode === "chat" ? "Continuar no terminal do Claude Code" : "Voltar ao chat",
            icon: r.mode === "chat" ? SquareTerminal : MessageSquare,
            hint: "⌘J",
            onSelect: () => void setRunnerMode(r.id, r.mode === "chat" ? "tty" : "chat"),
          } satisfies MenuItem,
        ]
      : []),
    {
      label: "Terminal nesta pasta",
      icon: SquareTerminal,
      onSelect: () => void newTerminal(project.id, { cwd: workFolder(project, r) }),
    },
    {
      label: "Abrir pasta no Finder",
      icon: FolderOpen,
      onSelect: () => openPath(workFolder(project, r)).catch(console.error),
    },
    {
      label: "Reiniciar",
      icon: RotateCcw,
      separatorBefore: true,
      onSelect: () => void restartRunner(r.id),
    },
    {
      label: r.live ? "Parar" : "Já está parado",
      icon: Power,
      hint: "⌘W",
      disabled: !r.live,
      onSelect: () => void stopRunner(r.id),
    },
    ...(isAgent
      ? [
          {
            label: "Começar conversa do zero",
            icon: RotateCcw,
            onSelect: () => void resetRunnerSession(r.id),
          } satisfies MenuItem,
        ]
      : []),
    ...(isMaster
      ? []
      : [
          {
            label: isAgent ? "Excluir agente" : "Excluir terminal",
            icon: Trash2,
            danger: true,
            separatorBefore: true,
            onSelect: () => void deleteRunner(r.id),
          } satisfies MenuItem,
        ]),
  ];
}

export function projectMenu(p: ProjectUI, editKey?: string): MenuItem[] {
  const live = p.runners.filter((r) => r.live).length;
  return [
    {
      label: "Novo agente",
      icon: Bot,
      hint: "⌘N",
      onSelect: () => openCreator({ mode: "agent", projectId: p.id }),
    },
    {
      label: "Novo terminal",
      icon: SquareTerminal,
      hint: "⌘⇧N",
      onSelect: () => void newTerminal(p.id),
    },
    ...(editKey
      ? [
          {
            label: "Renomear",
            icon: Pencil,
            separatorBefore: true,
            onSelect: () => startInlineEdit(editKey),
          } satisfies MenuItem,
        ]
      : []),
    {
      label: "Pastas e memória",
      icon: Settings2,
      separatorBefore: !editKey,
      onSelect: () => openCreator({ mode: "project", editingProjectId: p.id }),
    },
    {
      label: "Abrir pasta no Finder",
      icon: FolderOpen,
      onSelect: () => openPath(workFolder(p)).catch(console.error),
    },
    {
      label: "Parar tudo",
      icon: Power,
      disabled: live === 0,
      onSelect: () => void sleepProject(p.id),
    },
    ...(openTabs().includes(p.id)
      ? [{ label: "Fechar aba", icon: X, onSelect: () => closeTab(p.id) } satisfies MenuItem]
      : []),
    ...(isMasterProject(p)
      ? []
      : [
          {
            label: "Excluir projeto",
            icon: Trash2,
            danger: true,
            separatorBefore: true,
            onSelect: () => setDeleting(p.id),
          } satisfies MenuItem,
        ]),
  ];
}

const [deleting, setDeleting] = createSignal<string | null>(null);

/** A project with nothing running is one click away. One with live agents
 *  asks for its name first: that is the case where a misclick costs work. */
export function DeleteProjectDialog() {
  const project = () => projectsStore.list.find((p) => p.id === deleting());
  const [typed, setTyped] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const live = () => project()?.runners.filter((r) => r.live).length ?? 0;
  const armed = () => live() === 0 || typed().trim() === project()?.name;

  function close() {
    setDeleting(null);
    setTyped("");
    setError(null);
    setBusy(false);
  }

  async function run() {
    const p = project();
    if (!p || !armed() || busy()) return;
    setBusy(true);
    try {
      await deleteProject(p.id);
      close();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Show when={project()}>
      {(p) => (
        <div
          class="fixed inset-0 z-[70] flex items-center justify-center bg-sunken backdrop-blur-sm"
          onMouseDown={(e) => e.target === e.currentTarget && close()}
          onKeyDown={(e) => e.key === "Escape" && close()}
        >
          <div class="cx-glass cx-sheet w-[400px] max-w-[92vw] rounded-cx-lg border border-line-strong p-5">
            <h2 class="font-heading text-[19px] text-ink">Excluir {p().name}?</h2>
            <p class="mt-2 text-[13px] leading-relaxed text-dim">
              <Show when={p().runners.length > 0} fallback="O projeto some do Cosmos.">
                {p().runners.length === 1
                  ? "O agente e a conversa dele vão junto."
                  : `Os ${p().runners.length} agentes e terminais vão junto, com as conversas.`}
              </Show>{" "}
              As pastas no disco ficam como estão.
            </p>
            <Show when={live() > 0}>
              <p class="mt-3 text-[12.5px] text-alert">
                {live()} rodando agora. Digite o nome do projeto para liberar.
              </p>
              <input
                class="mt-2 w-full rounded-full border border-line-strong bg-raised px-3.5 py-1.5 text-[13px] text-ink outline-none focus:border-alert"
                placeholder={p().name}
                value={typed()}
                ref={(el) => queueMicrotask(() => el.focus())}
                onInput={(e) => setTyped(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && void run()}
              />
            </Show>
            <Show when={error()}>
              <p class="mt-2 text-[12.5px] text-alert">{error()}</p>
            </Show>
            <div class="mt-4 flex justify-end gap-2">
              <button class="cx-pill" onClick={close}>
                Cancelar
              </button>
              <button
                class="cx-pill bg-alert-soft !text-alert disabled:opacity-40"
                disabled={!armed() || busy()}
                onClick={() => void run()}
              >
                {busy() ? "Excluindo…" : "Excluir projeto"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
