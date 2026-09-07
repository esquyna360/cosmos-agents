import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  RotateCw,
  X,
} from "lucide-solid";
import { invoke } from "@tauri-apps/api/core";

/**
 * Preview pane.
 *
 * This is an iframe, not a second engine: the point is having the dev server
 * next to the terminal that's rebuilding it, not replacing Chrome. Anything
 * that sets `X-Frame-Options` simply won't paint — hence the escape hatch to
 * the system browser.
 *
 * The port chips are probed with an opaque `no-cors` fetch, which resolves for
 * a listening server and rejects otherwise. It can't read the response, but
 * reachability is the only question being asked.
 */

const PORTS = [1420, 3000, 3001, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8888];
const PROBE_MS = 5000;

interface Props {
  projectId: string;
}

function key(projectId: string): string {
  return `cosmos.browser.url.${projectId}`;
}

function normalize(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^localhost(:\d+)?(\/|$)/i.test(raw) || /^\d+$/.test(raw)) {
    return /^\d+$/.test(raw) ? `http://localhost:${raw}` : `http://${raw}`;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(raw)) return `http://${raw}`;
  if (/^[\w-]+(\.[\w-]+)+/.test(raw)) return `https://${raw}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
}

export default function Browser(props: Props) {
  const stored = localStorage.getItem(key(props.projectId)) ?? "";
  const [url, setUrl] = createSignal(stored);
  const [draft, setDraft] = createSignal(stored);
  const [live, setLive] = createSignal<number[]>([]);

  // Back/forward is kept here: an iframe's own history is inaccessible
  // cross-origin, so the pane owns the stack it can actually control.
  const [stack, setStack] = createSignal<string[]>(stored ? [stored] : []);
  const [at, setAt] = createSignal(stored ? 0 : -1);

  let frame: HTMLIFrameElement | undefined;

  function go(next: string | null, push = true) {
    if (!next) return;
    setUrl(next);
    setDraft(next);
    localStorage.setItem(key(props.projectId), next);
    if (push) {
      const cut = stack().slice(0, at() + 1);
      setStack([...cut, next]);
      setAt(cut.length);
    }
  }

  function back() {
    if (at() <= 0) return;
    const i = at() - 1;
    setAt(i);
    go(stack()[i], false);
  }
  function forward() {
    if (at() >= stack().length - 1) return;
    const i = at() + 1;
    setAt(i);
    go(stack()[i], false);
  }

  async function probe() {
    const found: number[] = [];
    await Promise.all(
      PORTS.map(async (port) => {
        try {
          await fetch(`http://localhost:${port}/`, {
            mode: "no-cors",
            signal: AbortSignal.timeout(700),
          });
          found.push(port);
        } catch {
          /* not listening */
        }
      }),
    );
    setLive(found.sort((a, b) => a - b));
  }

  onMount(() => {
    probe();
    const t = setInterval(probe, PROBE_MS);
    onCleanup(() => clearInterval(t));
  });

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-void">
      <div class="flex shrink-0 items-center gap-1 border-b border-line bg-panel px-2 py-1.5">
        <button
          class="rounded-cx p-1.5 text-faint transition hover:bg-fill-2 hover:text-ink disabled:opacity-30"
          disabled={at() <= 0}
          onClick={back}
          title="voltar"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          class="rounded-cx p-1.5 text-faint transition hover:bg-fill-2 hover:text-ink disabled:opacity-30"
          disabled={at() >= stack().length - 1}
          onClick={forward}
          title="avançar"
        >
          <ArrowRight size={13} />
        </button>
        <button
          class="rounded-cx p-1.5 text-faint transition hover:bg-fill-2 hover:text-ink disabled:opacity-30"
          disabled={!url()}
          onClick={() => frame && (frame.src = url())}
          title="recarregar"
        >
          <RotateCw size={12} />
        </button>

        <form
          class="relative min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go(normalize(draft()));
          }}
        >
          <Globe
            size={11}
            class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            class="w-full rounded-cx border border-line bg-fill-1 py-1.5 pl-7 pr-7 font-mono text-[11.5px] text-ink outline-none transition placeholder:text-faint focus:border-accent focus:bg-fill-2"
            placeholder="localhost:5173 · 3000 · https://…"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
          <Show when={draft()}>
            <button
              type="button"
              class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-faint transition hover:text-ink"
              onClick={() => setDraft("")}
              title="limpar"
            >
              <X size={11} />
            </button>
          </Show>
        </form>

        <button
          class="rounded-cx p-1.5 text-faint transition hover:bg-fill-2 hover:text-ink disabled:opacity-30"
          disabled={!url()}
          onClick={() => invoke("open_external", { url: url() }).catch(console.error)}
          title="abrir no navegador do sistema"
        >
          <ExternalLink size={12} />
        </button>
      </div>

      <div class="flex shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2.5 py-1.5">
        <span class="shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint">
          servindo
        </span>
        <Show
          when={live().length > 0}
          fallback={
            <span class="text-[10.5px] text-faint">
              nenhuma porta local respondendo
            </span>
          }
        >
          <For each={live()}>
            {(port) => {
              const target = () => `http://localhost:${port}`;
              const active = () => url().startsWith(target());
              return (
                <button
                  class="rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition"
                  classList={{
                    "border-accent bg-accent-soft text-ink": active(),
                    "border-line text-dim hover:border-line-strong hover:text-ink":
                      !active(),
                  }}
                  onClick={() => go(target())}
                >
                  :{port}
                </button>
              );
            }}
          </For>
        </Show>
      </div>

      <Show
        when={url()}
        fallback={
          <div class="flex flex-1 flex-col items-center justify-center gap-2 text-faint">
            <Globe size={22} class="text-dim" />
            <p class="text-[12.5px] text-dim">preview do dev server</p>
            <p class="max-w-[26rem] text-center text-[11px] leading-relaxed">
              digite uma porta e enter. sites que recusam iframe não pintam
              aqui — use ↗ para abrir fora.
            </p>
          </div>
        }
      >
        <iframe
          ref={frame}
          src={url()}
          class="min-h-0 flex-1 border-0 bg-float"
          referrerpolicy="no-referrer"
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
        />
      </Show>
    </div>
  );
}
