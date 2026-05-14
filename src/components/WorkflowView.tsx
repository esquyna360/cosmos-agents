import { For, Show } from "solid-js";

import {
  focusRunner,
  projectsStore,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import { setView, setWorkflowOpen } from "../stores/layout";
import ProjectCard from "./ProjectCard";

const URGENCY: Record<string, number> = {
  awaiting_input: 4,
  error: 3,
  streaming: 2,
  tool_running: 2,
  idle: 1,
  running: 1,
  exited: 0,
};

function sortProjects(list: ProjectUI[]): ProjectUI[] {
  return [...list].sort(
    (a, b) => URGENCY[b.promotedStatus] - URGENCY[a.promotedStatus],
  );
}

export default function WorkflowView() {
  function onPick(p: ProjectUI, r: RunnerUI) {
    focusRunner(p.id, r.id);
    setView("runners");
    setWorkflowOpen(false);
  }
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-[#0b0d10] p-4">
      <div class="mb-4 flex items-center justify-between">
        <div>
          <h1 class="text-base font-medium text-white/90">workflow</h1>
          <p class="text-[11px] text-white/40">
            projects and runners · ⌘D or Esc to close
          </p>
        </div>
        <button
          class="rounded border border-white/10 px-2 py-1 text-[12px] text-white/60 hover:bg-white/5 hover:text-white"
          onClick={() => setWorkflowOpen(false)}
        >
          close
        </button>
      </div>
      <Show
        when={projectsStore.list.length > 0}
        fallback={
          <div class="flex flex-1 items-center justify-center text-white/30">
            no projects — ⌘T to spawn
          </div>
        }
      >
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <For each={sortProjects(projectsStore.list)}>
            {(p) => <ProjectCard project={p} onPick={onPick} />}
          </For>
        </div>
      </Show>
    </div>
  );
}
