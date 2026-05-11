import { Show } from "solid-js";

import type { ProjectView } from "../stores/agents";
import { renameProject } from "../stores/agents";
import { colorForPath } from "../lib/colorHash";
import StatusDot from "./StatusDot";
import InlineEdit from "./InlineEdit";

interface Props {
  project: ProjectView;
  onToggle: () => void;
  onSpawnSibling: () => void;
}

export default function ProjectHeader(props: Props) {
  const tooltip = () => {
    const lines = [props.project.cwd, ""];
    if (props.project.claudeMd) {
      lines.push(props.project.claudeMd.split("\n").slice(0, 8).join("\n").slice(0, 400));
    }
    return lines.join("\n").trim();
  };
  return (
    <li class="group flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-white/5">
      <button
        class="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={props.onToggle}
        title={tooltip()}
      >
        <span class="inline-block w-3 text-white/40">
          {props.project.collapsed ? "▸" : "▾"}
        </span>
        <StatusDot
          color={colorForPath(props.project.cwd)}
          status={props.project.promotedStatus}
          live={props.project.promotedLive}
        />
        <span class="min-w-0 flex-1 truncate">
          <InlineEdit
            value={props.project.displayName}
            onCommit={(next) => renameProject(props.project.cwd, next)}
          >
            {(name) => <span class="truncate font-medium">{name}</span>}
          </InlineEdit>
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
        <span class="shrink-0 text-[10px] tabular-nums text-white/35">
          · {props.project.agents.length}
        </span>
      </button>
      <button
        class="hidden shrink-0 rounded px-1.5 text-xs text-white/40 hover:bg-white/10 hover:text-white group-hover:inline"
        onClick={(e) => {
          e.stopPropagation();
          props.onSpawnSibling();
        }}
        title="spawn sibling agent in same folder"
      >
        +
      </button>
    </li>
  );
}
