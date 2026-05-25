import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Bot, ChevronDown, TerminalSquare, X } from "lucide-solid";

import {
  closeRunner,
  createRunnerInProject,
  focusedRunner,
  focusRunner,
  pendingRenameId,
  consumePendingRename,
  renameRunner,
  type ProjectUI,
} from "../stores/projects";
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
  const activeId = () => focusedRunner()?.id ?? null;

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

  function closeShellDropdown() {
    setShellDropdownOpen(false);
  }

  async function openAgentDropdown() {
    setAgentDropdownOpen(true);
    // Trigger detection if it hasn't run yet. Fast no-op on subsequent opens.
    ensureClisDetected().catch(console.error);
  }
  function closeAgentDropdown() {
    setAgentDropdownOpen(false);
  }

  async function spawnAgent(cli: CliInfo) {
    closeAgentDropdown();
    // Runner name shows the CLI so multiple agents are distinguishable.
    const existing = p().runners.filter((r) => r.kind === "agent" && r.name.startsWith(cli.id));
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
    // Hint to UI that the shell is running `cmd` — purely informational for
    // a future tooltip. cmd unused at runtime.
    void cmd;
  }

  return (
    <div class="flex shrink-0 items-stretch gap-0.5 overflow-x-visible border-b border-white/5 bg-[#0a0c0f] px-2 py-1 text-[12px]">
      <div class="flex items-stretch gap-0.5 overflow-x-auto">
        <For each={p().runners}>
          {(r) => {
            const isActive = () => activeId() === r.id;
            const isShell = () => r.kind === "shell";
            const autoEdit = () => pendingRenameId() === r.id;
            return (
              <div
                class="group relative flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 transition"
                classList={{
                  "border-white/15 bg-white/10 text-white": isActive(),
                  "border-transparent text-white/65 hover:border-white/10 hover:bg-white/5":
                    !isActive(),
                }}
              >
                <button
                  class="flex items-center gap-1.5"
                  onClick={() => focusRunner(p().id, r.id)}
                  title={`${r.kind} · ${r.name}`}
                >
                  <span class="shrink-0 text-white/60">
                    {isShell() ? <TerminalSquare size={11} /> : <Bot size={11} />}
                  </span>
                  <span
                    class="h-1.5 w-1.5 shrink-0 rounded-full"
                    classList={{
                      "bg-emerald-400/80": r.live && r.status === "idle",
                      "bg-amber-300/80":
                        r.status === "streaming" || r.status === "tool_running",
                      "bg-rose-400/90":
                        r.status === "awaiting_input" || r.status === "error",
                      "bg-white/25": !r.live || r.status === "exited",
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
                  class="ml-0.5 hidden rounded p-0.5 text-white/45 hover:bg-white/10 hover:text-white group-hover:inline-flex"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeRunner(r.id).catch(console.error);
                  }}
                  title="close runner (⌘W)"
                >
                  <X size={10} />
                </button>
              </div>
            );
          }}
        </For>

        <Show when={p().runners.length === 0}>
          <span class="px-2 py-1 text-white/35">no runners yet —</span>
        </Show>
      </div>

      <div class="ml-1 flex items-center gap-1">
        <div class="relative shrink-0">
          <button
            class="flex shrink-0 items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-white/75 hover:border-white/25 hover:bg-white/5 hover:text-white"
            onClick={() =>
              agentDropdownOpen() ? closeAgentDropdown() : openAgentDropdown()
            }
            title="add agent (⌘⇧N)"
          >
            <Bot size={11} />
            <span>+ agent</span>
            <ChevronDown size={9} class="text-white/45" />
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
            class="flex shrink-0 items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-white/75 hover:border-white/25 hover:bg-white/5 hover:text-white"
            onClick={() =>
              shellDropdownOpen() ? closeShellDropdown() : openShellDropdown()
            }
            title="add shell or script"
          >
            <TerminalSquare size={11} />
            <span>+ shell</span>
            <ChevronDown size={9} class="text-white/45" />
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
      class="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-md border border-white/10 bg-[#0f1217] shadow-2xl"
    >
      <div class="border-b border-white/5 bg-white/[0.02] px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-white/45">
        pick an AI CLI
      </div>
      <Show
        when={props.loaded}
        fallback={
          <div class="px-3 py-2 text-[11px] text-white/40">scanning $PATH…</div>
        }
      >
        <Show
          when={props.clis.length > 0}
          fallback={
            <div class="px-3 py-2 text-[11px] text-white/35">
              no presets defined
            </div>
          }
        >
          <For each={props.clis}>
            {(cli) => (
              <button
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition disabled:cursor-not-allowed disabled:opacity-40"
                classList={{
                  "text-white/85 hover:bg-white/10": cli.available,
                  "text-white/50": !cli.available,
                }}
                disabled={!cli.available}
                onClick={() => props.onPick(cli)}
                title={cli.available ? cli.hint : `${cli.hint} — not on $PATH`}
              >
                <Bot size={11} class="shrink-0 text-white/55" />
                <div class="min-w-0 flex-1">
                  <div class="font-medium">{cli.name}</div>
                  <div class="text-[10px] text-white/35">
                    {cli.hint}
                    <Show when={!cli.available}>
                      <span class="ml-1 text-amber-300/70">· not installed</span>
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
  onSpawnScript: (
    fs: FolderScripts,
    name: string,
    cmd: string,
  ) => void;
}) {
  // Click-outside to close. Document-level listener gated by a data attr so
  // clicks inside the menu don't dismiss. Properly torn down via onCleanup.
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
      class="absolute right-0 top-full z-30 mt-1 w-60 overflow-hidden rounded-md border border-white/10 bg-[#0f1217] shadow-2xl"
    >
      <button
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-white/85 hover:bg-white/10"
        onClick={props.onSpawnBlank}
      >
        <TerminalSquare size={11} class="shrink-0 text-white/55" />
        <div class="min-w-0 flex-1">
          <div>shell (blank)</div>
          <div class="text-[10px] text-white/35">interactive zsh in project cwd</div>
        </div>
      </button>
      <Show when={props.loading}>
        <div class="border-t border-white/5 px-3 py-2 text-[11px] text-white/40">
          scanning package.json…
        </div>
      </Show>
      <Show when={!props.loading && props.folderScripts.length === 0}>
        <div class="border-t border-white/5 px-3 py-2 text-[11px] text-white/35">
          no package.json scripts found
        </div>
      </Show>
      <For each={props.folderScripts}>
        {(fs) => (
          <>
            <div class="border-t border-white/5 bg-white/[0.02] px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-white/45">
              <Show when={props.multiFolder} fallback={<>scripts ({fs.packageManager})</>}>
                {fs.basename} ({fs.packageManager})
              </Show>
            </div>
            <For each={fs.scripts}>
              {(s) => (
                <button
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-white/85 hover:bg-white/10"
                  onClick={() => props.onSpawnScript(fs, s.name, s.command)}
                  title={s.command}
                >
                  <span class="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                  <span class="ml-2 max-w-[120px] truncate text-[10px] text-white/35">
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
