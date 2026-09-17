import { Show } from "solid-js";
import { GitBranch, SquareTerminal } from "lucide-solid";

import { focusRunner, type ProjectUI, type RunnerUI } from "../stores/projects";
import { branchOf } from "../stores/git";
import { relativeTime } from "../lib/time";
import { shortPath } from "../lib/toolDisplay";
import { glyphFor, stateOf, TONE_TEXT } from "../ui/StatusGlyph";
import { RunnerIcon } from "../ui/EntityIcon";
import { openMenu } from "../ui/Menu";
import { runnerMenu } from "./menus";

interface Props {
  project: ProjectUI;
  runner: RunnerUI;
}

/** An agent is a paper card: a name, what it is on, how it is doing. */
export function AgentCard(props: Props) {
  const r = () => props.runner;
  const state = () => stateOf(r());
  const branch = () => branchOf(props.project, r());
  const line = () => r().activity || r().task || "Sem tarefa ainda";
  const attention = () => glyphFor(r()) === "awaiting" || glyphFor(r()) === "error";

  return (
    <button
      class="cx-card group flex min-h-[92px] flex-col gap-1.5 px-3.5 py-3 text-left transition hover:border-line-strong"
      classList={{ "!border-busy": attention() }}
      onClick={() => focusRunner(props.project.id, r().id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, runnerMenu(props.project, r()));
      }}
    >
      <span class="flex items-start gap-2">
        <RunnerIcon runner={r()} size={16} ring="var(--card, var(--panel))" />
        <span class="font-heading line-clamp-2 min-w-0 text-[15px] leading-[1.2] text-ink">{r().name}</span>
      </span>
      <span
        class="line-clamp-2 text-[12px] leading-snug"
        classList={{ "text-dim": Boolean(r().activity || r().task), "text-faint": !(r().activity || r().task) }}
      >
        {line()}
      </span>
      <span class="mt-auto flex items-center gap-1.5 pt-1 text-[11.5px]">
        <span class={TONE_TEXT[state().tone]}>{state().label}</span>
        <Show when={r().cwd && branch()}>
          <span class="ml-auto flex min-w-0 items-center gap-1 text-faint" title="Worktree própria">
            <GitBranch size={11} class="shrink-0" />
            <span class="truncate font-mono text-[11px]">{branch()}</span>
          </span>
        </Show>
        <Show when={!(r().cwd && branch())}>
          <span class="ml-auto text-faint">{relativeTime(r().lastActive)}</span>
        </Show>
      </span>
    </button>
  );
}

/** A terminal is a dark slab in mono, so it is never mistaken for an agent. */
export function ShellCard(props: Props) {
  const r = () => props.runner;
  return (
    <button
      class="group flex h-[34px] items-center gap-2 rounded-[10px] bg-well px-3 text-left font-mono text-[12px] transition hover:brightness-125"
      onClick={() => focusRunner(props.project.id, r().id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, runnerMenu(props.project, r()));
      }}
    >
      <SquareTerminal size={13} stroke-width={1.7} class={r().live ? "text-[#a9bb8a]" : "text-[#7f776b]"} />
      <span class="min-w-0 flex-1 truncate text-[#f0e6d5]">{r().name}</span>
      <span class="max-w-[45%] truncate text-[11px] text-[#7f776b]">
        {shortPath(r().cwd || props.project.folders[0] || "", [])}
      </span>
    </button>
  );
}
