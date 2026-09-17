import { createSignal, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, X } from "lucide-solid";

import { createProject, focusProject } from "../stores/projects";
import { refreshGit } from "../stores/git";
import { basenameOf } from "./NewAgentModal";

export default function AddProjectModal(props: { onClose: () => void }) {
  const [folder, setFolder] = createSignal<string | null>(null);
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function pick() {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      setFolder(picked);
      if (!name().trim()) setName(basenameOf(picked));
    } catch (e) {
      setError(String(e));
    }
  }

  async function submit() {
    if (busy() || !folder()) return;
    setBusy(true);
    try {
      const p = await createProject(name().trim() || basenameOf(folder()!), [folder()!]);
      void refreshGit();
      focusProject(p.id);
      props.onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div
      class="fixed inset-0 z-[60] flex items-start justify-center bg-sunken pt-[16vh] backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onClose();
        if (e.key === "Enter") void submit();
      }}
    >
      <div class="cx-glass cx-sheet flex w-[460px] max-w-[94vw] flex-col gap-4 rounded-[20px] border border-line-strong p-6">
        <div class="flex items-start">
          <div>
            <h2 class="font-heading text-[24px] leading-none text-ink">Adicionar projeto</h2>
            <p class="mt-2 text-[12.5px] text-dim">Só uma pasta. Nenhum agente até você criar um.</p>
          </div>
          <button class="cx-icon-btn ml-auto" onClick={props.onClose} aria-label="Fechar">
            <X size={15} />
          </button>
        </div>

        <button
          class="flex items-center gap-2.5 rounded-[14px] border border-dashed border-line-strong px-3.5 py-3 text-left transition hover:border-accent"
          ref={(el) => queueMicrotask(() => el.focus())}
          onClick={() => void pick()}
        >
          <FolderOpen size={15} class="shrink-0 text-dim" />
          <Show when={folder()} fallback={<span class="text-[13px] text-dim">Escolher pasta</span>}>
            <span class="min-w-0 truncate font-mono text-[12px] text-ink">{folder()}</span>
          </Show>
        </button>

        <input
          class="w-full rounded-full border border-line-strong bg-raised px-3.5 py-2 text-[13.5px] text-ink outline-none placeholder:text-faint focus:border-accent"
          placeholder="Nome do projeto"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />

        <Show when={error()}>
          <p class="text-[12.5px] text-alert">{error()}</p>
        </Show>

        <div class="flex justify-end gap-2">
          <button class="cx-pill" onClick={props.onClose}>
            Cancelar
          </button>
          <button class="cx-btn-primary" disabled={busy() || !folder()} onClick={() => void submit()}>
            {busy() ? "Adicionando…" : "Adicionar projeto"}
          </button>
        </div>
      </div>
    </div>
  );
}
