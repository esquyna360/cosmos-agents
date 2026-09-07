import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  Bot,
  ChevronDown,
  Plus,
  Power,
  RotateCcw,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-solid";

import Terminal from "./Terminal";
import {
  createRunnerInProject,
  resetRunnerSession,
  respawnTick,
  restartRunner,
  stopRunner,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import {
  activeSlot,
  AREA_NAMES,
  closeSlot,
  layout,
  layoutSpec,
  reconcile,
  setActiveSlot,
  setSlot,
} from "../stores/panes";

interface Props {
  project: ProjectUI;
}

export default function PaneGrid(props: Props) {
  const p = () => props.project;
  const spec = createMemo(() => layoutSpec(layout()));

  // Reconciliation is a write, so it lives in the render path of the grid
  // (which owns the slots) rather than inside a memo other things read.
  const slots = createMemo(() =>
    reconcile(
      p().id,
      p().runners.map((r) => r.id),
    ),
  );

  const runnerAt = (i: number): RunnerUI | null => {
    const id = slots()[i];
    if (!id) return null;
    return p().runners.find((r) => r.id === id) ?? null;
  };

  return (
    <div
      class="grid min-h-0 min-w-0 flex-1 gap-1.5 p-1.5"
      style={{
        "grid-template-areas": spec().areas,
        "grid-template-columns": spec().cols,
        "grid-template-rows": spec().rows,
      }}
    >
      <For each={Array.from({ length: spec().slots }, (_, i) => i)}>
        {(i) => (
          <Pane
            project={p()}
            index={i}
            area={AREA_NAMES[i]}
            runner={runnerAt(i)}
            single={spec().slots === 1}
          />
        )}
      </For>
    </div>
  );
}

function Pane(props: {
  project: ProjectUI;
  index: number;
  area: string;
  runner: RunnerUI | null;
  single: boolean;
}) {
  const isActive = () => activeSlot() === props.index;
  const [picking, setPicking] = createSignal(false);
  const termKey = () =>
    props.runner ? `${props.runner.id}:${respawnTick()}` : null;

  return (
    <section
      class="cx-pane flex min-h-0 min-w-0 flex-col overflow-hidden rounded-cx border bg-panel transition-colors"
      classList={{
        "border-white/15": isActive() && !props.single,
        "border-line": !isActive() || props.single,
      }}
      style={{ "grid-area": props.area }}
      onMouseDown={() => setActiveSlot(props.index)}
    >
      <header
        class="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2"
        classList={{ "bg-white/[0.04]": isActive() && !props.single }}
      >
        <Show
          when={props.runner}
          fallback={
            <span class="px-1 text-[11px] text-faint">painel vazio</span>
          }
        >
          {(r) => (
            <>
              <span class="shrink-0 text-faint">
                {r().kind === "shell" ? (
                  <TerminalSquare size={12} />
                ) : (
                  <Bot size={12} />
                )}
              </span>
              <StatusPip runner={r()} />
              <button
                class="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[12px] text-dim transition hover:bg-white/8 hover:text-ink"
                onClick={() => setPicking((v) => !v)}
                title="trocar o runner deste painel"
              >
                <span class="truncate font-medium">{r().name}</span>
                <ChevronDown size={10} class="shrink-0 opacity-50" />
              </button>
              <span class="ml-auto" />
              <Show when={!r().live}>
                <span class="mr-1 rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-faint">
                  parado
                </span>
              </Show>
              <PaneAction
                icon={RotateCcw}
                label="reiniciar retomando a sessão"
                onClick={() => restartRunner(r().id).catch(console.error)}
              />
              <Show when={r().kind === "agent" && r().sessionId}>
                <PaneAction
                  icon={Sparkles}
                  label="nova conversa (descarta o histórico retomável)"
                  onClick={() => resetRunnerSession(r().id).catch(console.error)}
                />
              </Show>
              <PaneAction
                icon={Power}
                label="parar (mantém a sessão para retomar)"
                onClick={() => stopRunner(r().id).catch(console.error)}
              />
              <Show when={!props.single}>
                <PaneAction
                  icon={X}
                  label="esvaziar painel"
                  onClick={() => closeSlot(props.project.id, props.index)}
                />
              </Show>
            </>
          )}
        </Show>
        <Show when={!props.runner}>
          <span class="ml-auto" />
          <button
            class="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-dim transition hover:border-white/25 hover:bg-white/6 hover:text-ink"
            onClick={() => setPicking((v) => !v)}
          >
            <Plus size={10} />
            escolher
          </button>
        </Show>
      </header>

      <Show when={picking()}>
        <RunnerPicker
          project={props.project}
          taken={props.runner?.id ?? null}
          onPick={(id) => {
            setSlot(props.project.id, props.index, id);
            setPicking(false);
          }}
          onNew={async (kind) => {
            setPicking(false);
            const r = await createRunnerInProject(props.project.id, kind).catch(
              console.error,
            );
            if (r) setSlot(props.project.id, props.index, r.id);
          }}
          onClose={() => setPicking(false)}
        />
      </Show>

      <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Keyed on runner id + respawn counter: changing either tears the
            xterm down and re-attaches, instead of leaving it writing into a
            channel the backend already dropped. */}
        <Show
          when={termKey()}
          keyed
          fallback={
            <div class="flex flex-1 items-center justify-center px-4 text-center text-[11.5px] leading-relaxed text-faint">
              nenhum runner neste painel
            </div>
          }
        >
          <Terminal
            runner={props.runner!}
            projectId={props.project.id}
            cwd={
              props.runner!.kind === "shell"
                ? (props.project.folders[0] ?? props.project.cwd)
                : props.project.cwd
            }
          />
        </Show>
      </div>
    </section>
  );
}

