import { For, Show } from "solid-js";

import {
  agents,
  closeAgent,
  createSiblingAgent,
  focus,
  focusedAgentId,
  projects,
  toggleProjectCollapsed,
  type AgentUI,
  type ProjectView,
} from "../stores/agents";
import type { AgentStatus } from "../lib/ipc";
import { workspaces, workspaceById } from "../stores/workspaces";
import { openCreator } from "../stores/creator";
import AgentRow from "./AgentRow";
import ProjectHeader from "./ProjectHeader";

function flatIndex(agentId: string): number {
  return agents.list.findIndex((a) => a.id === agentId);
}

export default function Sidebar() {
  // Split projects into workspaces vs folder. Workspaces with no live agent are
  // synthesized from the workspaces store so they show up after a restart.
  const grouped = () => {
    const folderProjects: ProjectView[] = [];
    const workspaceProjects: ProjectView[] = [];
    const seenWorkspaceIds = new Set<string>();
    for (const p of projects()) {
      if (p.kind === "workspace") {
        workspaceProjects.push(p);
        if (p.workspaceId) seenWorkspaceIds.add(p.workspaceId);
      } else {
        folderProjects.push(p);
      }
    }
    // Inject zero-agent workspaces as synthetic ProjectView rows.
    for (const w of workspaces.items) {
      if (seenWorkspaceIds.has(w.id)) continue;
      workspaceProjects.push({
        cwd: w.cwd,
        kind: "workspace",
        workspaceId: w.id,
        displayName: w.name,
        agents: [] as AgentUI[],
        collapsed: false,
        stacks: [],
        claudeMd: null,
        promotedStatus: "idle" as AgentStatus,
        promotedLive: false,
      });
    }
    return { folderProjects, workspaceProjects };
  };

  return (
    <aside class="flex h-full w-56 shrink-0 flex-col border-r border-white/5 bg-[#0a0c0f]">
      <ul class="min-h-0 flex-1 overflow-y-auto px-2 pt-2">
        <Show when={grouped().workspaceProjects.length > 0}>
          <SectionHeader
            label="workspaces"
            onAdd={() => openCreator({ mode: "workspace" })}
            addTitle="new workspace (⌘T)"
          />
          <For each={grouped().workspaceProjects}>
            {(p) => <ProjectSection project={p} />}
          </For>
        </Show>
        <SectionHeader
          label="agents"
          onAdd={() => openCreator({ mode: "agent" })}
          addTitle="new agent (⌘T)"
        />
        <For each={grouped().folderProjects}>
          {(p) => <ProjectSection project={p} />}
        </For>
      </ul>
      <div class="border-t border-white/5 px-3 py-2 text-[10px] leading-relaxed text-white/30">
        ⌘T new · ⌘⇧N sibling · ⌘W close<br />
        ⌘E view · ⌘I composer · ⌘D workflow<br />
        ⌘P file · ⌘⇧F search · ⌘1–9 focus
      </div>
    </aside>
  );
}

function SectionHeader(props: { label: string; onAdd: () => void; addTitle: string }) {
  return (
    <li class="flex items-center justify-between px-1 pb-1 pt-2">
      <span class="text-[10px] font-medium uppercase tracking-wider text-white/40">
        {props.label}
      </span>
      <button
        class="rounded px-1.5 text-sm leading-none text-white/55 hover:bg-white/10 hover:text-white"
        onClick={props.onAdd}
        title={props.addTitle}
      >
        +
      </button>
    </li>
  );
}

function ProjectSection(props: { project: ProjectView }) {
  const p = props.project;
  // Workspace with zero agents → just a single-row header that spawns on click.
  if (p.kind === "workspace" && p.agents.length === 0) {
    return (
      <ProjectHeader
        project={p}
        onToggle={() => createSiblingAgent(p.cwd).catch(console.error)}
        onSpawnSibling={() => createSiblingAgent(p.cwd).catch(console.error)}
        onEditWorkspace={() => editWorkspace(p.workspaceId)}
      />
    );
  }
  // Folder project with 1 agent → flat row.
  if (p.kind === "folder" && p.agents.length === 1) {
    const a = p.agents[0];
    return (
      <AgentRow
        agent={a}
        isFocused={focusedAgentId() === a.id}
        indexHint={flatIndex(a.id)}
        onFocus={() => focus(a.id)}
        onClose={() => closeAgent(a.id)}
      />
    );
  }
  // Otherwise: header + children.
  return (
    <>
      <ProjectHeader
        project={p}
        onToggle={() => toggleProjectCollapsed(p.cwd)}
        onSpawnSibling={() => createSiblingAgent(p.cwd).catch(console.error)}
        onEditWorkspace={p.kind === "workspace" ? () => editWorkspace(p.workspaceId) : undefined}
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
                  onFocus={() => focus(a.id)}
                  onClose={() => closeAgent(a.id)}
                />
              )}
            </For>
          </ul>
        </li>
      </Show>
    </>
  );
}

function editWorkspace(id: string | undefined): void {
  if (!id) return;
  const ws = workspaceById().get(id);
  if (ws) openCreator({ mode: "workspace", editing: ws });
}
