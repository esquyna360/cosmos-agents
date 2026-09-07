import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Bot, ChevronDown, Power, TerminalSquare, Trash2 } from "lucide-solid";

import {
  consumePendingRename,
  createRunnerInProject,
  deleteRunner,
  focusRunner,
  pendingRenameId,
  renameRunner,
  stopRunner,
  type ProjectUI,
} from "../stores/projects";
import { activeSlot, slotsFor } from "../stores/panes";
import {
  readPackageScripts,
  scriptInvocation,
  type PackageManager,
} from "../lib/scripts";
import { clisList, clisLoaded, ensureClisDetected } from "../stores/clis";
import type { CliInfo } from "../lib/clis";
import InlineEdit from "./InlineEdit";

interface Props {
  project: ProjectUI;
}

function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

interface FolderScripts {
  folder: string;
  basename: string;
  packageManager: PackageManager;
  scripts: Array<{ name: string; command: string }>;
}

export default function RunnerTabs(props: Props) {
  const p = () => props.project;
  const shown = () => new Set(slotsFor(p().id).filter(Boolean) as string[]);
  const inActiveSlot = () => slotsFor(p().id)[activeSlot()] ?? null;

  const [shellDropdownOpen, setShellDropdownOpen] = createSignal(false);
  const [agentDropdownOpen, setAgentDropdownOpen] = createSignal(false);
  const [folderScripts, setFolderScripts] = createSignal<FolderScripts[] | null>(null);
  const [loadingScripts, setLoadingScripts] = createSignal(false);

  async function openShellDropdown() {
    setShellDropdownOpen(true);
    if (folderScripts() !== null) return; // already loaded
    setLoadingScripts(true);
    try {
      const results: FolderScripts[] = [];
      for (const folder of p().folders) {
        try {
          const info = await readPackageScripts(folder);
          if (info.scripts.length > 0) {
            results.push({
              folder,
              basename: basename(folder),
              packageManager: info.packageManager,
              scripts: info.scripts,
            });
          }
        } catch (e) {
          console.error("[scripts] read failed for", folder, e);
        }
      }
      setFolderScripts(results);
    } finally {
      setLoadingScripts(false);
    }
  }

  const closeShellDropdown = () => setShellDropdownOpen(false);
  const closeAgentDropdown = () => setAgentDropdownOpen(false);

  function openAgentDropdown() {
    setAgentDropdownOpen(true);
    ensureClisDetected().catch(console.error);
  }

  async function spawnAgent(cli: CliInfo) {
    closeAgentDropdown();
    const existing = p().runners.filter(
      (r) => r.kind === "agent" && r.name.startsWith(cli.id),
    );
    const nameSuffix = existing.length === 0 ? "" : `-${existing.length + 1}`;
    await createRunnerInProject(p().id, "agent", {
      name: `${cli.id}${nameSuffix}`,
      program: cli.program,
      args: cli.args,
    }).catch(console.error);
  }

  async function spawnBlankShell() {
    closeShellDropdown();
    await createRunnerInProject(p().id, "shell").catch(console.error);
  }

  async function spawnScript(fs: FolderScripts, name: string, cmd: string) {
    closeShellDropdown();
    const runnerName = p().folders.length > 1 ? `${fs.basename}·${name}` : name;
    const invocation = scriptInvocation(fs.packageManager, name);
    // Windows has no /bin/zsh — run the script under powershell instead.
    const { program, args } = navigator.userAgent.includes("Windows")
      ? { program: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-Command", invocation] }
      : { program: "/bin/zsh", args: ["-i", "-l", "-c", `exec ${invocation}`] };
    await createRunnerInProject(p().id, "shell", {
      name: runnerName,
      cwd: fs.folder,
      program,
      args,
    }).catch(console.error);
    void cmd;
  }

  return (
    <div class="flex shrink-0 items-stretch gap-1 border-b border-line bg-panel px-2 py-1.5 text-[12px]">
      <div class="flex min-w-0 items-stretch gap-1 overflow-x-auto">
        <For each={p().runners}>
          {(r) => {
            const onScreen = () => shown().has(r.id);
            const isActive = () => inActiveSlot() === r.id;
            const autoEdit = () => pendingRenameId() === r.id;
            return (
              <div
                class="group relative flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 transition"
                classList={{
                  "border-white/18 bg-white/10 text-ink": isActive(),
                  "border-white/8 bg-white/[0.03] text-dim":
                    onScreen() && !isActive(),
                  "border-transparent text-faint hover:border-white/8 hover:bg-white/[0.04] hover:text-dim":
                    !onScreen(),
                }}
              >
                <button
                  class="flex items-center gap-1.5"
                  onClick={() => focusRunner(p().id, r.id)}
                  title={`${r.kind} · ${r.name}${r.live ? "" : " · parado — clique para retomar"}`}
                >
                  <span class="shrink-0 opacity-60">
                    {r.kind === "shell" ? (
                      <TerminalSquare size={11} />
                    ) : (
                      <Bot size={11} />
                    )}
                  </span>
                  <span
                    class="h-1.5 w-1.5 shrink-0 rounded-full"
                    classList={{
                      "bg-live": r.live && r.status === "idle",
                      "bg-busy cx-pulse":
                        r.live &&
                        (r.status === "streaming" || r.status === "tool_running"),
                      "bg-alert cx-pulse": r.status === "awaiting_input",
                      "bg-alert": r.status === "error",
                      "bg-white/20": !r.live || r.status === "exited",
                    }}
                  />
                  <InlineEdit
                    value={r.name}
                    autoEdit={autoEdit()}
                    onCommit={(next) => {
                      renameRunner(r.id, next).catch(console.error);
                      consumePendingRename(r.id);
                    }}
                    onCancel={() => consumePendingRename(r.id)}
                  >
                    {(name) => <span class="truncate">{name}</span>}
                  </InlineEdit>
                </button>
                <button
                  class="ml-0.5 hidden rounded p-0.5 text-faint transition hover:bg-white/10 hover:text-ink group-hover:inline-flex"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.altKey) {
                      deleteRunner(r.id).catch(console.error);
                    } else {
                      stopRunner(r.id).catch(console.error);
                    }
                  }}
                  title="parar (⌘W) — a sessão fica guardada. ⌥clique exclui de vez"
                >
                  {r.live ? <Power size={10} /> : <Trash2 size={10} />}
                </button>
              </div>
            );
          }}
        </For>

        <Show when={p().runners.length === 0}>
          <span class="px-2 py-1 text-faint">nenhum runner ainda —</span>
        </Show>
      </div>

      <div class="ml-auto flex shrink-0 items-center gap-1 pl-1">
        <div class="relative shrink-0">
          <button
            class="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-dim transition hover:border-white/25 hover:bg-white/6 hover:text-ink"
            onClick={() =>
              agentDropdownOpen() ? closeAgentDropdown() : openAgentDropdown()
            }
            title="novo agente (⌘⇧N)"
          >
            <Bot size={11} />
            <span>agente</span>
            <ChevronDown size={9} class="opacity-50" />
          </button>
          <Show when={agentDropdownOpen()}>
            <AgentDropdown
              clis={clisList()}
              loaded={clisLoaded()}
              onClose={closeAgentDropdown}
              onPick={spawnAgent}
            />
          </Show>
        </div>
        <div class="relative shrink-0">
          <button
            class="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-dim transition hover:border-white/25 hover:bg-white/6 hover:text-ink"
            onClick={() =>
              shellDropdownOpen() ? closeShellDropdown() : openShellDropdown()
            }
            title="novo shell ou script"
          >
            <TerminalSquare size={11} />
            <span>shell</span>
            <ChevronDown size={9} class="opacity-50" />
          </button>
          <Show when={shellDropdownOpen()}>
            <ShellDropdown
              loading={loadingScripts()}
              folderScripts={folderScripts() ?? []}
              multiFolder={p().folders.length > 1}
              onClose={closeShellDropdown}
              onSpawnBlank={spawnBlankShell}
              onSpawnScript={spawnScript}
            />
          </Show>
        </div>
      </div>
    </div>
  );
}

