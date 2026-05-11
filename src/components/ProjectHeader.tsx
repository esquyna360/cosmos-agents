import { Show } from "solid-js";
import { Layers, Settings2 } from "lucide-solid";

import type { ProjectView } from "../stores/agents";
import { renameProject } from "../stores/agents";
import { colorForPath } from "../lib/colorHash";
import StatusDot from "./StatusDot";
import InlineEdit from "./InlineEdit";

function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

interface Props {
  project: ProjectView;
  onToggle: () => void;
  onSpawnSibling: () => void;
  onEditWorkspace?: () => void;
}

export default function ProjectHeader(props: Props) {
  const isWs = () => props.project.kind === "workspace";
  const tooltip = () => {
    const lines = [props.project.cwd, ""];
    if (props.project.claudeMd) {
      lines.push(props.project.claudeMd.split("\n").slice(0, 8).join("\n").slice(0, 400));
    }
    return lines.join("\n").trim();
  };
  // Folder hint: show the cwd basename as a small secondary label whenever the
  // display name differs from it. For workspaces we hide it (the cwd is a
  // `~/.cosmos/workspaces/<uuid>` opaque path that gives no info).
  const folderHint = () => {
    if (isWs()) return null;
    const folder = basename(props.project.cwd);
    return props.project.displayName !== folder ? folder : null;
  };
  return (
    <li class="group flex items-center gap-1.5 rounded px-2 py-1.5 text-sm hover:bg-white/5">
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
        <Show when={isWs()}>
          <Layers size={11} class="shrink-0 text-white/45" />
        </Show>
        <span class="min-w-0 flex-1 truncate">
          <InlineEdit
            value={props.project.displayName}
            onCommit={(next) => renameProject(props.project.cwd, next)}
          >
            {(name) => (
              <span class="flex min-w-0 items-baseline gap-1.5 truncate">
                <span class="truncate font-medium">{name}</span>
                <Show when={folderHint()}>
                  <span class="shrink-0 truncate text-[10px] font-normal text-white/30">
                    {folderHint()}
                  </span>
                </Show>
              </span>
            )}
          </InlineEdit>
        </span>
        <Show when={props.project.agents.length > 0}>
          <span class="shrink-0 text-[10px] tabular-nums text-white/35">
            · {props.project.agents.length}
          </span>
        </Show>
      </button>
      <Show when={isWs() && props.onEditWorkspace}>
        <button
          class="shrink-0 rounded p-1 text-white/35 hover:bg-white/10 hover:text-white"
          onClick={(e) => {
            e.stopPropagation();
            props.onEditWorkspace!();
          }}
          title="edit workspace"
        >
          <Settings2 size={12} />
        </button>
      </Show>
      <button
        class="shrink-0 rounded px-1.5 text-xs text-white/35 hover:bg-white/10 hover:text-white"
        onClick={(e) => {
          e.stopPropagation();
          props.onSpawnSibling();
        }}
        title="spawn another agent here (⌘⇧N)"
      >
        +
      </button>
    </li>
  );
}
