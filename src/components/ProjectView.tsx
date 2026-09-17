import { createSignal, For, Show } from "solid-js";
import { Code, Copy, Ellipsis, FolderOpen, GitBranch, Plus, SquareTerminal } from "lucide-solid";

import {
  isStale,
  masterRunner,
  newTerminal,
  openFileInEditor,
  updateProject,
  workFolder,
  type ProjectUI,
} from "../stores/projects";
import { gitOf } from "../stores/git";
import { openCreator } from "../stores/creator";
import { projectTab, setProjectTab, type ProjectTab } from "../stores/nav";
import { openPath } from "../lib/projects";
import { shortPath } from "../lib/toolDisplay";
import { openMenu } from "../ui/Menu";
import InlineEdit from "./InlineEdit";
import { projectMenu } from "./menus";
import { AgentCard, ShellCard } from "./RunnerCard";
import FileTree from "./FileTree";
import Editor from "./Editor";
import DiffView from "./DiffView";
import MemoryView from "./MemoryView";
import Browser from "./Browser";

const TABS: [ProjectTab, string][] = [
  ["overview", "Visão geral"],
  ["files", "Arquivos"],
  ["diff", "Mudanças"],
  ["memory", "Memória"],
  ["browser", "Navegador"],
];

export default function ProjectView(props: { project: ProjectUI }) {
  const p = () => props.project;
  const folder = () => workFolder(p());
  const git = () => gitOf(folder());
  const editKey = () => `project:${p().id}`;
  const [copied, setCopied] = createSignal(false);

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header class="flex shrink-0 flex-col gap-2.5 border-b border-line px-6 pb-2 pt-4">
        <div class="flex items-start gap-4">
          <div class="min-w-0 flex-1">
            <h1 class="font-heading truncate text-[24px] leading-tight text-ink">
              <InlineEdit
                value={p().name}
                editKey={editKey()}
                onCommit={(next) => {
                  const t = next.trim();
                  if (t && t !== p().name) updateProject(p().id, t, p().folders, p().memory).catch(console.error);
                }}
              >
                {(name) => <span>{name}</span>}
              </InlineEdit>
            </h1>
            <p class="mt-1 flex min-w-0 items-center gap-2.5 font-mono text-[11.5px] text-faint">
              <span class="truncate" title={folder()}>{shortPath(folder(), [])}</span>
              <Show when={git()?.branch}>
                <span class="flex shrink-0 items-center gap-1 text-dim">
                  <GitBranch size={11} />
                  {git()!.branch}
                </span>
              </Show>
              <Show when={(git()?.worktrees ?? 0) > 0}>
                <span class="shrink-0">
                  {git()!.worktrees} {git()!.worktrees === 1 ? "worktree" : "worktrees"}
                </span>
              </Show>
              <Show when={p().folders.length > 1}>
                <span class="shrink-0">+{p().folders.length - 1} pastas</span>
              </Show>
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button class="cx-pill cx-pill-line" onClick={() => openPath(folder()).catch(console.error)}>
              <FolderOpen size={12} />
              Finder
            </button>
            <button
              class="cx-pill cx-pill-line"
              onClick={() => openPath(folder(), "Visual Studio Code").catch(console.error)}
            >
              <Code size={12} />
              VS Code
            </button>
            <button class="cx-pill cx-pill-line" onClick={() => void newTerminal(p().id)}>
              <SquareTerminal size={12} />
              Terminal
            </button>
            <button
              class="cx-pill cx-pill-line"
              onClick={() =>
                navigator.clipboard.writeText(folder()).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              <Copy size={12} />
              {copied() ? "Copiado" : "Copiar caminho"}
            </button>
            <button
              class="cx-icon-btn"
              aria-label="Mais ações do projeto"
              onClick={(e) => openMenu(e.currentTarget, projectMenu(p(), editKey()))}
            >
              <Ellipsis size={15} />
            </button>
          </div>
        </div>
        <nav class="-ml-2 flex items-center gap-0.5">
          <For each={TABS}>
            {([id, label]) => (
              <button class="cx-pill" data-on={projectTab() === id} onClick={() => setProjectTab(id)}>
                {label}
              </button>
            )}
          </For>
        </nav>
      </header>

      <Show when={projectTab() === "overview"}>
        <Overview project={p()} />
      </Show>
      <Show when={projectTab() === "files"}>
        <Editor roots={p().folders} />
      </Show>
      <Show when={projectTab() === "diff"}>
        <DiffView roots={p().folders} />
      </Show>
      <Show when={projectTab() === "memory"}>
        <MemoryView project={p()} />
      </Show>
      <Show when={projectTab() === "browser"}>
        <Browser projectId={p().id} />
      </Show>
    </div>
  );
}

function Overview(props: { project: ProjectUI }) {
  const p = () => props.project;
  const [showStale, setShowStale] = createSignal(false);
  const mine = () => p().runners.filter((r) => r.id !== masterRunner()?.id);
  const agents = () => mine().filter((r) => r.kind === "agent" && (showStale() || !isStale(r)));
  const shells = () => mine().filter((r) => r.kind === "shell" && (showStale() || !isStale(r)));
  const staleCount = () => mine().filter(isStale).length;

  return (
    <div class="flex min-h-0 flex-1">
      <div class="min-w-0 flex-1 overflow-y-auto px-6 pb-10 pt-5">
        <div class="flex max-w-[980px] flex-col gap-7">
          <section class="flex flex-col gap-2.5">
            <h2 class="font-heading text-[16px] text-ink">Agentes</h2>
            <div class="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
              <For each={agents()}>{(r) => <AgentCard project={p()} runner={r} />}</For>
              <button
                class="flex min-h-[92px] items-center justify-center gap-1.5 rounded-cx-lg border border-dashed border-line-strong text-[12.5px] text-faint transition hover:border-accent hover:text-accent"
                onClick={() => openCreator({ mode: "agent", projectId: p().id })}
              >
                <Plus size={13} />
                Agente
              </button>
            </div>
          </section>

          <section class="flex flex-col gap-2.5">
            <h2 class="font-heading text-[16px] text-ink">Terminais</h2>
            <div class="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
              <For each={shells()}>{(r) => <ShellCard project={p()} runner={r} />}</For>
              <button
                class="flex h-[34px] items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-line-strong text-[12px] text-faint transition hover:border-accent hover:text-accent"
                onClick={() => void newTerminal(p().id)}
              >
                <Plus size={12} />
                Terminal
              </button>
            </div>
          </section>

          <Show when={staleCount() > 0}>
            <button
              class="self-start text-[11.5px] text-faint transition hover:text-dim"
              onClick={() => setShowStale(!showStale())}
            >
              {showStale() ? "Esconder parados" : `+${staleCount()} parados há dias`}
            </button>
          </Show>
        </div>
      </div>
      <aside class="flex w-[300px] shrink-0 flex-col border-l border-line bg-panel max-[900px]:hidden">
        <h2 class="shrink-0 px-4 pb-1 pt-4 text-[12px] text-dim">Arquivos</h2>
        <div class="min-h-0 flex-1 overflow-y-auto px-1.5">
          <FileTree roots={p().folders} onOpenFile={openFileInEditor} selectedPath={null} />
        </div>
      </aside>
    </div>
  );
}
