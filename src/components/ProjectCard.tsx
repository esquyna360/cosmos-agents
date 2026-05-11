import { For, Show } from "solid-js";

import type { ProjectView, AgentUI } from "../stores/agents";
import { colorForPath } from "../lib/colorHash";
import StatusDot from "./StatusDot";
import { agentDisplayName } from "../stores/agents";

interface Props {
  project: ProjectView;
  onPick: (agent: AgentUI) => void;
}

export default function ProjectCard(props: Props) {
  const wide = () => props.project.agents.length > 1;
  return (
    <article
      class="flex flex-col rounded-lg border border-white/8 bg-[#0e1116] p-3 transition hover:border-white/20"
      classList={{ "md:col-span-2": wide() }}
    >
      <header class="mb-3 flex items-center gap-2">
        <StatusDot
          color={colorForPath(props.project.cwd)}
          status={props.project.promotedStatus}
          live={props.project.promotedLive}
        />
        <span class="min-w-0 flex-1 truncate text-sm font-medium text-white/90">
          {props.project.displayName}
        </span>
        <Show when={props.project.stacks.length > 0}>
          <span class="flex shrink-0 gap-0.5">
            {props.project.stacks.slice(0, 3).map((s) => (
              <span
                class="rounded px-1 text-[9px] font-medium leading-4 text-white"
                style={{ "background-color": s.color, opacity: 0.85 }}
              >
                {s.label}
              </span>
            ))}
          </span>
        </Show>
        <span class="text-[10px] tabular-nums text-white/35">
          {props.project.agents.length} agent{props.project.agents.length === 1 ? "" : "s"}
        </span>
      </header>
      <ul
        class="grid gap-1.5"
        classList={{ "grid-cols-2": wide(), "grid-cols-1": !wide() }}
      >
        <For each={sortByUrgency(props.project.agents)}>
          {(a) => (
            <li>
              <button
                class="flex w-full items-start gap-2 rounded border border-transparent bg-white/[0.02] px-2 py-1.5 text-left text-[12px] hover:border-white/15 hover:bg-white/[0.05]"
                onClick={() => props.onPick(a)}
              >
                <span class="mt-1 shrink-0">
                  <StatusDot
                    color={colorForPath(a.cwd)}
                    status={a.status}
                    live={a.live}
                  />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-white/90">{agentDisplayName(a)}</span>
                  <span class="block truncate text-[10px] text-white/40">
                    {statusLabel(a.status)} · {formatAge(a.lastActive)}
                  </span>
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </article>
  );
}

const URGENCY = { awaiting_input: 4, error: 3, streaming: 2, tool_running: 2, idle: 1 } as const;

function sortByUrgency(list: AgentUI[]): AgentUI[] {
  return [...list].sort(
    (a, b) =>
      URGENCY[b.status] - URGENCY[a.status] ||
      (b.lastActive ?? 0) - (a.lastActive ?? 0),
  );
}

function statusLabel(s: string): string {
  switch (s) {
    case "awaiting_input":
      return "needs you";
    case "streaming":
      return "working";
    case "tool_running":
      return "tool running";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function formatAge(unix: number): string {
  if (!unix) return "—";
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h`;
  return `${Math.floor(ageSec / 86400)}d`;
}
