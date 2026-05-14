import { For, Show } from "solid-js";
import { Settings2, X } from "lucide-solid";

import {
  closeProject,
  focusProject,
  focusedProjectId,
  projectsStore,
  type ProjectUI,
} from "../stores/projects";
import { openCreator } from "../stores/creator";
import { sidebarWidthPx, setSidebarWidthPx } from "../stores/layout";
import { colorForPath } from "../lib/colorHash";
import StatusDot from "./StatusDot";
import InlineEdit from "./InlineEdit";
import { updateProject } from "../stores/projects";

function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

export default function Sidebar() {
  return (
    <aside
      class="relative flex h-full shrink-0 flex-col border-r border-white/5 bg-[#0a0c0f]"
      style={{ width: `${sidebarWidthPx()}px` }}
    >
      <div class="flex items-center justify-between px-3 pb-1 pt-3">
        <span class="text-[10px] font-medium uppercase tracking-wider text-white/45">
          projects
        </span>
        <button
          class="flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[11px] text-white/70 hover:border-white/25 hover:bg-white/10 hover:text-white"
          onClick={() => openCreator({ mode: "project" })}
          title="new project (⌘T)"
        >
          <span class="leading-none">+</span>
          <span>new</span>
        </button>
      </div>
      <ul class="min-h-0 flex-1 overflow-y-auto px-2 pt-1">
        <For each={projectsStore.list}>
          {(p) => <ProjectRow project={p} />}
        </For>
      </ul>
      <div class="border-t border-white/5 px-3 py-2 text-[10px] leading-relaxed text-white/30">
        ⌘T new · ⌘⇧N agent · ⌘W close runner · ⌘⇧W close project<br />
        ⌘E view · ⌘I composer · ⌘D workflow<br />
        ⌘\ pin · ⌘P file · ⌘⇧F search · ⌘1–9 focus
      </div>
      <ResizeHandle />
    </aside>
  );
}

function ProjectRow(props: { project: ProjectUI }) {
  const p = props.project;
  const isActive = () => focusedProjectId() === p.id;
  const isMulti = () => p.folders.length > 1;
  const folderHint = () => {
    if (isMulti()) return null;
    const folder = basename(p.cwd);
    return p.name !== folder ? folder : null;
  };
  const tooltip = () => {
    const lines = [p.cwd];
    if (isMulti()) {
      lines.push("");
      lines.push("folders:");
      for (const f of p.folders) lines.push(`  ${f}`);
    }
    if (p.runners.length > 0) {
      lines.push("");
      lines.push("runners:");
      for (const r of p.runners) lines.push(`  ${r.kind} · ${r.name}`);
    }
    return lines.join("\n");
  };
  return (
    <li
      class="group flex items-center gap-1.5 rounded px-2 py-1.5 text-sm hover:bg-white/5"
      classList={{ "bg-white/10": isActive() }}
    >
      <button
        class="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={() => focusProject(p.id)}
        title={tooltip()}
      >
        <StatusDot
          color={colorForPath(p.cwd)}
          status={p.promotedStatus}
          live={p.promotedLive}
        />
        <span class="min-w-0 flex-1 truncate">
          <InlineEdit
            value={p.name}
            onCommit={(next) => {
              const trimmed = next.trim();
              if (!trimmed || trimmed === p.name) return;
              updateProject(p.id, trimmed, p.folders, p.memory).catch(console.error);
            }}
          >
            {(name) => (
              <span class="flex min-w-0 items-baseline gap-1.5 truncate">
                <span class="truncate font-medium">{name}</span>
                <Show when={folderHint()}>
                  <span class="shrink-0 truncate text-[10px] font-normal text-white/30">
                    {folderHint()}
                  </span>
                </Show>
              </span>
            )}
          </InlineEdit>
        </span>
        <Show when={p.runners.length > 0}>
          <span class="shrink-0 text-[10px] tabular-nums text-white/35">
            {p.runners.length}
          </span>
        </Show>
      </button>
      <button
        class="hidden shrink-0 rounded p-1 text-white/35 hover:bg-white/10 hover:text-white group-hover:inline-flex"
        onClick={(e) => {
          e.stopPropagation();
          openCreator({ mode: "project", editingProjectId: p.id });
        }}
        title="edit project"
      >
        <Settings2 size={11} />
      </button>
      <button
        class="hidden shrink-0 rounded p-1 text-white/35 hover:bg-white/10 hover:text-white/90 group-hover:inline-flex"
        onClick={(e) => {
          e.stopPropagation();
          closeProject(p.id).catch(console.error);
        }}
        title="close project (⌘⇧W)"
      >
        <X size={11} />
      </button>
    </li>
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
      class="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-transparent transition hover:bg-white/15"
      onMouseDown={onMouseDown}
      title="drag to resize"
    />
  );
}
