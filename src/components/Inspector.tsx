import { createEffect, For, on, Show } from "solid-js";
import { Code, FolderOpen, X } from "lucide-solid";

import { chatOf, refreshContext } from "../stores/chat";
import { isChat, openFileInEditor, type ProjectUI, type RunnerUI } from "../stores/projects";
import { inspector, setInspector, type InspectorTab } from "../stores/layout";
import { openPath } from "../lib/projects";
import { shortPath } from "../lib/toolDisplay";
import { prettyModel } from "./chat/Composer";
import DiffView from "./DiffView";
import FileTree from "./FileTree";

interface Props {
  project: ProjectUI;
  runner: RunnerUI | null;
}

const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

const WINDOW_LABEL: Record<string, string> = {
  five_hour: "Limite de 5 horas",
  seven_day: "Limite semanal",
};

export default function Inspector(props: Props) {
  return (
    <aside class="flex w-[400px] max-w-[45%] shrink-0 flex-col border-l border-line bg-panel">
      <div class="flex h-[40px] shrink-0 items-center gap-0.5 border-b border-line px-2">
        <Tab id="files" label="Arquivos" />
        <Tab id="changes" label="Mudanças" />
        <Show when={props.runner && isChat(props.runner)}>
          <Tab id="context" label="Contexto" />
        </Show>
        <button class="cx-icon-btn ml-auto" onClick={() => setInspector(null)} aria-label="Fechar painel">
          <X size={14} />
        </button>
      </div>
      <Show when={inspector() === "files"}>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <FileTree
            roots={props.runner?.cwd ? [props.runner.cwd] : props.project.folders}
            onOpenFile={openFileInEditor}
            selectedPath={null}
          />
        </div>
      </Show>
      <Show when={inspector() === "changes"}>
        <div class="flex min-h-0 flex-1 flex-col">
          <DiffView roots={props.runner?.cwd ? [props.runner.cwd] : props.project.folders} />
        </div>
      </Show>
      <Show when={inspector() === "context" && props.runner} keyed>
        {(r) => <Context project={props.project} runner={r} />}
      </Show>
    </aside>
  );
}

function Tab(props: { id: InspectorTab; label: string }) {
  return (
    <button
      class="cx-pill !h-[26px]"
      data-on={inspector() === props.id}
      onClick={() => setInspector(props.id)}
    >
      {props.label}
    </button>
  );
}

function Context(props: { project: ProjectUI; runner: RunnerUI }) {
  const chat = () => chatOf(props.runner.id);
  // The breakdown costs a control round trip, so it is only asked for while
  // the panel is open: on open, and after each finished turn.
  createEffect(
    on(
      () => [props.runner.id, chat().turns, props.runner.live],
      () => refreshContext(props.runner.id),
    ),
  );
  const used = () => chat().context?.total || chat().contextTokens;
  const max = () => chat().context?.max || chat().contextWindow;
  const pct = () => Math.min(100, Math.round((used() / Math.max(1, max())) * 100));
  const categories = () =>
    (chat().context?.categories ?? []).filter((c) => c.kind === "used" && c.tokens > 0);

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 text-[12.5px]">
      <section class="flex flex-col gap-2">
        <div class="flex items-baseline justify-between">
          <span class="text-dim">Contexto usado</span>
          <span class="tabular-nums text-ink">
            {tokens(used())} de {tokens(max())} ({pct()}%)
          </span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-fill-2">
          <div
            class="h-full rounded-full transition-[width]"
            classList={{ "bg-accent": pct() < 80, "bg-busy": pct() >= 80 }}
            style={{ width: `${pct()}%` }}
          />
        </div>
        <Show when={categories().length > 0}>
          <ul class="mt-1 flex flex-col gap-1">
            <For each={categories()}>
              {(c) => (
                <li class="flex justify-between text-dim">
                  <span>{c.name}</span>
                  <span class="tabular-nums">{tokens(c.tokens)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={!props.runner.live}>
          <p class="text-faint">O detalhamento aparece quando a sessão está rodando.</p>
        </Show>
      </section>

      <section class="flex flex-col gap-1.5">
        <Row label="Modelo" value={chat().model ? prettyModel(chat().model) : "ainda não definido"} />
        <Row label="Custo desde que abriu" value={`US$ ${chat().costUsd.toFixed(2)}`} />
        <Row label="Tokens gerados" value={tokens(chat().outputTokens)} />
      </section>

      <Show when={Object.keys(chat().limits).length > 0}>
        <section class="flex flex-col gap-1.5">
          <For each={Object.entries(chat().limits)}>
            {([id, w]) => (
              <Row label={WINDOW_LABEL[id] ?? id} value={`${Math.round(w.utilization * 100)}% usado`} />
            )}
          </For>
        </section>
      </Show>

      <section class="flex flex-col gap-1">
        <span class="mb-0.5 text-dim">Pastas</span>
        <For each={props.project.folders}>
          {(folder) => (
            <div class="group flex items-center gap-1">
              <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={folder}>
                {shortPath(folder, [])}
              </span>
              <button
                class="cx-icon-btn"
                onClick={() => openPath(folder).catch(console.error)}
                title="Abrir no Finder"
              >
                <FolderOpen size={13} />
              </button>
              <button
                class="cx-icon-btn"
                onClick={() => openPath(folder, "Visual Studio Code").catch(console.error)}
                title="Abrir no VS Code"
              >
                <Code size={13} />
              </button>
            </div>
          )}
        </For>
      </section>
    </div>
  );
}

function Row(props: { label: string; value: string }) {
  return (
    <div class="flex justify-between gap-3">
      <span class="text-dim">{props.label}</span>
      <span class="truncate tabular-nums text-ink">{props.value}</span>
    </div>
  );
}
