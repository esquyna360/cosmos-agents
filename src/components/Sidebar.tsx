import { For, Show } from "solid-js";

import {
  agents,
  closeAgent,
  createSiblingAgent,
  focus,
  focusedAgentId,
  pickAndCreate,
  projects,
  toggleProjectCollapsed,
} from "../stores/agents";
import AgentRow from "./AgentRow";
import ProjectHeader from "./ProjectHeader";

/**
 * Builds an index map so ⌘1..9 still reflects the user's flat sidebar order
 * (project headers don't consume an index; children are indexed sequentially).
 */
function flatIndex(agentId: string): number {
  return agents.list.findIndex((a) => a.id === agentId);
}

export default function Sidebar() {
  return (
    <aside class="flex h-full w-56 shrink-0 flex-col border-r border-white/5 bg-[#0a0c0f]">
      <div class="flex items-center justify-between px-3 pb-2 pt-2">
        <span class="text-[11px] font-medium uppercase tracking-wider text-white/40">
          agents
        </span>
        <button
          class="rounded px-2 py-0.5 text-sm text-white/60 hover:bg-white/10 hover:text-white"
          onClick={pickAndCreate}
          title="⌘T — new agent"
        >
          +
        </button>
      </div>
      <ul class="min-h-0 flex-1 overflow-y-auto px-2">
        <For each={projects()}>
          {(p) => (
            <Show
              when={p.agents.length > 1}
              fallback={
                <AgentRow
                  agent={p.agents[0]}
                  isFocused={focusedAgentId() === p.agents[0].id}
                  indexHint={flatIndex(p.agents[0].id)}
                  showStacks
                  onFocus={() => focus(p.agents[0].id)}
                  onClose={() => closeAgent(p.agents[0].id)}
                />
              }
            >
              <ProjectHeader
                project={p}
                onToggle={() => toggleProjectCollapsed(p.cwd)}
                onSpawnSibling={() => createSiblingAgent(p.cwd).catch(console.error)}
              />
              <Show when={!p.collapsed}>
                <li class="relative">
                  <span
                    class="pointer-events-none absolute left-[14px] top-0 h-full w-px bg-white/15"
                    aria-hidden
                  />
                  <ul>
                    <For each={p.agents}>
                      {(a) => (
                        <AgentRow
                          agent={a}
                          isFocused={focusedAgentId() === a.id}
                          indexHint={flatIndex(a.id)}
                          indent={16}
                          showStacks={false}
                          onFocus={() => focus(a.id)}
                          onClose={() => closeAgent(a.id)}
                        />
                      )}
                    </For>
                  </ul>
                </li>
              </Show>
            </Show>
          )}
        </For>
      </ul>
      <div class="border-t border-white/5 px-3 py-2 text-[10px] leading-relaxed text-white/30">
        ⌘T new · ⌘W close · ⌘E view · ⌘I composer<br />
        ⌘P file · ⌘⇧F search · ⌘D workflow · ⌘1–9 focus
      </div>
    </aside>
  );
}
