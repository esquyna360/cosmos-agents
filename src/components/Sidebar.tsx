import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  ChevronRight,
  Globe,
  MessageSquare,
  Moon,
  PanelLeft,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Search,
  Settings2,
  SquareTerminal,
  Sun,
  Trash2,
} from "lucide-solid";

import {
  deleteProject,
  deleteRunner,
  focusedProjectId,
  focusedRunner,
  focusProject,
  focusRunner,
  isMasterProject,
  moveProject,
  moveRunner,
  newSession,
  newTerminal,
  projectsStore,
  restartRunner,
  setRunnerMode,
  sleepProject,
  stopRunner,
  updateProject,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import { renameSession } from "../stores/chat";
import { openCreator } from "../stores/creator";
import {
  setSettingsOpen,
  setSidebarWidthPx,
  sidebarWidthPx,
  toggleSidebar,
} from "../stores/layout";
import { openJump } from "../stores/jump";
import { cycleTheme, themeSpec } from "../stores/theme";
import { webInfo, type WebInfo } from "../lib/remote";
import { relativeTime } from "../lib/time";
import InlineEdit, { startInlineEdit } from "./InlineEdit";
import StatusGlyph, { glyphFor } from "../ui/StatusGlyph";
import { openMenu, type MenuItem } from "../ui/Menu";

/* ------------------------------ drag & drop ------------------------------
   HTML5 DnD only reveals its payload on drop, but rows need to know *during*
   the drag whether they are a legal target, so the subject lives in a signal
   instead of the DataTransfer. */

type Drag = { kind: "project" | "runner"; id: string; projectId: string };

const [drag, setDrag] = createSignal<Drag | null>(null);
const [dropBefore, setDropBefore] = createSignal<string | null>(null);

function endDrag() {
  setDrag(null);
  setDropBefore(null);
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.tagName === "INPUT";
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>(readCollapsed());

  function toggle(id: string) {
    const next = { ...collapsed(), [id]: !collapsed()[id] };
    setCollapsed(next);
    writeCollapsed(next);
  }

  /** Whatever is blocked on you or finished behind your back, across every
   *  project. This is the list that makes running many agents workable. */
  const attention = createMemo(() => {
    const out: { project: ProjectUI; runner: RunnerUI }[] = [];
    const current = focusedRunner()?.id;
    for (const project of projectsStore.list)
      for (const runner of project.runners) {
        if (runner.id === current) continue;
        if (runner.status === "awaiting_input" || runner.status === "error" || runner.unread)
          out.push({ project, runner });
      }
    return out.sort(
      (a, b) =>
        Number(b.runner.status === "awaiting_input") -
        Number(a.runner.status === "awaiting_input"),
    );
  });

  return (
    <aside
      class="relative flex h-full shrink-0 flex-col border-r border-line bg-panel"
      style={{ width: `${sidebarWidthPx()}px` }}
    >
      <div
        data-tauri-drag-region="deep"
        class="flex h-[var(--titlebar-h)] shrink-0 items-center justify-end pr-2"
      >
        <button
          data-tauri-drag-region="false"
          class="cx-icon-btn"
          onClick={toggleSidebar}
          title="Ocultar barra lateral (⌘B)"
        >
          <PanelLeft size={14} />
        </button>
      </div>

      <div class="px-2.5 pb-2">
        <button
          class="flex w-full items-center gap-2 rounded-cx border border-line bg-fill-1 px-2.5 py-[7px] text-left text-[12.5px] text-faint transition hover:border-line-strong hover:text-dim"
          onClick={openJump}
        >
          <Search size={13} />
          <span class="flex-1">Ir para…</span>
          <kbd class="cx-kbd">⌘K</kbd>
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        <Show when={attention().length > 0}>
          <SectionLabel>Precisa de você</SectionLabel>
          <ul class="mb-3 space-y-px">
            <For each={attention()}>
              {(a) => <SessionRow project={a.project} runner={a.runner} showProject />}
            </For>
          </ul>
        </Show>

        <div class="flex items-center justify-between pr-1">
          <SectionLabel>Projetos</SectionLabel>
          <button
            class="cx-icon-btn h-5 w-5"
            onClick={() => openCreator({ mode: "project" })}
            title="Novo projeto (⌘T)"
          >
            <Plus size={13} />
          </button>
        </div>

        <ul
          onDragOver={(e) => {
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
          <For each={projectsStore.list}>
            {(p) => (
              <ProjectGroup
                project={p}
                collapsed={!!collapsed()[p.id]}
                onToggle={() => toggle(p.id)}
              />
            )}
          </For>
        </ul>

        <Show when={projectsStore.list.length === 0}>
          <p class="px-2 py-4 text-[12px] leading-relaxed text-faint">
            Um projeto é uma ou mais pastas onde seus agentes trabalham.
          </p>
        </Show>
      </div>

      <Footer />
      <ResizeHandle />
    </aside>
  );
}

function SectionLabel(props: { children: string }) {
  return (
    <div class="px-2 pb-1 pt-1.5 text-[11px] font-medium text-faint">{props.children}</div>
  );
}

/* -------------------------------- project -------------------------------- */

function ProjectGroup(props: {
  project: ProjectUI;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const p = () => props.project;
  const liveCount = () => p().runners.filter((r) => r.live).length;
  const isDropTarget = () => drag()?.kind === "project" && dropBefore() === p().id;

  const [confirming, setConfirming] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  /// A project with nothing running is one click away. One with live agents
  /// asks for its name first — that is the case where a misclick costs work.
  const needsTyping = () => liveCount() > 0;
  const armed = () => !needsTyping() || typed().trim() === p().name;

  async function runDelete() {
    if (!armed() || deleting()) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProject(p().id);
    } catch (e) {
      setDeleteError(String(e));
      setDeleting(false);
    }
  }

  function menu(): MenuItem[] {
    return [
      {
        label: "Nova sessão",
        icon: MessageSquare,
        hint: "⌘N",
        onSelect: () => void newSession(p().id),
      },
      {
        label: "Novo terminal",
        icon: SquareTerminal,
        hint: "⌘⇧N",
        onSelect: () => void newTerminal(p().id),
      },
      {
        label: "Renomear",
        icon: Pencil,
        separatorBefore: true,
        onSelect: () => startInlineEdit(`project:${p().id}`),
      },
      {
        label: "Pastas e memória",
        icon: Settings2,
        onSelect: () => openCreator({ mode: "project", editingProjectId: p().id }),
      },
      {
        label: "Parar tudo",
        icon: Power,
        disabled: liveCount() === 0,
        onSelect: () => void sleepProject(p().id),
      },
      ...(isMasterProject(p())
        ? []
        : [
            {
              label: "Excluir projeto",
              icon: Trash2,
              danger: true,
              separatorBefore: true,
              onSelect: () => {
                setTyped("");
                setDeleteError(null);
                setConfirming(true);
              },
            } satisfies MenuItem,
          ]),
    ];
  }

  return (
    <li
      class="mb-1"
      classList={{
        "cx-dragging": drag()?.kind === "project" && drag()?.id === p().id,
        "cx-drop-before": isDropTarget(),
      }}
      draggable={true}
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
        class="group flex h-[30px] items-center gap-1 rounded-cx pl-1 pr-1 transition hover:bg-fill-1"
        onContextMenu={(e) => openMenu(e, menu())}
      >
        <button
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint transition hover:text-ink"
          onClick={props.onToggle}
          title={props.collapsed ? "Expandir" : "Recolher"}
        >
          <ChevronRight
            size={12}
            class="transition-transform"
            style={{ transform: props.collapsed ? "none" : "rotate(90deg)" }}
          />
        </button>
        <button
          class="min-w-0 flex-1 truncate text-left text-[12.5px] font-semibold"
          classList={{
            "text-ink": focusedProjectId() === p().id,
            "text-dim": focusedProjectId() !== p().id,
          }}
          onClick={() => {
            focusProject(p().id);
            if (props.collapsed) props.onToggle();
          }}
          title={p().folders.join("\n")}
        >
          <InlineEdit
            editKey={`project:${p().id}`}
            value={p().name}
            onCommit={(next) => {
              const trimmed = next.trim();
              if (!trimmed || trimmed === p().name) return;
              updateProject(p().id, trimmed, p().folders, p().memory).catch(console.error);
            }}
          >
            {(name) => <span class="truncate">{name}</span>}
          </InlineEdit>
        </button>
        <Show when={props.collapsed && liveCount() > 0}>
          <span class="shrink-0 pr-1 text-[11px] tabular-nums text-faint group-hover:hidden">
            {liveCount()}
          </span>
        </Show>
        <button
          class="cx-icon-btn hidden h-5 w-5 group-hover:flex"
          onClick={() => void newSession(p().id)}
          title="Nova sessão neste projeto"
        >
          <Plus size={13} />
        </button>
      </div>

      <Show when={confirming()}>
        <div
          class="mx-1 mb-1 mt-1 rounded-cx border border-alert/30 bg-alert-soft px-2.5 py-2"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setConfirming(false);
            }
          }}
        >
          <p class="text-[12px] leading-snug text-dim">
            Excluir <b class="text-ink">{p().name}</b>
            <Show when={p().runners.length > 0}>
              {" "}
              e {p().runners.length === 1 ? "sua sessão" : `suas ${p().runners.length} sessões`}
            </Show>
            ? As pastas no disco ficam.
          </p>
          <Show when={needsTyping()}>
            <p class="mt-1.5 text-[11.5px] leading-snug text-alert">
              {liveCount()} rodando agora. Digite o nome do projeto para liberar.
            </p>
            <input
              class="mt-1.5 w-full rounded-md border border-line bg-raised px-2 py-1 text-[12px] text-ink outline-none transition focus:border-alert/60"
              placeholder={p().name}
              value={typed()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(e) => setTyped(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void runDelete();
                }
              }}
            />
          </Show>
          <Show when={deleteError()}>
            <p class="mt-1 text-[11.5px] leading-snug text-alert">{deleteError()}</p>
          </Show>
          <div class="mt-2 flex items-center gap-1.5">
            <button
              class="rounded-md border border-alert/40 px-2 py-1 text-[12px] font-medium text-alert transition hover:bg-alert-soft disabled:cursor-not-allowed disabled:opacity-35"
              disabled={!armed() || deleting()}
              onClick={() => void runDelete()}
            >
              {deleting() ? "Excluindo…" : "Excluir projeto"}
            </button>
            <button
              class="rounded-md px-2 py-1 text-[12px] text-dim transition hover:bg-fill-2 hover:text-ink"
              onClick={() => setConfirming(false)}
            >
              Cancelar
            </button>
          </div>
        </div>
      </Show>

      <Show when={!props.collapsed}>
        <ul class="space-y-px">
          <For each={p().runners}>
            {(r) => <SessionRow project={p()} runner={r} />}
          </For>
          <Show when={p().runners.length === 0}>
            <li>
              <button
                class="ml-6 rounded-md px-2 py-1 text-[12px] text-faint transition hover:bg-fill-1 hover:text-dim"
                onClick={() => void newSession(p().id)}
              >
                Começar uma sessão
              </button>
            </li>
          </Show>
        </ul>
      </Show>
    </li>
  );
}

