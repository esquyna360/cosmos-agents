import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  Bot,
  ChevronRight,
  Globe,
  GripVertical,
  Plus,
  Power,
  Search,
  Settings2,
  TerminalSquare,
} from "lucide-solid";

import {
  focusProject,
  focusedProjectId,
  focusRunner,
  moveProject,
  moveRunner,
  renameRunner,
  projectsStore,
  sleepProject,
  updateProject,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import { openCreator } from "../stores/creator";
import {
  setSettingsOpen,
  setSidebarWidthPx,
  sidebarWidthPx,
} from "../stores/layout";
import { activeSlot, slotsFor } from "../stores/panes";
import { colorForPath } from "../lib/colorHash";
import InlineEdit from "./InlineEdit";
import { webInfo, type WebInfo } from "../lib/remote";

function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

/* ------------------------------ drag & drop ------------------------------
   HTML5 DnD only reveals its payload on drop, but rows need to know *during*
   the drag whether they are a legal target — a runner must not land between
   projects, and a runner from another project must not land here. So the drag
   subject lives in a module signal instead of the DataTransfer. */

type Drag = { kind: "project" | "runner"; id: string; projectId: string };

const [drag, setDrag] = createSignal<Drag | null>(null);
const [dropBefore, setDropBefore] = createSignal<string | null>(null);

function endDrag() {
  setDrag(null);
  setDropBefore(null);
}

/// A draggable ancestor swallows text selection inside an input, so renaming
/// in place has to veto the drag.
function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.tagName === "INPUT";
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

  // Reordering a filtered list would persist an order for rows the user can't
  // see, so dragging is only offered on the full list.
  const reorderable = () => query().trim() === "";

  function toggle(id: string) {
    const next = { ...collapsed(), [id]: !collapsed()[id] };
    setCollapsed(next);
    writeCollapsed(next);
  }

  const liveTotal = () =>
    projectsStore.list.reduce(
      (n, p) => n + p.runners.filter((r) => r.live).length,
      0,
    );

  return (
    <aside
      class="relative flex h-full shrink-0 flex-col border-r border-line bg-panel"
      style={{ width: `${sidebarWidthPx()}px` }}
    >
      <div class="flex items-center gap-1.5 px-2.5 pb-1.5 pt-2.5">
        <div class="relative min-w-0 flex-1">
          <Search
            size={11}
            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            class="w-full rounded-cx border border-line bg-fill-1 py-1.5 pl-6 pr-2 text-[11.5px] text-ink outline-none transition placeholder:text-faint focus:border-accent focus:bg-fill-2"
            placeholder="filtrar"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <button
          class="flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-cx border border-line text-dim transition hover:border-line-strong hover:bg-fill-2 hover:text-ink"
          onClick={() => openCreator({ mode: "project" })}
          title="novo projeto (⌘T)"
        >
          <Plus size={13} />
        </button>
      </div>

      <div class="flex items-baseline justify-between px-3 pb-1 pt-1.5">
        <span class="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint">
          projetos
        </span>
        <Show when={liveTotal() > 0}>
          <span class="text-[9.5px] tabular-nums text-faint">
            {liveTotal()} ativo{liveTotal() === 1 ? "" : "s"}
          </span>
        </Show>
      </div>

      <ul
        class="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2"
        onDragOver={(e) => {
          // Dropping on the empty space past the last row appends.
          if (drag()?.kind === "project" && e.target === e.currentTarget) {
            e.preventDefault();
            setDropBefore(null);
          }
        }}
        onDrop={(e) => {
          const d = drag();
          if (d?.kind === "project" && e.target === e.currentTarget) {
            e.preventDefault();
            moveProject(d.id, null);
          }
          endDrag();
        }}
      >
        <For each={matches()}>
          {(p) => (
            <ProjectRow
              project={p}
              collapsed={!!collapsed()[p.id]}
              reorderable={reorderable()}
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
      <ResizeHandle />
    </aside>
  );
}

/* -------------------------------- project -------------------------------- */

function ProjectRow(props: {
  project: ProjectUI;
  collapsed: boolean;
  reorderable: boolean;
  onToggle: () => void;
}) {
  const p = () => props.project;
  const isFocused = () => focusedProjectId() === p().id;
  const folderHint = () => {
    if (p().folders.length > 1) return `${p().folders.length} pastas`;
    const folder = basename(p().folders[0] ?? p().cwd);
    return p().name !== folder ? folder : null;
  };
  const liveCount = () => p().runners.filter((r) => r.live).length;
  const isDropTarget = () =>
    drag()?.kind === "project" && dropBefore() === p().id;

  return (
    <li
      classList={{
        "cx-dragging": drag()?.kind === "project" && drag()?.id === p().id,
        "cx-drop-before": isDropTarget(),
      }}
      draggable={props.reorderable}
      onDragStart={(e) => {
        if (isTextField(e.target)) {
          e.preventDefault();
          return;
        }
        setDrag({ kind: "project", id: p().id, projectId: p().id });
        e.dataTransfer?.setData("text/plain", p().id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={endDrag}
      onDragOver={(e) => {
        if (drag()?.kind !== "project") return;
        e.preventDefault();
        e.stopPropagation();
        setDropBefore(p().id);
      }}
      onDrop={(e) => {
        const d = drag();
        if (d?.kind !== "project") return;
        e.preventDefault();
        e.stopPropagation();
        moveProject(d.id, p().id);
        endDrag();
      }}
    >
      <div
        class="group relative flex items-center gap-1 rounded-cx py-1.5 pl-1 pr-1.5 transition"
        classList={{
          "bg-fill-2": isFocused(),
          "hover:bg-fill-1": !isFocused(),
        }}
      >
        {/* The grip is what carries the drag. Making the whole row draggable
            would fight text selection and the inline rename. */}
        <span
          class={`flex h-4 w-3 shrink-0 items-center justify-center text-faint transition ${
            props.reorderable
              ? "cursor-grab opacity-0 group-hover:opacity-100 active:cursor-grabbing"
              : "invisible"
          }`}
          title="arraste para reordenar"
        >
          <GripVertical size={11} />
        </span>

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
          title={[...p().folders, "", "duplo clique renomeia"].join("\n")}
        >
          <span
            class="h-1.5 w-1.5 shrink-0 rounded-full transition"
            style={{
              "background-color": colorForPath(p().cwd),
              opacity: liveCount() > 0 ? 1 : 0.35,
              "box-shadow":
                liveCount() > 0 ? `0 0 7px ${colorForPath(p().cwd)}` : "none",
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
                <span class="flex min-w-0 flex-col">
                  <span
                    class="truncate text-[12.5px] font-semibold leading-tight"
                    classList={{
                      "text-ink": isFocused() || liveCount() > 0,
                      "text-dim": !isFocused() && liveCount() === 0,
                    }}
                  >
                    {name}
                  </span>
                  <Show when={folderHint()}>
                    <span class="truncate text-[10px] font-normal leading-tight text-faint">
                      {folderHint()}
                    </span>
                  </Show>
                </span>
              )}
            </InlineEdit>
          </span>
        </button>

        <button
          class="hidden shrink-0 rounded p-1 text-faint transition hover:bg-fill-2 hover:text-ink group-hover:inline-flex"
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
            class="hidden shrink-0 rounded p-1 text-faint transition hover:bg-fill-2 hover:text-ink group-hover:inline-flex"
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
        <ul class="mb-1 ml-[19px] mt-0.5 border-l border-line pl-1">
          <For each={p().runners}>
            {(r) => (
              <RunnerRow
                project={p()}
                runner={r}
                reorderable={props.reorderable}
              />
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}

/* --------------------------------- runner -------------------------------- */

function RunnerRow(props: {
  project: ProjectUI;
  runner: RunnerUI;
  reorderable: boolean;
}) {
  const r = () => props.runner;
  const inProject = () => focusedProjectId() === props.project.id;
  const onScreen = () =>
    inProject() && slotsFor(props.project.id).includes(r().id);
  /** The runner the composer and ⌘W act on. This is *the* selection, and the
   *  reason it gets the accent rail: nothing else in the sidebar uses accent,
   *  so it can never be confused with the project row's fill. */
  const selected = () =>
    inProject() && slotsFor(props.project.id)[activeSlot()] === r().id;
  const isDropTarget = () =>
    drag()?.kind === "runner" &&
    drag()?.projectId === props.project.id &&
    dropBefore() === r().id;

  const statusLabel = () => {
    if (!r().live) return "parado";
    switch (r().status) {
      case "streaming":
        return "escrevendo";
      case "tool_running":
        return "rodando";
      case "awaiting_input":
        return "esperando você";
      case "error":
        return "erro";
      default:
        return "ocioso";
    }
  };

  return (
    <li
      classList={{
        "cx-dragging": drag()?.kind === "runner" && drag()?.id === r().id,
        "cx-drop-before": isDropTarget(),
      }}
      draggable={props.reorderable}
      onDragStart={(e) => {
        e.stopPropagation();
        if (isTextField(e.target)) {
          e.preventDefault();
          return;
        }
        setDrag({ kind: "runner", id: r().id, projectId: props.project.id });
        e.dataTransfer?.setData("text/plain", r().id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={endDrag}
      onDragOver={(e) => {
        const d = drag();
        // Runners only reorder within their own project.
        if (d?.kind !== "runner" || d.projectId !== props.project.id) return;
        e.preventDefault();
        e.stopPropagation();
        setDropBefore(r().id);
      }}
      onDrop={(e) => {
        const d = drag();
        if (d?.kind !== "runner" || d.projectId !== props.project.id) return;
        e.preventDefault();
        e.stopPropagation();
        moveRunner(props.project.id, d.id, r().id);
        endDrag();
      }}
    >
      <div
        class="group relative flex items-center rounded-cx transition"
        classList={{
          "bg-accent-soft": selected(),
          "hover:bg-fill-1": !selected(),
        }}
      >
        <Show when={selected()}>
          <span class="absolute -left-[5px] top-1/2 h-[16px] w-[3px] -translate-y-1/2 rounded-full bg-accent" />
        </Show>

        <span
          class={`flex h-4 w-3 shrink-0 items-center justify-center text-faint transition ${
            props.reorderable
              ? "cursor-grab opacity-0 group-hover:opacity-100 active:cursor-grabbing"
              : "invisible"
          }`}
          title="arraste para reordenar"
        >
          <GripVertical size={10} />
        </span>

        <button
          class="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1.5 text-left transition"
          classList={{ "text-ink": selected(), "text-dim group-hover:text-ink": !selected() }}
          onClick={() => focusRunner(props.project.id, r().id)}
          title={`${r().kind} · ${r().name} — ${statusLabel()}${
            r().live ? "" : ". clique para retomar a sessão"
          }\nduplo clique renomeia`}
        >
          <span
            class="shrink-0"
            classList={{ "text-accent": selected(), "opacity-60": !selected() }}
          >
            {r().kind === "shell" ? (
              <TerminalSquare size={11} />
            ) : (
              <Bot size={11} />
            )}
          </span>

          <span
            class="h-1 w-1 shrink-0 rounded-full"
            classList={{
              "bg-live": r().live && r().status === "idle",
              "bg-busy cx-pulse":
                r().live &&
                (r().status === "streaming" || r().status === "tool_running"),
              "bg-alert cx-pulse": r().status === "awaiting_input",
              "bg-alert": r().status === "error",
              "bg-fill-4": !r().live || r().status === "exited",
            }}
          />

          <span class="min-w-0 flex-1 truncate">
            <InlineEdit
              value={r().name}
              inputClass="w-full min-w-0 rounded border border-accent bg-float px-1 py-0 text-[11.5px] text-ink outline-none"
              onCommit={(next) => {
                const trimmed = next.trim();
                if (!trimmed || trimmed === r().name) return;
                renameRunner(r().id, trimmed).catch(console.error);
              }}
            >
              {(name) => (
                <span
                  class="block truncate text-[11.5px]"
                  classList={{ "font-semibold": selected() }}
                >
                  {name}
                </span>
              )}
            </InlineEdit>
          </span>

          {/* Visible in another pane, but not the one being typed into. */}
          <Show when={onScreen() && !selected()}>
            <span
              class="h-1 w-1 shrink-0 rounded-full bg-fill-4"
              title="visível em outro painel"
            />
          </Show>
        </button>
      </div>
    </li>
  );
}

/* --------------------------------- footer -------------------------------- */

/// The quick-tunnel URL rotates on every reconnect, so the value of showing it
/// is that one click puts the *current* one on the clipboard.
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
    <div class="flex items-center gap-1 border-t border-line px-2 py-1.5">
      <button
        class="flex min-w-0 flex-1 items-center gap-2 rounded-cx px-1.5 py-1 text-left text-[11px] text-faint transition hover:bg-fill-1 hover:text-dim"
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
              ? "remoto ativo · copiar"
              : link()
                ? "só local · copiar"
                : "web ui off"}
        </span>
      </button>
      <button
        class="shrink-0 rounded-cx p-1.5 text-faint transition hover:bg-fill-2 hover:text-ink"
        onClick={() => setSettingsOpen(true)}
        title="configurações (⌘,)"
      >
        <Settings2 size={12} />
      </button>
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
      class="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-transparent transition hover:bg-accent-soft"
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
