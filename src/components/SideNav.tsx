import { projectLabel } from "../lib/projectLabel";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { ListTree, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-solid";

import {
  focusProject,
  focusRunner,
  focusedRunner,
  isMasterProject,
  isStale,
  masterRunner,
  projectsStore,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import {
  navChildren,
  navLabel,
  route,
  routeProjectId,
  setNavChildren,
  setNavLabel,
  setNavMode,
} from "../stores/nav";
import { openCreator } from "../stores/creator";
import { setSidebarOpen, sidebarOpen } from "../stores/layout";
import { projectLabel as labelOf } from "../lib/projectLabel";
import StatusGlyph, { glyphFor, needsYou } from "../ui/StatusGlyph";
import { menuOpen, openMenu, type MenuItem } from "../ui/Menu";
import { projectMenu, runnerMenu } from "./menus";

/** What a project row lists under itself, given the person's choice. The
 *  project you are inside always lists everything: with an agent open, its
 *  siblings have to be one click away. */
export function childrenOf(p: ProjectUI): RunnerUI[] {
  const mode = route().kind === "session" && routeProjectId() === p.id ? "all" : navChildren();
  if (mode === "none") return [];
  const current = focusedRunner()?.id;
  return p.runners.filter(
    (r) =>
      r.id !== masterRunner()?.id &&
      (mode === "all" || r.kind === "agent") &&
      (!isStale(r) || r.id === current),
  );
}

export function navOptionsMenu(): MenuItem[] {
  const pick = (v: "none" | "agents" | "all", label: string): MenuItem => ({
    label,
    checked: navChildren() === v,
    onSelect: () => setNavChildren(v),
  });
  return [
    {
      label: "Nome do projeto",
      checked: navLabel() === "name",
      onSelect: () => setNavLabel("name"),
    },
    {
      label: "Caminho completo",
      checked: navLabel() === "path",
      onSelect: () => setNavLabel("path"),
    },
    { ...pick("none", "Só projetos"), separatorBefore: true },
    pick("agents", "Com agentes"),
    pick("all", "Com agentes e terminais"),
  ];
}

/** Projects down the side. Pinned it is a column; collapsed it is a rail of
 *  monograms that opens over the page while the pointer is on it. */
export default function SideNav() {
  const [peek, setPeek] = createSignal(false);
  let timer: number | undefined;
  const later = (v: boolean, ms: number) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => setPeek(v), ms);
  };
  onCleanup(() => clearTimeout(timer));
  const pinned = sidebarOpen;
  const shown = () => pinned() || peek();
  let inside = false;
  // A menu opened from the panel keeps it up; once it closes, the pointer
  // decides again.
  createEffect(() => {
    if (!menuOpen() && !inside && !pinned()) later(false, 240);
  });

  return (
    <div
      class="relative z-30 shrink-0 transition-[width] duration-150 ease-out"
      style={{ width: pinned() ? "232px" : "48px" }}
      onMouseEnter={() => {
        inside = true;
        if (!pinned()) later(true, 80);
      }}
      onMouseLeave={() => {
        inside = false;
        if (!pinned() && !menuOpen()) later(false, 240);
      }}
    >
      <Show when={!pinned()}>
        <Rail />
      </Show>
      <div
        class="absolute inset-y-0 left-0 w-[232px] transition-[transform,opacity] duration-150 ease-out"
        classList={{
          "pointer-events-none -translate-x-2 opacity-0": !shown(),
          "shadow-cx-lg": !pinned(),
        }}
        aria-hidden={!shown()}
      >
        <Panel pinned={pinned()} />
      </div>
    </div>
  );
}

function Rail() {
  const projects = createMemo(() => projectsStore.list.filter((p) => !isMasterProject(p)));
  return (
    <div class="flex h-full w-[48px] flex-col items-center gap-1.5 border-r border-line bg-panel py-2">
      <For each={projects()}>
        {(p) => {
          const waiting = () => p.runners.some(needsYou);
          const working = () =>
            p.runners.some((r) => r.live && (r.status === "streaming" || r.status === "tool_running"));
          return (
            <span
              class="font-heading relative flex h-[30px] w-[30px] items-center justify-center rounded-[10px] text-[13px]"
              classList={{
                "bg-fill-3 text-ink": routeProjectId() === p.id,
                "bg-fill-1 text-dim": routeProjectId() !== p.id,
              }}
            >
              {labelOf(p).replace(/^[~\\/.]+/, "").slice(0, 2) || "·"}
              <Show when={waiting() || working()}>
                <span
                  class="absolute -right-0.5 -top-0.5 h-[8px] w-[8px] rounded-full ring-2 ring-[var(--panel)]"
                  classList={{ "bg-busy": waiting(), "bg-live": !waiting() }}
                />
              </Show>
            </span>
          );
        }}
      </For>
    </div>
  );
}

