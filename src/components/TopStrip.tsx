import { projectLabel } from "../lib/projectLabel";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ChevronRight, Globe, ListTree, Moon, Plus, Search, Settings2, Sun, X } from "lucide-solid";

import {
  focusProject,
  focusRunner,
  focusedProject,
  focusedRunner,
  isMasterProject,
  masterRunner,
  projectsStore,
  type ProjectUI,
} from "../stores/projects";
import { closeTab, go, navMode, openTabs, route, routeProjectId, setNavMode } from "../stores/nav";
import { openCreator } from "../stores/creator";
import { openJump } from "../stores/jump";
import { setSettingsOpen } from "../stores/layout";
import { cycleTheme, themeSpec } from "../stores/theme";
import { webInfo, type WebInfo } from "../lib/remote";
import { needsYou } from "../ui/StatusGlyph";
import { openMenu } from "../ui/Menu";
import { projectMenu, runnerMenu } from "./menus";
import { childrenOf, navOptionsMenu } from "./SideNav";
import StatusGlyph, { glyphFor } from "../ui/StatusGlyph";

/** The one piece of chrome that never changes: three fixed places, the
 *  projects you have open, and where you are inside one. */
export default function TopStrip() {
  const tabs = createMemo(() =>
    openTabs()
      .map((id) => projectsStore.list.find((p) => p.id === id))
      .filter((p): p is ProjectUI => Boolean(p) && !isMasterProject(p!)),
  );
  const waiting = createMemo(
    () => projectsStore.list.flatMap((p) => p.runners).filter(needsYou).length,
  );
  const crumb = () => {
    const r = route();
    if (r.kind !== "session") return null;
    const runner = focusedRunner();
    return runner && runner.id !== masterRunner()?.id ? runner : null;
  };

  return (
    <header
      data-tauri-drag-region
      class="flex h-[var(--strip-h)] shrink-0 items-center gap-1 border-b border-line bg-panel pl-[84px] pr-2.5"
    >
      <nav class="flex shrink-0 items-center gap-0.5">
        <button class="cx-pill" data-on={route().kind === "home"} onClick={() => go({ kind: "home" })}>
          Início
          <Show when={waiting() > 0}>
            <span
              class="-mr-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-busy px-1 text-[10.5px] font-semibold text-accent-ink"
              title={`${waiting()} esperando você`}
            >
              {waiting()}
            </span>
          </Show>
        </button>
        <button class="cx-pill" data-on={route().kind === "hub"} onClick={() => go({ kind: "hub" })}>
          Hub
        </button>
      </nav>

      <Show when={navMode() === "tabs" && tabs().length > 0}>
        <span class="mx-1.5 h-4 w-px shrink-0 bg-line-strong" />
      </Show>

      <Show when={navMode() === "tabs"}>
        <div class="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          <For each={tabs()}>{(p) => <ProjectTabPill project={p} />}</For>
        </div>
        <button
          class="cx-icon-btn shrink-0"
          title="Adicionar projeto (⌘T)"
          aria-label="Adicionar projeto"
          onClick={() => openCreator({ mode: "project" })}
        >
          <Plus size={14} />
        </button>
        <button
          class="cx-icon-btn shrink-0"
          title="O que aparece nas abas"
          aria-label="O que aparece nas abas"
          onClick={(e) =>
            openMenu(e.currentTarget, [
              ...navOptionsMenu(),
              { label: "Usar barra lateral", hint: "⌘B", separatorBefore: true, onSelect: () => setNavMode("sidebar") },
            ])
          }
        >
          <ListTree size={13} />
        </button>
      </Show>

      <Show when={crumb()}>
        {(r) => (
          <span class="ml-1 flex min-w-0 items-center gap-1 text-[12.5px] text-dim" data-tauri-drag-region>
            <ChevronRight size={12} class="shrink-0 text-faint" />
            <span class="truncate">{r().name}</span>
          </span>
        )}
      </Show>

      <div class="ml-auto flex shrink-0 items-center gap-1 pl-2">
        <Remote />
        <button class="cx-pill" onClick={openJump} title="Ir para qualquer agente ou projeto">
          <Search size={12} />
          Ir para
          <span class="cx-kbd">⌘K</span>
        </button>
        <button
          class="cx-icon-btn"
          onClick={cycleTheme}
          title={themeSpec().mode === "dark" ? "Tema claro (⌘⇧T)" : "Tema escuro (⌘⇧T)"}
        >
          {themeSpec().mode === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <button class="cx-icon-btn" onClick={() => setSettingsOpen(true)} title="Configurações (⌘,)">
          <Settings2 size={14} />
        </button>
        <button
          class="cx-btn-primary ml-1 !h-[28px]"
          onClick={() => openCreator({ mode: "agent", projectId: routeProjectId() ?? undefined })}
        >
          Novo agente
          <span class="font-sans text-[11px] opacity-70">⌘N</span>
        </button>
      </div>
    </header>
  );
}

function ProjectTabPill(props: { project: ProjectUI }) {
  const p = () => props.project;
  const on = () => routeProjectId() === p().id;
  const dot = () => {
    if (p().runners.some(needsYou)) return "bg-busy";
    if (p().runners.some((r) => r.live && (r.status === "streaming" || r.status === "tool_running")))
      return "bg-live";
    if (p().runners.some((r) => r.unread)) return "bg-accent";
    return "bg-fill-4";
  };
  return (
    <span
      class="cx-pill group !gap-1.5 !pr-1.5"
      data-on={on()}
      role="button"
      tabIndex={0}
      onClick={() => focusProject(p().id)}
      onKeyDown={(e) => e.key === "Enter" && focusProject(p().id)}
      onAuxClick={(e) => e.button === 1 && closeTab(p().id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, projectMenu(p()));
      }}
    >
      <span class={`h-[6px] w-[6px] shrink-0 rounded-full ${dot()}`} />
      <span class="max-w-[150px] truncate" title={p().folders[0]}>{projectLabel(p())}</span>
      <button
        class="flex h-4 w-4 items-center justify-center rounded-full text-faint opacity-0 transition hover:bg-fill-3 hover:text-ink group-hover:opacity-100"
        classList={{ "!opacity-100": on() }}
        aria-label={`Fechar aba ${p().name}`}
        onClick={(e) => {
          e.stopPropagation();
          closeTab(p().id);
        }}
      >
        <X size={10} />
      </button>
    </span>
  );
}