function AgentDropdown(props: {
  clis: CliInfo[];
  loaded: boolean;
  onClose: () => void;
  onPick: (cli: CliInfo) => void;
}) {
  function onDocClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-agent-dropdown]")) return;
    props.onClose();
  }
  onMount(() => document.addEventListener("mousedown", onDocClick));
  onCleanup(() => document.removeEventListener("mousedown", onDocClick));

  return (
    <div
      data-agent-dropdown
      class="cx-sheet absolute right-0 top-full z-30 mt-1.5 w-60 overflow-hidden rounded-cx border border-line bg-float shadow-2xl"
    >
      <div class="border-b border-line bg-white/[0.02] px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-faint">
        escolha a CLI
      </div>
      <Show
        when={props.loaded}
        fallback={<div class="px-3 py-2 text-[11px] text-faint">lendo $PATH…</div>}
      >
        <Show
          when={props.clis.length > 0}
          fallback={
            <div class="px-3 py-2 text-[11px] text-faint">nenhum preset</div>
          }
        >
          <For each={props.clis}>
            {(cli) => (
              <button
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40"
                classList={{
                  "text-ink hover:bg-white/8": cli.available,
                  "text-faint": !cli.available,
                }}
                disabled={!cli.available}
                onClick={() => props.onPick(cli)}
                title={cli.available ? cli.hint : `${cli.hint} — fora do $PATH`}
              >
                <Bot size={11} class="shrink-0 opacity-60" />
                <div class="min-w-0 flex-1">
                  <div class="font-medium">{cli.name}</div>
                  <div class="text-[10px] text-faint">
                    {cli.hint}
                    <Show when={!cli.available}>
                      <span class="ml-1 text-busy">· não instalado</span>
                    </Show>
                  </div>
                </div>
              </button>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}

function ShellDropdown(props: {
  loading: boolean;
  folderScripts: FolderScripts[];
  multiFolder: boolean;
  onClose: () => void;
  onSpawnBlank: () => void;
  onSpawnScript: (fs: FolderScripts, name: string, cmd: string) => void;
}) {
  function onDocClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("[data-shell-dropdown]")) return;
    props.onClose();
  }
  onMount(() => document.addEventListener("mousedown", onDocClick));
  onCleanup(() => document.removeEventListener("mousedown", onDocClick));

  return (
    <div
      data-shell-dropdown
      class="cx-sheet absolute right-0 top-full z-30 mt-1.5 max-h-80 w-64 overflow-y-auto rounded-cx border border-line bg-float shadow-2xl"
    >
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-ink transition hover:bg-white/8"
        onClick={props.onSpawnBlank}
      >
        <TerminalSquare size={11} class="shrink-0 opacity-60" />
        <div class="min-w-0 flex-1">
          <div>shell vazio</div>
          <div class="text-[10px] text-faint">zsh interativo na pasta do projeto</div>
        </div>
      </button>
      <Show when={props.loading}>
        <div class="border-t border-line px-3 py-2 text-[11px] text-faint">
          lendo package.json…
        </div>
      </Show>
      <Show when={!props.loading && props.folderScripts.length === 0}>
        <div class="border-t border-line px-3 py-2 text-[11px] text-faint">
          nenhum script encontrado
        </div>
      </Show>
      <For each={props.folderScripts}>
        {(fs) => (
          <>
            <div class="border-t border-line bg-white/[0.02] px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-faint">
              <Show
                when={props.multiFolder}
                fallback={<>scripts ({fs.packageManager})</>}
              >
                {fs.basename} ({fs.packageManager})
              </Show>
            </div>
            <For each={fs.scripts}>
              {(s) => (
                <button
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-dim transition hover:bg-white/8 hover:text-ink"
                  onClick={() => props.onSpawnScript(fs, s.name, s.command)}
                  title={s.command}
                >
                  <span class="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                  <span class="ml-2 max-w-[110px] truncate text-[10px] text-faint">
                    {s.command}
                  </span>
                </button>
              )}
            </For>
          </>
        )}
      </For>
    </div>
  );
}