function Panel(props: { pinned: boolean }) {
  const projects = createMemo(() => projectsStore.list.filter((p) => !isMasterProject(p)));

  return (
    <aside class="flex h-full w-[232px] flex-col border-r border-line bg-panel">
      <div class="flex h-[34px] shrink-0 items-center pl-4 pr-1.5">
        <span class="text-[11.5px] text-faint">Projetos</span>
        <button
          class="cx-icon-btn ml-auto"
          title={props.pinned ? "Recolher (⌘B). Abre sozinha ao passar o mouse." : "Fixar aberta (⌘B)"}
          aria-label={props.pinned ? "Recolher barra lateral" : "Fixar barra lateral"}
          onClick={() => setSidebarOpen(!props.pinned)}
        >
          {props.pinned ? <PanelLeftClose size={13} /> : <PanelLeftOpen size={13} />}
        </button>
        <button
          class="cx-icon-btn"
          title="O que aparece na lista"
          aria-label="O que aparece na lista"
          onClick={(e) =>
            openMenu(e.currentTarget, [
              ...navOptionsMenu(),
              {
                label: "Usar abas no topo",
                separatorBefore: true,
                onSelect: () => setNavMode("tabs"),
              },
            ])
          }
        >
          <ListTree size={13} />
        </button>
        <button
          class="cx-icon-btn"
          title="Adicionar projeto (⌘T)"
          aria-label="Adicionar projeto"
          onClick={() => openCreator({ mode: "project" })}
        >
          <Plus size={14} />
        </button>
      </div>
      <nav class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        <For each={projects()}>{(p) => <ProjectRow project={p} />}</For>
        <Show when={projects().length === 0}>
          <p class="px-2.5 py-2 text-[12px] leading-relaxed text-faint">
            Nenhum projeto ainda. Um projeto é só uma pasta do seu disco.
          </p>
        </Show>
      </nav>
    </aside>
  );
}

function ProjectRow(props: { project: ProjectUI }) {
  const p = () => props.project;
  const on = () => route().kind === "project" && routeProjectId() === p().id;
  const waiting = () => p().runners.filter(needsYou).length;
  const working = () =>
    p().runners.some((r) => r.live && (r.status === "streaming" || r.status === "tool_running"));

  return (
    <div class="mt-1.5 first:mt-0">
      <button
        class="group flex h-[30px] w-full items-center gap-2 rounded-lg px-2.5 text-left transition hover:bg-fill-2"
        classList={{ "bg-fill-3": on() }}
        onClick={() => focusProject(p().id)}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e, projectMenu(p()));
        }}
      >
        <span class="font-heading min-w-0 flex-1 truncate text-[14px] text-ink" title={p().folders[0]}>
          {projectLabel(p())}
        </span>
        <Show when={waiting() > 0}>
          <span class="flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-busy px-1 text-[10px] font-semibold text-accent-ink">
            {waiting()}
          </span>
        </Show>
        <Show when={waiting() === 0 && working()}>
          <span class="h-[6px] w-[6px] rounded-full bg-live" />
        </Show>
        <span
          role="button"
          class="hidden h-5 w-5 items-center justify-center rounded-full text-faint hover:bg-fill-3 hover:text-ink group-hover:flex"
          title="Novo agente neste projeto"
          onClick={(e) => {
            e.stopPropagation();
            openCreator({ mode: "agent", projectId: p().id });
          }}
        >
          <Plus size={12} />
        </span>
      </button>
      <Show when={childrenOf(p()).length > 0}>
        <div class="ml-[15px] border-l border-line pl-1.5">
          <For each={childrenOf(p())}>{(r) => <ChildRow project={p()} runner={r} />}</For>
        </div>
      </Show>
    </div>
  );
}

function ChildRow(props: { project: ProjectUI; runner: RunnerUI }) {
  const r = () => props.runner;
  const on = () => route().kind === "session" && focusedRunner()?.id === r().id;
  const shell = () => r().kind === "shell";
  return (
    <button
      class="flex h-[26px] w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] transition hover:bg-fill-2"
      classList={{
        "bg-fill-3 text-ink": on(),
        "text-dim": !on() && !r().unread,
        "text-ink": !on() && r().unread,
      }}
      title={r().name}
      onClick={() => focusRunner(props.project.id, r().id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, runnerMenu(props.project, r()));
      }}
    >
      <Show when={shell()} fallback={<StatusGlyph glyph={glyphFor(r())} size={12} />}>
        <span
          class="font-mono text-[10px]"
          classList={{ "text-live": r().live, "text-faint": !r().live }}
        >
          &gt;_
        </span>
      </Show>
      <span class="min-w-0 flex-1 truncate" classList={{ "font-mono text-[11.5px]": shell() }}>
        {r().name}
      </span>
    </button>
  );
}
