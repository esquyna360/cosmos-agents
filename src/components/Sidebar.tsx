import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  Bot,
  ChevronRight,
  Globe,
  Plus,
  Power,
  Search,
  Settings2,
  TerminalSquare,
} from "lucide-solid";

import {
  focusProject,
  focusedProjectId,
  projectsStore,
  sleepProject,
  updateProject,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import { focusRunner } from "../stores/projects";
import { openCreator } from "../stores/creator";
import { sidebarWidthPx, setSidebarWidthPx } from "../stores/layout";
import { activeSlot, slotsFor } from "../stores/panes";
import { colorForPath } from "../lib/colorHash";
import InlineEdit from "./InlineEdit";
import { webInfo, type WebInfo } from "../lib/remote";

function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

export default function Sidebar() {
  const [query, setQuery] = createSignal("");
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>(
    readCollapsed(),
  );

  const matches = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return projectsStore.list;
    return projectsStore.list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.folders.some((f) => f.toLowerCase().includes(q)) ||
        p.runners.some((r) => r.name.toLowerCase().includes(q)),
    );
  });

  function toggle(id: string) {
    const next = { ...collapsed(), [id]: !collapsed()[id] };
    setCollapsed(next);
    writeCollapsed(next);
  }

  return (
    <aside
      class="relative flex h-full shrink-0 flex-col border-r border-line bg-void"
      style={{ width: `${sidebarWidthPx()}px` }}
    >
      <div class="flex items-center gap-1.5 px-2.5 pb-2 pt-2.5">
        <div class="relative min-w-0 flex-1">
          <Search
            size={11}
            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            class="w-full rounded-lg border border-line bg-white/[0.03] py-1 pl-6 pr-2 text-[11.5px] text-ink outline-none transition placeholder:text-faint focus:border-white/20 focus:bg-white/[0.05]"
            placeholder="filtrar"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <button
          class="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg border border-line text-dim transition hover:border-white/25 hover:bg-white/6 hover:text-ink"
          onClick={() => openCreator({ mode: "project" })}
          title="novo projeto (⌘T)"
        >
          <Plus size={13} />
        </button>
      </div>

      <ul class="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 pb-2">
        <For each={matches()}>
          {(p) => (
            <ProjectRow
              project={p}
              collapsed={!!collapsed()[p.id]}
              onToggle={() => toggle(p.id)}
            />
          )}
        </For>
        <Show when={matches().length === 0}>
          <li class="px-2 py-6 text-center text-[11px] text-faint">
            nada com “{query()}”
          </li>
        </Show>
      </ul>

      <RemoteLink />
      <Shortcuts />
      <ResizeHandle />
    </aside>
  );
}

function ProjectRow(props: {
  project: ProjectUI;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const p = () => props.project;
  const isFocused = () => focusedProjectId() === p().id;
  const isMulti = () => p().folders.length > 1;
  const folderHint = () => {
    if (isMulti()) return `${p().folders.length} pastas`;
    const folder = basename(p().folders[0] ?? p().cwd);
    return p().name !== folder ? folder : null;
  };
  const liveCount = () => p().runners.filter((r) => r.live).length;

  return (
    <li>
      <div
        class="group flex items-center gap-1 rounded-lg px-1.5 py-1.5 transition"
        classList={{
          "bg-white/[0.07]": isFocused(),
          "hover:bg-white/[0.04]": !isFocused(),
        }}
      >
        <button
          class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-faint transition hover:text-ink"
          onClick={props.onToggle}
          title={props.collapsed ? "expandir" : "recolher"}
        >
          <ChevronRight
            size={11}
            class="transition-transform"
            style={{ transform: props.collapsed ? "none" : "rotate(90deg)" }}
          />
        </button>
        <button
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => focusProject(p().id)}
          title={[p().cwd, "", ...p().folders].join("\n")}
        >
          <span
            class="h-1.5 w-1.5 shrink-0 rounded-full transition"
            style={{
              "background-color": colorForPath(p().cwd),
              opacity: liveCount() > 0 ? 1 : 0.3,
              "box-shadow":
                liveCount() > 0
                  ? `0 0 7px ${colorForPath(p().cwd)}`
                  : "none",
            }}
          />
          <span class="min-w-0 flex-1 truncate">
            <InlineEdit
              value={p().name}
              onCommit={(next) => {
                const trimmed = next.trim();
                if (!trimmed || trimmed === p().name) return;
                updateProject(p().id, trimmed, p().folders, p().memory).catch(
                  console.error,
                );
              }}
            >
              {(name) => (
                <span class="flex min-w-0 items-baseline gap-1.5 truncate">
                  <span
                    class="truncate text-[12.5px] font-medium"
                    classList={{
                      "text-ink": isFocused() || liveCount() > 0,
                      "text-dim": !isFocused() && liveCount() === 0,
                    }}
                  >
                    {name}
                  </span>
                  <Show when={folderHint()}>
                    <span class="shrink-0 truncate text-[10px] font-normal text-faint">
                      {folderHint()}
                    </span>
                  </Show>
                </span>
              )}
            </InlineEdit>
          </span>
        </button>
        <button
          class="hidden shrink-0 rounded p-1 text-faint transition hover:bg-white/10 hover:text-ink group-hover:inline-flex"
          onClick={(e) => {
            e.stopPropagation();
            openCreator({ mode: "project", editingProjectId: p().id });
          }}
          title="editar projeto"
        >
          <Settings2 size={11} />
        </button>
        <Show when={liveCount() > 0}>
          <button
            class="hidden shrink-0 rounded p-1 text-faint transition hover:bg-white/10 hover:text-ink group-hover:inline-flex"
            onClick={(e) => {
              e.stopPropagation();
              sleepProject(p().id).catch(console.error);
            }}
            title="parar os runners — nada é apagado"
          >
            <Power size={11} />
          </button>
        </Show>
      </div>

      <Show when={!props.collapsed && p().runners.length > 0}>
        <ul class="mb-0.5 ml-[13px] border-l border-line pl-1.5">
          <For each={p().runners}>
            {(r) => <RunnerRow project={p()} runner={r} />}
          </For>
        </ul>
      </Show>
    </li>
  );
}

