import { createSignal, onMount, Show } from "solid-js";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Download, X } from "lucide-solid";

type Phase = "idle" | "available" | "downloading" | "installed" | "error";

export default function UpdateBanner() {
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [update, setUpdate] = createSignal<Update | null>(null);
  const [progress, setProgress] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [dismissed, setDismissed] = createSignal(false);

  onMount(async () => {
    try {
      const u = await check();
      if (u) {
        setUpdate(u);
        setPhase("available");
      }
    } catch (e) {
      // Silent: no network, no release yet, etc. Banner just doesn't show.
      console.warn("[updater] check failed", e);
    }
  });

  async function apply() {
    const u = update();
    if (!u) return;
    setPhase("downloading");
    setError(null);
    setProgress(0);
    try {
      await u.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          setTotal(evt.data.contentLength ?? 0);
        } else if (evt.event === "Progress") {
          setProgress((p) => p + evt.data.chunkLength);
        }
      });
      setPhase("installed");
      await relaunch();
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  return (
    <Show when={!dismissed() && phase() !== "idle" && update()}>
      <div
        class="pointer-events-auto fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2 rounded-lg border border-white/10 bg-[#13161b]/95 p-3 text-xs text-white/90 shadow-xl backdrop-blur"
        data-no-drag
      >
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-semibold uppercase tracking-wider text-white/45">
            Cosmos update
          </span>
          <button
            class="text-white/40 hover:text-white"
            onClick={() => setDismissed(true)}
            title="dismiss"
          >
            <X size={12} />
          </button>
        </div>

        <Show when={phase() === "available"}>
          <div class="text-white/80">
            Versão <b>{update()?.version}</b> disponível.
          </div>
          <Show when={update()?.body}>
            <pre class="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 text-[10px] text-white/60">
              {update()?.body}
            </pre>
          </Show>
          <button
            class="flex items-center justify-center gap-2 rounded bg-white/10 px-3 py-1.5 text-[11px] font-medium hover:bg-white/20"
            onClick={apply}
          >
            <Download size={12} />
            Atualizar e reiniciar
          </button>
        </Show>

        <Show when={phase() === "downloading"}>
          <div class="text-white/70">Baixando v{update()?.version}…</div>
          <div class="h-1.5 overflow-hidden rounded bg-white/10">
            <div
              class="h-full bg-white/60 transition-[width]"
              style={{
                width:
                  total() > 0
                    ? `${Math.min(100, (progress() / total()) * 100)}%`
                    : "30%",
              }}
            />
          </div>
        </Show>

        <Show when={phase() === "installed"}>
          <div class="text-white/70">Instalado. Reiniciando…</div>
        </Show>

        <Show when={phase() === "error"}>
          <div class="text-red-300">{error()}</div>
          <button
            class="rounded bg-white/10 px-3 py-1.5 text-[11px] hover:bg-white/20"
            onClick={apply}
          >
            Tentar novamente
          </button>
        </Show>
      </div>
    </Show>
  );
}
