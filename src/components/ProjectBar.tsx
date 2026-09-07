import { For, Show } from "solid-js";
import {
  Diff,
  FileText,
  Globe,
  Notebook,
  Power,
  Settings2,
  TerminalSquare,
} from "lucide-solid";

import { sleepProject, type ProjectUI } from "../stores/projects";
import { openCreator } from "../stores/creator";
import { setView, view, type ViewMode } from "../stores/layout";

const VIEW_PILLS: {
  id: ViewMode;
  label: string;
  icon: typeof FileText;
  hint: string;
}[] = [
  { id: "runners", label: "runners", icon: TerminalSquare, hint: "agentes + shells" },
  { id: "editor", label: "editor", icon: FileText, hint: "⌘E cicla" },
  { id: "diff", label: "diff", icon: Diff, hint: "git diff" },
  { id: "memory", label: "memória", icon: Notebook, hint: "cards que entram no CLAUDE.md" },
  { id: "browser", label: "browser", icon: Globe, hint: "preview do dev server" },
];

interface Props {
  project: ProjectUI;
}

export default function ProjectBar(props: Props) {
  const p = () => props.project;
  const liveCount = () => p().runners.filter((r) => r.live).length;

  return (
    <div class="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-2.5 py-1.5">
      <div class="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-fill-1 p-0.5">
        <For each={VIEW_PILLS}>
          {(pill) => {
            const isActive = () => view() === pill.id;
            return (
              <button
                class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] text-faint transition hover:bg-fill-2 hover:text-ink"
                classList={{ "bg-fill-3 text-ink": isActive() }}
                onClick={() => setView(pill.id)}
                title={`${pill.label} — ${pill.hint}`}
              >
                <pill.icon size={11} />
                <span>{pill.label}</span>
              </button>
            );
          }}
        </For>
      </div>

      <span class="ml-auto shrink-0 text-[11px] tabular-nums text-faint">
        <Show
          when={p().runners.length > 0}
          fallback={<span>sem runners</span>}
        >
          {liveCount()}/{p().runners.length} ativo
          {liveCount() === 1 ? "" : "s"}
        </Show>
      </span>

      <button
        class="shrink-0 rounded-md p-1.5 text-faint transition hover:bg-fill-2 hover:text-ink"
        onClick={() => openCreator({ mode: "project", editingProjectId: p().id })}
        title="editar projeto (pastas, memória, excluir)"
      >
        <Settings2 size={13} />
      </button>
      <button
        class="shrink-0 rounded-md p-1.5 text-faint transition hover:bg-fill-2 hover:text-ink"
        onClick={() => sleepProject(p().id).catch(console.error)}
        title="parar todos os runners (⌘⇧W) — nada é apagado"
      >
        <Power size={13} />
      </button>
    </div>
  );
}
