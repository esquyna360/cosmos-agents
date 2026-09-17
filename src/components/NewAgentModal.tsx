import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderPlus, GitBranch, X } from "lucide-solid";

import {
  createProject,
  isMasterProject,
  projectsStore,
  workFolder,
} from "../stores/projects";
import { launchAgent } from "../stores/launch";
import { gitOf, refreshGit } from "../stores/git";
import { clisList, ensureClisDetected } from "../stores/clis";

interface Props {
  projectId?: string;
  onClose: () => void;
}

export function basenameOf(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

const shellQuote = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

export default function NewAgentModal(props: Props) {
  const projects = () => projectsStore.list.filter((p) => !isMasterProject(p));
  const [projectId, setProjectId] = createSignal<string | null>(
    props.projectId && projects().some((p) => p.id === props.projectId)
      ? props.projectId
      : (projects()[0]?.id ?? null),
  );
  const [newFolder, setNewFolder] = createSignal<string | null>(null);
  const [task, setTask] = createSignal("");
  const [name, setName] = createSignal("");
  const [worktree, setWorktree] = createSignal(false);
  const [cliId, setCliId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let taskRef: HTMLTextAreaElement | undefined;

  onMount(() => {
    taskRef?.focus();
    void refreshGit();
    ensureClisDetected().then((list) => setCliId(list.find((c) => c.available)?.id ?? null));
  });

  const clis = () => clisList().filter((c) => c.available);
  const cli = () => clis().find((c) => c.id === cliId()) ?? null;
  const project = () => (newFolder() ? null : projects().find((p) => p.id === projectId()) ?? null);
  const derivedName = () => task().trim().split(/\s+/).slice(0, 6).join(" ");
  const isRepo = createMemo(() => {
    const p = project();
    return p ? (gitOf(workFolder(p))?.isRepo ?? false) : false;
  });
  const canWorktree = () => isRepo() && !newFolder();
  const where = () => newFolder() ?? (project() ? workFolder(project()!) : null);

  const command = () => {
    const parts = ["cosmos runner add", `--project ${shellQuote(project()?.slug ?? basenameOf(newFolder() ?? "."))}`];
    parts.push(`--name ${shellQuote(name().trim() || derivedName() || "Nova sessão")}`);
    if (task().trim()) parts.push(`--task ${shellQuote(task().trim())}`);
    if (worktree() && canWorktree()) parts.push("--worktree");
    return parts.join(" ");
  };

  async function pickFolder() {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      const existing = projects().find((p) => p.folders.includes(picked));
      if (existing) {
        setNewFolder(null);
        setProjectId(existing.id);
      } else {
        setNewFolder(picked);
        setWorktree(false);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function submit() {
    if (busy() || !where()) return;
    setBusy(true);
    setError(null);
    try {
      let pid = project()?.id;
      if (newFolder()) pid = (await createProject(basenameOf(newFolder()!), [newFolder()!])).id;
      if (!pid) return;
      const picked = cli();
      await launchAgent({
        projectId: pid,
        name: name(),
        task: task(),
        worktree: worktree() && canWorktree(),
        program: picked?.program,
        args: picked?.args,
      });
      props.onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div
      class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-sunken py-[9vh] backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
      }}
    >
      <div class="cx-glass cx-sheet flex w-[540px] max-w-[94vw] flex-col gap-5 rounded-[20px] border border-line-strong p-6">
        <div class="flex items-start">
          <h2 class="font-heading text-[24px] leading-none text-ink">Novo agente</h2>
          <button class="cx-icon-btn ml-auto" onClick={props.onClose} aria-label="Fechar">
            <X size={15} />
          </button>
        </div>

        <Field label="Onde">
          <div class="flex flex-wrap gap-1.5">
            <For each={projects()}>
              {(p) => (
                <button
                  class="cx-pill cx-pill-line"
                  data-on={!newFolder() && projectId() === p.id}
                  onClick={() => {
                    setNewFolder(null);
                    setProjectId(p.id);
                  }}
                >
                  {p.name}
                </button>
              )}
            </For>
            <Show when={newFolder()}>
              <button class="cx-pill cx-pill-line" data-on="true" title={newFolder()!}>
                {basenameOf(newFolder()!)}
              </button>
            </Show>
            <button class="cx-pill border border-dashed border-line-strong" onClick={() => void pickFolder()}>
              <FolderPlus size={12} />
              Outra pasta
            </button>
          </div>
          <Show when={newFolder()}>
            <p class="mt-1.5 font-mono text-[11px] text-faint">{newFolder()} vira um projeto novo.</p>
          </Show>
        </Field>

        <Field label="Tarefa" hint="opcional">
          <textarea
            ref={taskRef}
            rows={3}
            class="w-full resize-none rounded-[14px] border border-line-strong bg-raised px-3.5 py-2.5 text-[13.5px] leading-snug text-ink outline-none placeholder:text-faint focus:border-accent"
            placeholder="O que ele deve fazer? Vai como primeira mensagem."
            value={task()}
            onInput={(e) => setTask(e.currentTarget.value)}
          />
        </Field>

        <Field label="Nome">
          <input
            class="w-full rounded-full border border-line-strong bg-raised px-3.5 py-2 text-[13.5px] text-ink outline-none placeholder:text-faint focus:border-accent"
            placeholder={derivedName() || "Ganha um nome sozinho depois da primeira resposta"}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </Field>

        <Field label="Código">
          <div class="grid grid-cols-2 gap-2">
            <Choice
              on={!worktree() || !canWorktree()}
              title="Trabalhar na main"
              body="Na pasta do projeto, junto com você e com os outros agentes."
              onClick={() => setWorktree(false)}
            />
            <Choice
              on={worktree() && canWorktree()}
              disabled={!canWorktree()}
              title="Worktree própria"
              body={
                canWorktree()
                  ? "Cópia isolada numa branch só dele. Não pisa no trabalho de ninguém."
                  : "Precisa que a pasta seja um repositório git."
              }
              icon
              onClick={() => setWorktree(true)}
            />
          </div>
        </Field>

        <Show when={clis().length > 1}>
          <Field label="Quem">
            <div class="flex flex-wrap gap-1.5">
              <For each={clis()}>
                {(c) => (
                  <button class="cx-pill cx-pill-line" data-on={cliId() === c.id} onClick={() => setCliId(c.id)}>
                    {c.name}
                  </button>
                )}
              </For>
            </div>
          </Field>
        </Show>

        <Show when={project()}>
          <div class="rounded-[12px] bg-well px-3 py-2">
            <p class="break-all font-mono text-[11px] leading-relaxed text-[#b9ae9d]">
              <span class="text-[#7f776b]">$ </span>
              {command()}
            </p>
          </div>
        </Show>

        <Show when={error()}>
          <p class="text-[12.5px] text-alert">{error()}</p>
        </Show>

        <div class="flex items-center justify-end gap-2">
          <span class="mr-auto text-[11.5px] text-faint">⌘↵ para criar</span>
          <button class="cx-pill" onClick={props.onClose}>
            Cancelar
          </button>
          <button class="cx-btn-primary" disabled={busy() || !where()} onClick={() => void submit()}>
            {busy() ? "Criando…" : "Criar agente"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field(props: { label: string; hint?: string; children: any }) {
  return (
    <div class="flex flex-col gap-2">
      <span class="text-[12px] text-dim">
        {props.label}
        <Show when={props.hint}>
          <span class="ml-1.5 text-faint">{props.hint}</span>
        </Show>
      </span>
      {props.children}
    </div>
  );
}

function Choice(props: {
  on: boolean;
  disabled?: boolean;
  title: string;
  body: string;
  icon?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      class="flex flex-col gap-1 rounded-[14px] border px-3.5 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50"
      classList={{
        "border-accent bg-accent-soft": props.on,
        "border-line-strong hover:bg-fill-1": !props.on,
      }}
      disabled={props.disabled}
      aria-pressed={props.on}
      onClick={props.onClick}
    >
      <span class="flex items-center gap-1.5 text-[13px] font-medium text-ink">
        <Show when={props.icon}>
          <GitBranch size={12} />
        </Show>
        {props.title}
      </span>
      <span class="text-[11.5px] leading-snug text-dim">{props.body}</span>
    </button>
  );
}
