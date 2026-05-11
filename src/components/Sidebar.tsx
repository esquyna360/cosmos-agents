import { For, Show } from "solid-js";

import { agents, closeAgent, focus, focusedAgentId, pickAndCreate } from "../stores/agents";
import { colorForPath } from "../lib/colorHash";
import StatusDot from "./StatusDot";

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
          title="Cmd+T — new agent"
        >
          +
        </button>
      </div>
      <ul class="min-h-0 flex-1 overflow-y-auto px-2">
        <For each={agents.list}>
          {(a, i) => {
            const isFocused = () => focusedAgentId() === a.id;
            // Tooltip = working dir + (CLAUDE.md head if present)
            const tooltip = () => {
              const lines = [a.cwd, ""];
              if (a.claudeMd) {
                lines.push(a.claudeMd.split("\n").slice(0, 8).join("\n").slice(0, 400));
              }
              return lines.join("\n").trim();
            };
            return (
              <li
                class="group flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-white/5"
                classList={{ "bg-white/10": isFocused() }}
              >
                <button
                  class="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => focus(a.id)}
                  title={tooltip()}
                >
                  <StatusDot
                    color={colorForPath(a.cwd)}
                    status={a.status}
                    live={a.live}
                  />
                  <span class="min-w-0 flex-1 truncate">{a.name}</span>
                  <Show when={a.stacks.length > 0}>
                    <span class="flex shrink-0 gap-0.5">
                      <For each={a.stacks.slice(0, 3)}>
                        {(s) => (
                          <span
                            class="rounded px-1 text-[9px] font-medium leading-4 text-white"
                            style={{ "background-color": s.color, opacity: 0.85 }}
                          >
                            {s.label}
                          </span>
                        )}
                      </For>
                    </span>
                  </Show>
                  <Show when={a.claudeMd}>
                    <span
                      class="shrink-0 text-[10px] text-white/35"
                      title="has .claude/CLAUDE.md"
                    >
                      ⚑
                    </span>
                  </Show>
                  <span class="hidden shrink-0 text-[10px] text-white/30 group-hover:inline">
                    ⌘{i() + 1}
                  </span>
                </button>
                <button
                  class="hidden shrink-0 text-white/40 hover:text-white/80 group-hover:inline"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeAgent(a.id);
                  }}
                  title="close"
                >
                  ×
                </button>
              </li>
            );
          }}
        </For>
      </ul>
      <div class="border-t border-white/5 px-3 py-2 text-[10px] leading-relaxed text-white/30">
        ⌘T new · ⌘W close · ⌘E swap view<br />
        ⌘P find file · ⌘⇧F search · ⌘1–9 focus
      </div>
    </aside>
  );
}
