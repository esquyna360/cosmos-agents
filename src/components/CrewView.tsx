import { createMemo, createSignal, For, Show } from "solid-js";
import { Ellipsis, Plus, SquareTerminal } from "lucide-solid";

import {
  focusProject,
  focusRunner,
  isMasterProject,
  isStale,
  masterRunner,
  newTerminal,
  projectsStore,
  workFolder,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import { branchOf } from "../stores/git";
import { openCreator } from "../stores/creator";
import { go } from "../stores/nav";
import { shortPath } from "../lib/toolDisplay";
import { needsYou } from "../ui/StatusGlyph";
import { openMenu } from "../ui/Menu";
import { projectMenu } from "./menus";
import { AgentCard, ShellCard } from "./RunnerCard";

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Boa madrugada." : h < 12 ? "Bom dia." : h < 18 ? "Boa tarde." : "Boa noite.";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Home. Projects are the unit; each one shows who is working in it. */
export default function CrewView() {
  const projects = createMemo(() =>
    projectsStore.list.filter(
      (p) => !isMasterProject(p) || p.runners.some((r) => r.id !== masterRunner()?.id),
    ),
  );
  const all = createMemo(() => projects().flatMap((p) => p.runners.map((r) => ({ p, r }))));
  const working = () =>
    all().filter(({ r }) => r.live && (r.status === "streaming" || r.status === "tool_running")).length;
  const waiting = createMemo(() => all().filter(({ r }) => needsYou(r)));

  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-[1500px] flex-col gap-6 px-8 pb-12 pt-8">
        <header class="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div>
            <h1 class="font-heading text-[30px] leading-none text-ink">{greeting()}</h1>
            <p class="mt-2 text-[13px] text-dim">
              <Show when={projects().length > 0} fallback="Nenhum projeto ainda.">
                {plural(projects().length, "projeto", "projetos")},{" "}
                {working() === 0
                  ? "ninguém trabalhando agora"
                  : plural(working(), "agente trabalhando", "agentes trabalhando")}
                <Show when={waiting().length > 0}>
                  , <span class="text-busy">{plural(waiting().length, "esperando você", "esperando você")}</span>
                </Show>
                .
              </Show>
            </p>
          </div>
          <button
            class="cx-pill cx-pill-line ml-auto"
            onClick={() => go({ kind: "hub" })}
            title="O agente que cria e coordena os outros"
          >
            Pedir ao Hub
          </button>
        </header>

        <Show when={waiting().length > 0}>
          <div class="flex flex-wrap items-center gap-1.5">
            <For each={waiting()}>
              {({ p, r }) => (
                <button
                  class="cx-chip-add bg-busy-soft text-busy"
                  onClick={() => focusRunner(p.id, r.id)}
                >
                  {r.name}
                  <span class="ml-1.5 opacity-70">{p.name}</span>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={projects().length > 0} fallback={<Empty />}>
          <div class="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(430px,1fr))]">
            <For each={projects()}>{(p) => <ProjectSection project={p} />}</For>
          </div>
        </Show>
      </div>
    </div>
  );
}

function ProjectSection(props: { project: ProjectUI }) {
  const p = () => props.project;
  const [showStale, setShowStale] = createSignal(false);
  const mine = () => p().runners.filter((r) => r.id !== masterRunner()?.id);
  const visible = (kind: RunnerUI["kind"]) =>
    mine().filter((r) => r.kind === kind && (showStale() || !isStale(r)));
  const staleCount = () => mine().filter(isStale).length;
  const branch = () => branchOf(p());

  return (
    <section
      class="flex flex-col gap-3 rounded-[20px] border border-line bg-fill-1 p-4"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        openMenu(e, projectMenu(p()));
      }}
    >
      <header class="flex items-center gap-2">
        <button class="min-w-0 text-left" onClick={() => focusProject(p().id)} title="Abrir projeto">
          <span class="font-heading block truncate text-[18px] leading-tight text-ink hover:text-accent">
            {p().name}
          </span>
          <span class="mt-0.5 block truncate font-mono text-[11px] text-faint">
            {shortPath(workFolder(p()), [])}
            <Show when={branch()}> · {branch()}</Show>
          </span>
        </button>
        <div class="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            class="cx-pill !h-[26px] !px-2.5"
            title="Novo agente neste projeto"
            onClick={() => openCreator({ mode: "agent", projectId: p().id })}
          >
            <Plus size={12} />
            Agente
          </button>
          <button
            class="cx-icon-btn"
            title="Novo terminal"
            onClick={() => void newTerminal(p().id)}
          >
            <SquareTerminal size={14} />
          </button>
          <button
            class="cx-icon-btn"
            title="Mais"
            aria-label={`Mais ações de ${p().name}`}
            onClick={(e) => openMenu(e.currentTarget, projectMenu(p()))}
          >
            <Ellipsis size={14} />
          </button>
        </div>
      </header>

      <div class="grid grid-cols-2 gap-2" classList={{ hidden: visible("agent").length === 0 }}>
        <For each={visible("agent")}>{(r) => <AgentCard project={p()} runner={r} />}</For>
      </div>
      <Show when={mine().length === 0}>
        <p class="text-[12.5px] text-faint">Ninguém aqui ainda.</p>
      </Show>

      <Show when={visible("shell").length > 0}>
        <div class="grid grid-cols-2 gap-2">
          <For each={visible("shell")}>{(r) => <ShellCard project={p()} runner={r} />}</For>
        </div>
      </Show>

      <Show when={staleCount() > 0}>
        <button
          class="self-start text-[11.5px] text-faint transition hover:text-dim"
          onClick={() => setShowStale(!showStale())}
          title="Parados há mais de 3 dias"
        >
          {showStale() ? "Esconder parados" : `+${staleCount()} parados há dias`}
        </button>
      </Show>
    </section>
  );
}

function Empty() {
  return (
    <div class="flex flex-col items-start gap-3 rounded-[20px] border border-dashed border-line-strong p-8">
      <p class="font-heading text-[20px] text-ink">Comece por uma pasta</p>
      <p class="max-w-[440px] text-[13px] leading-relaxed text-dim">
        Um projeto é só uma pasta do seu disco. Depois você coloca agentes e terminais para
        trabalhar nela.
      </p>
      <button class="cx-btn-primary mt-1" onClick={() => openCreator({ mode: "project" })}>
        Adicionar projeto
      </button>
    </div>
  );
}
