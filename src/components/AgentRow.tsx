import { Show } from "solid-js";

import type { AgentUI } from "../stores/agents";
import {
  agentDisplayName,
  consumePendingRename,
  pendingRenameId,
  renameAgent,
} from "../stores/agents";
import { colorForPath } from "../lib/colorHash";
import StatusDot from "./StatusDot";
import InlineEdit from "./InlineEdit";

interface Props {
  agent: AgentUI;
  isFocused: boolean;
  indexHint?: number;
  /** Indent for project children; default 0. */
  indent?: number;
  /** Show stack badges; false when nested inside a project group. */
  showStacks?: boolean;
  onFocus: () => void;
  onClose: () => void;
}

export default function AgentRow(props: Props) {
  const tooltip = () => {
    const lines = [props.agent.cwd, ""];
    if (props.agent.claudeMd) {
      lines.push(props.agent.claudeMd.split("\n").slice(0, 8).join("\n").slice(0, 400));
    }
    return lines.join("\n").trim();
  };
  const autoEdit = () => pendingRenameId() === props.agent.id;
  return (
    <li
      class="group flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-white/5"
      classList={{ "bg-white/10": props.isFocused }}
      style={{ "padding-left": `${8 + (props.indent ?? 0)}px` }}
    >
      <button
        class="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={props.onFocus}
        title={tooltip()}
      >
        <StatusDot
          color={colorForPath(props.agent.cwd)}
          status={props.agent.status}
          live={props.agent.live}
        />
        <span class="min-w-0 flex-1 truncate">
          <InlineEdit
            value={agentDisplayName(props.agent)}
            autoEdit={autoEdit()}
            onCommit={(next) => {
              renameAgent(props.agent.id, next);
              consumePendingRename(props.agent.id);
            }}
            onCancel={() => consumePendingRename(props.agent.id)}
          >
            {(name) => <span class="truncate">{name}</span>}
          </InlineEdit>
        </span>
        <Show when={props.showStacks ?? true}>
          <Show when={props.agent.stacks.length > 0}>
            <span class="flex shrink-0 gap-0.5">
              {props.agent.stacks.slice(0, 3).map((s) => (
                <span
                  class="rounded px-1 text-[9px] font-medium leading-4 text-white"
                  style={{ "background-color": s.color, opacity: 0.85 }}
                >
                  {s.label}
                </span>
              ))}
            </span>
          </Show>
        </Show>
        <Show when={props.agent.claudeMd}>
          <span class="shrink-0 text-[10px] text-white/35" title="has .claude/CLAUDE.md">
            ⚑
          </span>
        </Show>
        <Show when={props.indexHint !== undefined}>
          <span class="hidden shrink-0 text-[10px] text-white/30 group-hover:inline">
            ⌘{props.indexHint! + 1}
          </span>
        </Show>
      </button>
      <button
        class="hidden shrink-0 text-white/40 hover:text-white/80 group-hover:inline"
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        title="close"
      >
        ×
      </button>
    </li>
  );
}