function Remote() {
  const [info, setInfo] = createSignal<WebInfo | null>(null);
  const [copied, setCopied] = createSignal(false);
  const refresh = () => webInfo().then(setInfo).catch(() => setInfo(null));
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    onCleanup(() => clearInterval(t));
  });
  const link = () => info()?.link || info()?.local || null;
  const online = () => Boolean(info()?.tunnel);
  return (
    <Show when={link()}>
      <button
        class="cx-icon-btn"
        title={copied() ? "Link copiado" : `${online() ? "Acesso remoto" : "Acesso local"}: copiar link`}
        onClick={() =>
          navigator.clipboard.writeText(link()!).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
        }
      >
        <Globe size={14} class={copied() || online() ? "text-live" : ""} />
      </button>
    </Show>
  );
}

/** Tabs mode only: the open project's agents (and terminals) as a second row. */
export function ChildStrip() {
  const project = () => (navMode() === "tabs" && routeProjectId() ? focusedProject() : null);
  return (
    <Show when={project() && childrenOf(project()!).length > 0}>
      <div class="flex h-[34px] shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-panel px-3 [scrollbar-width:none]">
        <For each={childrenOf(project()!)}>
          {(r) => (
            <button
              class="cx-pill !h-[24px] !text-[12px]"
              classList={{ "font-mono !text-[11.5px]": r.kind === "shell" }}
              data-on={focusedRunner()?.id === r.id}
              onClick={() => focusRunner(project()!.id, r.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e, runnerMenu(project()!, r));
              }}
            >
              <Show when={r.kind === "shell"} fallback={<StatusGlyph glyph={glyphFor(r)} size={11} />}>
                <span class="text-[10px]" classList={{ "text-live": r.live, "text-faint": !r.live }}>
                  &gt;_
                </span>
              </Show>
              <span class="max-w-[180px] truncate">{r.name}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
