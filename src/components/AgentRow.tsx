import { Show } from "solid-js";
import { PanelRight } from "lucide-solid";

import type { AgentUI } from "../stores/agents";
import {
  agentDisplayName,
  agents,
  consumePendingRename,
  focus,
  focusedAgentId,
  pendingRenameId,
  renameAgent,
} from "../stores/agents";
import { colorForPath } from "../lib/colorHash";
import { secondaryAgentId, smartPin } from "../stores/layout";
import StatusDot from "./StatusDot";
import InlineEdit from "./InlineEdit";

function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

interface Props {
  agent: AgentUI;
  isFocused: boolean;
  indexHint?: number;
  /** Indent for project children; default 0. */
  indent?: number;
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
  // When the user has set a custom name distinct from the folder basename,
  // keep the folder name visible (subtle) so the source-of-truth isn't lost.
  const folderHint = () => {
    const display = agentDisplayName(props.agent);
    const folder = basename(props.agent.cwd);
    return display !== folder ? folder : null;
  };
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
            {(name) => (
              <span class="flex min-w-0 items-baseline gap-1.5 truncate">
                <span class="truncate">{name}</span>
                <Show when={folderHint()}>
                  <span class="shrink-0 truncate text-[10px] text-white/30">
                    {folderHint()}
                  </span>
                </Show>
              </span>
            )}
          </InlineEdit>
        </span>
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
        class="flex shrink-0 items-center rounded p-1 hover:bg-white/10"
        classList={{
          "text-white/75": secondaryAgentId() === props.agent.id,
          "text-white/25 hover:text-white/80":
            secondaryAgentId() !== props.agent.id,
        }}
        onClick={(e) => {
          e.stopPropagation();
          const fallback = agents.list.find((x) => x.id !== props.agent.id)?.id ?? null;
          smartPin(props.agent.id, focusedAgentId(), fallback, focus);
        }}
        title={secondaryAgentId() === props.agent.id ? "unpin from side" : "pin to side"}
      >
        <PanelRight size={12} />
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
