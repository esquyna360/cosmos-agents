import { Show } from "solid-js";
import {
  Columns2,
  Ellipsis,
  FolderTree,
  Gauge,
  GitBranch,
  GitCompareArrows,
  MessageSquare,
  SquareTerminal,
} from "lucide-solid";

import {
  cwdFor,
  focusProject,
  isChat,
  newTerminal,
  respawnTick,
  setRunnerMode,
  workFolder,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import { renameSession, statsOf } from "../stores/chat";
import { branchOf } from "../stores/git";
import { inspector, setInspector, type InspectorTab } from "../stores/layout";
import { toggleSplit } from "../stores/panes";
import { isClaudeRunner } from "../lib/projects";
import { shortPath } from "../lib/toolDisplay";
import { prettyModel } from "./chat/Composer";
import InlineEdit from "./InlineEdit";
import Terminal from "./Terminal";
import ChatView from "./chat/ChatView";
import StatusGlyph, { glyphFor, stateOf, TONE_TEXT } from "../ui/StatusGlyph";
import { openMenu } from "../ui/Menu";
import { runnerMenu } from "./menus";

interface Props {
  project: ProjectUI;
  runner: RunnerUI;
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
  const state = () => stateOf(r());
  const branch = () => branchOf(props.project, r());
  const stats = () => (r().kind === "agent" ? statsOf(r().id) : null);
  const pct = () => {
    const s = stats();
    return s && s.contextWindow > 0 ? Math.min(100, Math.round((s.contextTokens / s.contextWindow) * 100)) : null;
  };
  const panel = (id: InspectorTab) => setInspector(inspector() === id ? null : id);

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header class="flex shrink-0 items-center gap-4 border-b border-line px-5 py-2.5">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <StatusGlyph glyph={glyphFor(r())} />
            <h1
              class="min-w-0 truncate text-[17px] leading-tight text-ink"
              classList={{ "font-heading": r().kind === "agent", "font-mono text-[14px]": r().kind === "shell" }}
            >
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
            </h1>
            <span class={`shrink-0 text-[12px] ${TONE_TEXT[state().tone]}`}>{state().label}</span>
          </div>
          <div class="mt-1 flex min-w-0 items-center gap-2.5 text-[11.5px] text-faint">
            <button class="shrink-0 text-dim hover:text-accent" onClick={() => focusProject(props.project.id)}>
              {props.project.name}
            </button>
            <Show when={branch()}>
              <span class="flex shrink-0 items-center gap-1 font-mono text-[11px]" title={r().cwd ? "Worktree própria" : "Checkout principal"}>
                <GitBranch size={11} />
                {branch()}
              </span>
            </Show>
            <span class="min-w-0 truncate font-mono text-[11px]" title={workFolder(props.project, r())}>
              {shortPath(workFolder(props.project, r()), [])}
            </span>
            <Show when={pct() !== null}>
              <button
                class="flex shrink-0 items-center gap-1.5 hover:text-dim"
                title="Contexto usado"
                onClick={() => panel("context")}
              >
                <span class="h-1 w-[52px] overflow-hidden rounded-full bg-fill-2">
                  <span
                    class="block h-full rounded-full"
                    classList={{ "bg-live": pct()! < 80, "bg-busy": pct()! >= 80 }}
                    style={{ width: `${pct()}%` }}
                  />
                </span>
                <span class="tabular-nums">{pct()}%</span>
              </button>
            </Show>
            <Show when={stats() && stats()!.costUsd > 0}>
              <span class="shrink-0 tabular-nums">${stats()!.costUsd.toFixed(2)}</span>
            </Show>
            <Show when={stats()?.model}>
              <span class="shrink-0">{prettyModel(stats()!.model)}</span>
            </Show>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-1">
          <Show when={canChat()}>
            <div class="mr-1 flex rounded-full border border-line p-0.5" role="group" aria-label="Modo da sessão">
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
            class="cx-pill"
            onClick={() => void newTerminal(props.project.id, { cwd: workFolder(props.project, r()) })}
            title="Abre um terminal na pasta deste agente"
          >
            <SquareTerminal size={12} />
            Shell aqui
          </button>
          <button class="cx-icon-btn" data-on={inspector() === "files"} onClick={() => panel("files")} title="Arquivos">
            <FolderTree size={15} />
          </button>
          <button
            class="cx-icon-btn"
            data-on={inspector() === "changes"}
            onClick={() => panel("changes")}
            title="Mudanças no código"
          >
            <GitCompareArrows size={15} />
          </button>
          <Show when={isChat(r())}>
            <button
              class="cx-icon-btn"
              data-on={inspector() === "context"}
              onClick={() => panel("context")}
              title="Contexto e custo"
            >
              <Gauge size={15} />
            </button>
          </Show>
          <button
            class="cx-icon-btn"
            title="Mais"
            aria-label="Mais ações"
            onClick={(e) =>
              openMenu(e.currentTarget, [
                ...runnerMenu(props.project, r(), editKey()),
                { label: "Dividir a tela", icon: Columns2, hint: "⌘\\", separatorBefore: true, onSelect: toggleSplit },
              ])
            }
          >
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
      class="flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[12px] transition"
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
