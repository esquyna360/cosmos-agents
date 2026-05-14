import { For, Show } from "solid-js";
import {
  Diff,
  FileText,
  Layers,
  Notebook,
  Settings2,
  TerminalSquare,
  X,
} from "lucide-solid";

import { closeProject, updateProject, type ProjectUI } from "../stores/projects";
import { openCreator } from "../stores/creator";
import { setView, view, type ViewMode } from "../stores/layout";
import { colorForPath } from "../lib/colorHash";
import InlineEdit from "./InlineEdit";

function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

interface Props {
  project: ProjectUI;
}

// View pills next to project name. Clicking the active one returns to
// runners (the default). Memory is wired but disabled visually until Step 4.
const VIEW_PILLS: {
  id: ViewMode;
  label: string;
  icon: typeof FileText;
  hint: string;
}[] = [
  { id: "runners", label: "runners", icon: TerminalSquare, hint: "agents + shells" },
  { id: "editor", label: "editor", icon: FileText, hint: "⌘E to cycle" },
  { id: "diff", label: "diff", icon: Diff, hint: "" },
  { id: "memory", label: "memory", icon: Notebook, hint: "cards · context · CLAUDE.md flow" },
];

export default function ProjectTitleBar(props: Props) {
  const p = () => props.project;
  const isMulti = () => p().folders.length > 1;
  const folderHint = () => {
    if (isMulti()) return null;
    const folder = basename(p().cwd);
    return p().name !== folder ? folder : null;
  };

  function selectView(id: ViewMode) {
    setView(id);
  }

  return (
    <div class="flex shrink-0 items-center gap-2 border-b border-white/5 bg-[#0b0d10] px-4 py-2">
      {/* Color chip — same hash the sidebar/tabs use, ties them visually. */}
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        style={{ "background-color": colorForPath(p().cwd) }}
      />
      <Show when={isMulti()}>
        <Layers size={12} class="shrink-0 text-white/45" />
      </Show>
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-white/90">
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
            <span
              class="flex min-w-0 items-baseline gap-2 truncate"
              title={`slug: ${p().slug} — renaming changes the label, not the folder path`}
            >
              <span class="truncate">{name}</span>
              <Show when={folderHint()}>
                <span class="shrink-0 text-[11px] font-normal text-white/35">
                  {folderHint()}
                </span>
              </Show>
              <Show when={isMulti()}>
                <span class="shrink-0 text-[11px] font-normal text-white/35">
                  {p().folders.length} folders
                </span>
              </Show>
            </span>
          )}
        </InlineEdit>
      </span>
      <Show when={p().runners.length > 0}>
        <span class="shrink-0 text-[10px] tabular-nums text-white/40">
          {p().runners.length} runner{p().runners.length === 1 ? "" : "s"}
        </span>
      </Show>

      {/* View toggles — pill-shaped, one always active. Runners is default
          and the only one that shows the runner-tabs strip below the title. */}
      <div class="ml-1 inline-flex shrink-0 items-center gap-0.5 rounded-md border border-white/10 bg-white/[0.03] p-0.5">
        <For each={VIEW_PILLS}>
          {(pill) => {
            const isActive = () => view() === pill.id;
            return (
              <button
                class="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/55 transition hover:bg-white/5 hover:text-white"
                classList={{ "!bg-white/15 !text-white": isActive() }}
                onClick={() => selectView(pill.id)}
                title={`${pill.label}${pill.hint ? ` (${pill.hint})` : ""}`}
              >
                <pill.icon size={11} />
                <span>{pill.label}</span>
              </button>
            );
          }}
        </For>
      </div>

      <button
        class="shrink-0 rounded p-1.5 text-white/50 hover:bg-white/10 hover:text-white"
        onClick={() => openCreator({ mode: "project", editingProjectId: p().id })}
        title="edit project (folders, memory)"
      >
        <Settings2 size={13} />
      </button>
      <button
        class="shrink-0 rounded p-1.5 text-white/40 hover:bg-white/10 hover:text-white/90"
        onClick={() => closeProject(p().id).catch(console.error)}
        title="close project (⌘⇧W)"
      >
        <X size={13} />
      </button>
    </div>
  );
}