function RunnerRow(props: { project: ProjectUI; runner: RunnerUI }) {
  const r = () => props.runner;
  const onScreen = () =>
    slotsFor(props.project.id).includes(r().id) &&
    focusedProjectId() === props.project.id;
  const inActiveSlot = () =>
    focusedProjectId() === props.project.id &&
    slotsFor(props.project.id)[activeSlot()] === r().id;

  return (
    <li>
      <button
        class="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11.5px] transition"
        classList={{
          "bg-white/8 text-ink": inActiveSlot(),
          "text-dim hover:bg-white/[0.04] hover:text-ink": !inActiveSlot(),
        }}
        onClick={() => focusRunner(props.project.id, r().id)}
        title={
          r().live
            ? `${r().kind} · ${r().name}`
            : `${r().name} — parado. clique para retomar a sessão`
        }
      >
        <span class="shrink-0 opacity-50">
          {r().kind === "shell" ? (
            <TerminalSquare size={10} />
          ) : (
            <Bot size={10} />
          )}
        </span>
        <span
          class="h-1 w-1 shrink-0 rounded-full"
          classList={{
            "bg-live": r().live && r().status === "idle",
            "bg-busy cx-pulse":
              r().live && (r().status === "streaming" || r().status === "tool_running"),
            "bg-alert cx-pulse": r().status === "awaiting_input",
            "bg-alert": r().status === "error",
            "bg-white/20": !r().live || r().status === "exited",
          }}
        />
        <span class="min-w-0 flex-1 truncate">{r().name}</span>
        <Show when={onScreen()}>
          <span class="h-1 w-1 shrink-0 rounded-full bg-accent" title="no grid" />
        </Show>
      </button>
    </li>
  );
}

/// Footer affordance for the web control plane. A quick-tunnel URL rotates on
/// every reconnect, so the value of showing it is that one click puts the
/// *current* one on the clipboard.
function RemoteLink() {
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
    <button
      class="flex items-center gap-2 border-t border-line px-3 py-2 text-left text-[11px] text-faint transition hover:bg-white/[0.04] hover:text-dim"
      disabled={!link()}
      title={link() ?? "web UI desligada"}
      onClick={() => {
        const url = link();
        if (!url) return;
        navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      <Globe size={12} class={online() ? "text-live" : "text-faint"} />
      <span class="min-w-0 flex-1 truncate">
        {copied()
          ? "link copiado"
          : online()
            ? "remoto ativo · copiar link"
            : link()
              ? "só local · copiar link"
              : "web ui off"}
      </span>
    </button>
  );
}

function Shortcuts() {
  return (
    <div class="overflow-hidden border-t border-line px-3 py-2 text-[10px] leading-[1.6] text-faint">
      <div class="truncate">⌘T projeto · ⌘⇧N agente · ⌘W parar</div>
      <div class="truncate">⌘⌥1–5 layout · ⌃1–4 painel · ⌘\ dividir</div>
      <div class="truncate">⌘E view · ⌘P arquivo · ⌘⇧F buscar</div>
      <div class="truncate">⌘B barra · ⌘I compor · ⌘1–9 projeto</div>
    </div>
  );
}

function ResizeHandle() {
  let dragging = false;
  function onMouseDown(e: MouseEvent) {
    dragging = true;
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      if (!dragging) return;
      setSidebarWidthPx(ev.clientX);
    };
    const up = () => {
      dragging = false;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  return (
    <div
      class="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-transparent transition hover:bg-white/12"
      onMouseDown={onMouseDown}
      title="arraste para redimensionar"
    />
  );
}

/* ------------------------------ persistence ------------------------------ */

const KEY_COLLAPSED = "cosmos.sidebar.collapsed.v3";

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY_COLLAPSED) || "{}") ?? {};
  } catch {
    return {};
  }
}

function writeCollapsed(v: Record<string, boolean>): void {
  try {
    localStorage.setItem(KEY_COLLAPSED, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