/* --------------------------------- session ------------------------------- */

function SessionRow(props: {
  project: ProjectUI;
  runner: RunnerUI;
  /** Rows in "Precisa de você" are out of their group, so they name it. */
  showProject?: boolean;
}) {
  const r = () => props.runner;
  const selected = () => focusedRunner()?.id === r().id;
  const glyph = () => glyphFor(r());
  const editKey = () => `runner:${r().id}${props.showProject ? ":attn" : ""}`;
  const isDropTarget = () =>
    !props.showProject &&
    drag()?.kind === "runner" &&
    drag()?.projectId === props.project.id &&
    dropBefore() === r().id;

  const secondLine = () => {
    if (props.showProject) return props.project.name;
    if (glyph() === "awaiting") return "Esperando sua resposta";
    if (glyph() === "working") return r().activity || "Trabalhando";
    return "";
  };

  function menu(): MenuItem[] {
    const isAgent = r().kind === "agent";
    return [
      { label: "Renomear", icon: Pencil, onSelect: () => startInlineEdit(editKey()) },
      ...(isAgent && r().sessionId
        ? [
            {
              label: r().mode === "chat" ? "Abrir como terminal" : "Abrir como chat",
              icon: r().mode === "chat" ? SquareTerminal : MessageSquare,
              onSelect: () => void setRunnerMode(r().id, r().mode === "chat" ? "tty" : "chat"),
            } satisfies MenuItem,
          ]
        : []),
      {
        label: "Reiniciar",
        icon: RotateCcw,
        onSelect: () => void restartRunner(r().id),
      },
      {
        label: "Parar",
        icon: Power,
        disabled: !r().live,
        onSelect: () => void stopRunner(r().id),
      },
      {
        label: isAgent ? "Excluir sessão" : "Excluir terminal",
        icon: Trash2,
        danger: true,
        separatorBefore: true,
        onSelect: () => void deleteRunner(r().id),
      },
    ];
  }

  return (
    <li
      classList={{
        "cx-dragging": drag()?.kind === "runner" && drag()?.id === r().id,
        "cx-drop-before": isDropTarget(),
      }}
      draggable={!props.showProject}
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
        if (props.showProject || d?.kind !== "runner" || d.projectId !== props.project.id) return;
        e.preventDefault();
        e.stopPropagation();
        setDropBefore(r().id);
      }}
      onDrop={(e) => {
        const d = drag();
        if (props.showProject || d?.kind !== "runner" || d.projectId !== props.project.id) return;
        e.preventDefault();
        e.stopPropagation();
        moveRunner(props.project.id, d.id, r().id);
        endDrag();
      }}
    >
      <button
        class="group flex w-full items-start gap-2 rounded-cx py-[6px] pl-[9px] pr-2 text-left transition"
        classList={{
          "bg-fill-3": selected(),
          "hover:bg-fill-1": !selected(),
        }}
        onClick={() => focusRunner(props.project.id, r().id)}
        onContextMenu={(e) => openMenu(e, menu())}
      >
        <span class="flex h-[18px] w-[14px] shrink-0 items-center justify-center">
          <StatusGlyph glyph={glyph()} />
        </span>
        <span class="min-w-0 flex-1">
          <span class="flex items-baseline gap-2">
            <span
              class="min-w-0 flex-1 truncate text-[12.5px] leading-[18px]"
              classList={{
                "text-ink": selected() || r().live || r().unread,
                "font-medium": r().unread || glyph() === "awaiting",
                "text-dim": !selected() && !r().live && !r().unread,
              }}
            >
              <InlineEdit
                editKey={editKey()}
                value={r().name}
                onCommit={(next) => {
                  const trimmed = next.trim();
                  if (!trimmed || trimmed === r().name) return;
                  renameSession(r().id, trimmed).catch(console.error);
                }}
              >
                {(name) => <span class="truncate">{name}</span>}
              </InlineEdit>
            </span>
            <Show when={r().kind === "agent" && r().mode === "tty"}>
              <span class="shrink-0 font-mono text-[10px] text-faint" title="Rodando como terminal">
                tty
              </span>
            </Show>
            <Show when={!secondLine() && r().kind === "agent"}>
              <span class="shrink-0 text-[11px] tabular-nums text-faint">
                {relativeTime(r().lastActive)}
              </span>
            </Show>
          </span>
          <Show when={secondLine()}>
            <span
              class="block truncate text-[11.5px] leading-[16px]"
              classList={{
                "text-busy": glyph() === "awaiting" && !props.showProject,
                "text-faint": glyph() !== "awaiting" || props.showProject,
              }}
            >
              {secondLine()}
            </span>
          </Show>
        </span>
      </button>
    </li>
  );
}

