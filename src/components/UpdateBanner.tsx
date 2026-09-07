import { Show } from "solid-js";
import { Download, X } from "lucide-solid";

import {
  autoInstall,
  available,
  dismissed,
  error,
  install,
  phase,
  progress,
  setDismissed,
  skipVersion,
  total,
} from "../stores/updates";
import { projectsStore } from "../stores/projects";

/**
 * Surfaces a pending update. The check itself lives in stores/updates.ts and
 * runs on a timer whether or not this ever renders.
 */
export default function UpdateBanner() {
  const liveCount = () =>
    projectsStore.list.reduce(
      (n, p) => n + p.runners.filter((r) => r.live).length,
      0,
    );

  const visible = () =>
    !dismissed() &&
    (phase() === "available" ||
      phase() === "downloading" ||
      phase() === "installing" ||
      phase() === "error");

  const pct = () =>
    total() > 0 ? Math.min(100, (progress() / total()) * 100) : null;

  return (
    <Show when={visible()}>
      <div
        data-tauri-drag-region="false"
        class="cx-glass cx-sheet pointer-events-auto fixed bottom-4 right-4 z-50 flex w-[22rem] flex-col gap-2.5 rounded-cx-lg border border-line p-3.5 text-ink"
      >
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
            atualização do Cosmos
          </span>
          <button
            class="rounded p-0.5 text-faint transition hover:bg-fill-2 hover:text-ink"
            onClick={() => setDismissed(true)}
            title="fechar"
          >
            <X size={12} />
          </button>
        </div>

        <Show when={phase() === "available"}>
          <div class="text-[12.5px] text-dim">
            Versão <b class="text-ink">{available()?.version}</b> disponível.
          </div>

          <Show when={available()?.body}>
            <pre class="max-h-24 overflow-auto whitespace-pre-wrap rounded-cx bg-sunken p-2 font-mono text-[10.5px] leading-relaxed text-dim">
              {available()?.body}
            </pre>
          </Show>

          <Show when={liveCount() > 0}>
            <p class="text-[11px] leading-relaxed text-faint">
              {liveCount()} runner{liveCount() === 1 ? "" : "s"} rodando.
              Atualizar reinicia o app e encerra {liveCount() === 1 ? "ele" : "todos"} —
              as sessões voltam ao reabrir.
              <Show when={autoInstall()}>
                {" "}
                Por isso a instalação automática esperou.
              </Show>
            </p>
          </Show>

          <div class="flex gap-1.5">
            <button
              class="flex flex-1 items-center justify-center gap-1.5 rounded-cx bg-accent px-3 py-1.5 text-[11.5px] font-medium text-accent-ink transition hover:opacity-90"
              onClick={() => install()}
            >
              <Download size={12} />
              atualizar e reiniciar
            </button>
            <button
              class="rounded-cx border border-line px-2.5 py-1.5 text-[11.5px] text-dim transition hover:border-line-strong hover:text-ink"
              onClick={skipVersion}
              title="não avisar mais sobre esta versão"
            >
              pular
            </button>
          </div>
        </Show>

        <Show when={phase() === "downloading"}>
          <div class="text-[12.5px] text-dim">
            Baixando v{available()?.version}
            {pct() !== null ? ` — ${Math.round(pct()!)}%` : "…"}
          </div>
          <div class="h-1 overflow-hidden rounded-full bg-fill-2">
            <div
              class="h-full bg-accent transition-[width]"
              style={{ width: pct() !== null ? `${pct()}%` : "35%" }}
            />
          </div>
        </Show>

        <Show when={phase() === "installing"}>
          <div class="text-[12.5px] text-dim">Instalado. Reiniciando…</div>
        </Show>

        <Show when={phase() === "error"}>
          <div class="text-[12px] text-alert">{error()}</div>
          <button
            class="rounded-cx bg-fill-2 px-3 py-1.5 text-[11.5px] transition hover:bg-fill-3"
            onClick={() => install()}
          >
            tentar de novo
          </button>
        </Show>
      </div>
    </Show>
  );
}
