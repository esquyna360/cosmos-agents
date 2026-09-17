import { Show } from "solid-js";
import {
  Columns2,
  Ellipsis,
  FileText,
  FolderOpen,
  GitCompareArrows,
  Globe,
  Gauge,
  MessageSquare,
  Notebook,
  PanelLeft,
  Pencil,
  Power,
  RotateCcw,
  SquareTerminal,
  Trash2,
} from "lucide-solid";

import {
  deleteRunner,
  isChat,
  resetRunnerSession,
  respawnTick,
  setRunnerMode,
  stopRunner,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import { renameSession } from "../stores/chat";
import { inspector, setInspector, setView, sidebarOpen, toggleSidebar } from "../stores/layout";
import { toggleSplit } from "../stores/panes";
import { isClaudeRunner, openPath } from "../lib/projects";
import InlineEdit, { startInlineEdit } from "./InlineEdit";
import Terminal from "./Terminal";
import ChatView from "./chat/ChatView";
import StatusGlyph, { glyphFor, GLYPH_LABEL } from "../ui/StatusGlyph";
import { openMenu } from "../ui/Menu";

interface Props {
  project: ProjectUI;
  runner: RunnerUI;
}

export function cwdFor(project: ProjectUI, runner: RunnerUI): string {
  return runner.kind === "shell" ? (project.folders[0] ?? project.cwd) : project.cwd;
}

/** The session itself, without chrome: a chat or a terminal. */
export function SessionBody(props: Props) {
  return (
    <Show
      when={isChat(props.runner)}
      fallback={
        <Show when={`${props.runner.id}:${respawnTick()}`} keyed>
          {(_key) => (
            <Terminal
              runner={props.runner}
              projectId={props.project.id}
              cwd={cwdFor(props.project, props.runner)}
            />
          )}
        </Show>
      }
    >
      <Show when={props.runner.id} keyed>
        {(_id) => <ChatView runner={props.runner} project={props.project} />}
      </Show>
    </Show>
  );
}

export default function SessionView(props: Props) {
  const r = () => props.runner;
  const editKey = () => `header:${r().id}`;
  const canChat = () => r().kind === "agent" && isClaudeRunner(r());

  function more(e: MouseEvent) {
    openMenu(e.currentTarget as HTMLElement, [
      { label: "Renomear", icon: Pencil, onSelect: () => startInlineEdit(editKey()) },
      { label: "Dividir a tela", icon: Columns2, hint: "⌘\\", onSelect: toggleSplit },
      {
        label: "Arquivos",
        icon: FileText,
        hint: "⌘E",
        separatorBefore: true,
        onSelect: () => setView("editor"),
      },
      { label: "Memória do projeto", icon: Notebook, onSelect: () => setView("memory") },
      { label: "Navegador", icon: Globe, onSelect: () => setView("browser") },
      {
        label: "Abrir pasta no Finder",
        icon: FolderOpen,
        onSelect: () =>
          openPath(props.project.folders[0] ?? props.project.cwd).catch(console.error),
      },
      {
        label: r().live ? "Parar" : "Já está parada",
        icon: Power,
        hint: "⌘W",
        disabled: !r().live,
        separatorBefore: true,
        onSelect: () => void stopRunner(r().id),
      },
      {
        label: "Começar conversa do zero",
        icon: RotateCcw,
        disabled: r().kind !== "agent",
        onSelect: () => void resetRunnerSession(r().id),
      },
      { label: "Excluir sessão", icon: Trash2, danger: true, onSelect: () => void deleteRunner(r().id) },
    ]);
  }

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        data-tauri-drag-region
        class="flex h-[46px] shrink-0 items-center gap-2 border-b border-line bg-void pr-3"
        classList={{ "pl-[84px]": !sidebarOpen(), "pl-4": sidebarOpen() }}
      >
        <Show when={!sidebarOpen()}>
          <button class="cx-icon-btn" onClick={toggleSidebar} title="Mostrar barra lateral (⌘B)">
            <PanelLeft size={15} />
          </button>
        </Show>
        <span title={GLYPH_LABEL[glyphFor(r())]} class="flex shrink-0">
          <StatusGlyph glyph={glyphFor(r())} />
        </span>
        <div class="flex min-w-0 items-baseline gap-2">
          <span class="min-w-0 truncate text-[13.5px] font-medium text-ink">
            <InlineEdit
              value={r().name}
              editKey={editKey()}
              onCommit={(next) => {
                const t = next.trim();
                if (t && t !== r().name) renameSession(r().id, t).catch(console.error);
              }}
            >
              {(name) => <span class="truncate">{name}</span>}
            </InlineEdit>
          </span>
          <span class="shrink-0 truncate text-[12px] text-faint">{props.project.name}</span>
        </div>

        <div class="ml-auto flex shrink-0 items-center gap-1">
          <Show when={canChat()}>
            <div class="mr-1 flex rounded-md border border-line p-0.5" role="group" aria-label="Modo da sessão">
              <ModeButton
                on={r().mode === "chat"}
                label="Chat"
                icon={MessageSquare}
                onClick={() => void setRunnerMode(r().id, "chat")}
              />
              <ModeButton
                on={r().mode === "tty"}
                label="Terminal"
                icon={SquareTerminal}
                onClick={() => void setRunnerMode(r().id, "tty")}
              />
            </div>
          </Show>
          <button
            class="cx-icon-btn"
            data-on={inspector() === "changes"}
            onClick={() => setInspector(inspector() === "changes" ? null : "changes")}
            title="Mudanças no código"
          >
            <GitCompareArrows size={15} />
          </button>
          <Show when={isChat(r())}>
            <button
              class="cx-icon-btn"
              data-on={inspector() === "context"}
              onClick={() => setInspector(inspector() === "context" ? null : "context")}
              title="Contexto e custo"
            >
              <Gauge size={15} />
            </button>
          </Show>
          <button class="cx-icon-btn" onClick={more} title="Mais" aria-label="Mais ações">
            <Ellipsis size={15} />
          </button>
        </div>
      </header>
      <SessionBody project={props.project} runner={r()} />
    </div>
  );
}

function ModeButton(props: {
  on: boolean;
  label: string;
  icon: typeof MessageSquare;
  onClick: () => void;
}) {
  return (
    <button
      class="flex items-center gap-1.5 rounded px-2 py-[3px] text-[12px] transition"
      classList={{
        "bg-fill-3 text-ink": props.on,
        "text-faint hover:text-ink": !props.on,
      }}
      aria-pressed={props.on}
      onClick={() => !props.on && props.onClick()}
      title={
        props.label === "Terminal"
          ? "A mesma conversa, no terminal do Claude Code"
          : "A mesma conversa, como chat"
      }
    >
      <props.icon size={12} />
      {props.label}
    </button>
  );
}