/* --------------------------------- footer -------------------------------- */

function Footer() {
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
    <div class="flex items-center gap-0.5 border-t border-line px-2 py-1.5">
      <button
        class="cx-icon-btn"
        onClick={() => setSettingsOpen(true)}
        title="Configurações (⌘,)"
      >
        <Settings2 size={14} />
      </button>
      <button
        class="cx-icon-btn"
        onClick={cycleTheme}
        title={themeSpec().mode === "dark" ? "Mudar para tema claro (⌘⇧T)" : "Mudar para tema escuro (⌘⇧T)"}
      >
        {themeSpec().mode === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <Show when={link()}>
        <button
          class="ml-auto flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-faint transition hover:bg-fill-1 hover:text-dim"
          title={link()!}
          onClick={() => {
            navigator.clipboard.writeText(link()!).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          <Globe size={12} class={online() ? "text-live" : ""} />
          <span class="truncate">
            {copied() ? "Link copiado" : online() ? "Acesso remoto" : "Acesso local"}
          </span>
        </button>
      </Show>
    </div>
  );
}

function ResizeHandle() {
  function onMouseDown(e: MouseEvent) {
    e.preventDefault();
    const move = (ev: MouseEvent) => setSidebarWidthPx(ev.clientX);
    const up = () => {
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