function PaneAction(props: {
  icon: typeof X;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint transition hover:bg-white/10 hover:text-ink"
      title={props.label}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      <props.icon size={11} />
    </button>
  );
}

function StatusPip(props: { runner: RunnerUI }) {
  const cls = () => {
    const r = props.runner;
    if (!r.live || r.status === "exited") return "bg-white/20";
    if (r.status === "awaiting_input") return "bg-alert cx-pulse";
    if (r.status === "error") return "bg-alert";
    if (r.status === "streaming" || r.status === "tool_running")
      return "bg-busy cx-pulse";
    return "bg-live";
  };
  return <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${cls()}`} />;
}

function RunnerPicker(props: {
  project: ProjectUI;
  taken: string | null;
  onPick: (id: string) => void;
  onNew: (kind: "agent" | "shell") => void;
  onClose: () => void;
}) {
  function onDocClick(e: MouseEvent) {
    const t = e.target as HTMLElement | null;
    if (t?.closest("[data-runner-picker]")) return;
    props.onClose();
  }
  onMount(() => document.addEventListener("mousedown", onDocClick));
  onCleanup(() => document.removeEventListener("mousedown", onDocClick));

  return (
    <div
      data-runner-picker
      class="cx-sheet absolute left-2 right-2 top-9 z-30 overflow-hidden rounded-cx border border-line bg-float shadow-2xl"
    >
      <div class="max-h-56 overflow-y-auto py-1">
        <For each={props.project.runners}>
          {(r) => (
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-dim transition hover:bg-white/8 hover:text-ink"
              classList={{ "bg-white/6 text-ink": r.id === props.taken }}
              onClick={() => props.onPick(r.id)}
            >
              {r.kind === "shell" ? (
                <TerminalSquare size={11} class="shrink-0 opacity-60" />
              ) : (
                <Bot size={11} class="shrink-0 opacity-60" />
              )}
              <span class="min-w-0 flex-1 truncate">{r.name}</span>
              <Show when={!r.live}>
                <span class="shrink-0 text-[10px] text-faint">parado</span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <div class="flex border-t border-line">
        <button
          class="flex flex-1 items-center justify-center gap-1.5 py-1.5 text-[11px] text-dim transition hover:bg-white/8 hover:text-ink"
          onClick={() => props.onNew("agent")}
        >
          <Bot size={11} /> novo agente
        </button>
        <span class="w-px bg-white/8" />
        <button
          class="flex flex-1 items-center justify-center gap-1.5 py-1.5 text-[11px] text-dim transition hover:bg-white/8 hover:text-ink"
          onClick={() => props.onNew("shell")}
        >
          <TerminalSquare size={11} /> novo shell
        </button>
      </div>
    </div>
  );
}
