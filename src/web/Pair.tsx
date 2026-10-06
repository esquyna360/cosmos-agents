import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ArrowRight, Lock, MonitorSmartphone } from "lucide-solid";

type PairFailure =
  | { error: "no_code" }
  | { error: "wrong"; left: number }
  | { error: "burned" }
  | { error: "locked"; retry_in: number };

/** A name the desk will recognise in its list of devices. */
function guessName(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "Navegador";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return browser ? `${device} · ${browser}` : device;
}

function wait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)} min`;
}

export default function Pair(props: { version?: string }) {
  const [code, setCode] = createSignal("");
  const [name, setName] = createSignal(guessName());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [shake, setShake] = createSignal(false);
  const [locked, setLocked] = createSignal(0);
  const [focused, setFocused] = createSignal(false);
  let input!: HTMLInputElement;
  let timer = 0;

  onMount(() => {
    input.focus();
    timer = window.setInterval(() => setLocked((s) => Math.max(0, s - 1)), 1000);
  });
  onCleanup(() => clearInterval(timer));

  function fail(message: string) {
    setError(message);
    setCode("");
    setShake(true);
    window.setTimeout(() => setShake(false), 420);
    input.focus();
  }

  async function submit() {
    if (busy() || locked() > 0 || code().length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pair", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-cosmos": "1" },
        body: JSON.stringify({ code: code(), name: name().trim() }),
      });
      if (res.ok) {
        location.reload();
        return;
      }
      const why = (await res.json().catch(() => null)) as PairFailure | null;
      if (why?.error === "wrong") {
        fail(why.left === 1 ? "Código errado. Resta 1 tentativa." : `Código errado. Restam ${why.left} tentativas.`);
      } else if (why?.error === "burned") {
        fail("Esse código foi cancelado por excesso de erros. Gere outro no Cosmos.");
      } else if (why?.error === "locked") {
        setLocked(why.retry_in);
        fail("Muitas tentativas erradas.");
      } else if (why?.error === "no_code") {
        fail("Não há código valendo agora. Gere um no Cosmos do computador.");
      } else {
        fail("O Cosmos recusou o pedido. Recarregue a página e tente de novo.");
      }
    } catch {
      fail("Sem resposta do Cosmos. Confira se o computador está ligado e na rede.");
    } finally {
      setBusy(false);
    }
  }

  function type(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length) setError(null);
    if (digits.length === 6) void submit();
  }

  return (
    <div class="cx-pair">
      <div class="cx-pair-glow" aria-hidden="true" />
      <form
        class="cx-pair-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <span class="cx-pair-mark">
          <MonitorSmartphone size={22} strokeWidth={1.6} />
        </span>
        <h1 class="font-heading text-[26px] leading-tight text-ink">Parear este navegador</h1>
        <p class="mt-2 text-[13.5px] leading-relaxed text-dim">
          No Cosmos do seu computador, abra <b class="font-medium text-ink">Ajustes › Acesso remoto</b> e toque em{" "}
          <b class="font-medium text-ink">Parear dispositivo</b>. Digite aqui o código que aparecer.
        </p>

        <label
          class="cx-pair-code"
          data-shake={shake()}
          data-off={locked() > 0}
          onClick={() => input.focus()}
        >
          <input
            ref={input}
            class="cx-pair-input"
            aria-label="Código de pareamento"
            inputmode="numeric"
            pattern="[0-9]*"
            autocomplete="one-time-code"
            maxLength={6}
            value={code()}
            disabled={locked() > 0}
            onInput={(e) => type(e.currentTarget.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
          <For each={[0, 1, 2, 3, 4, 5]}>
            {(i) => (
              <span
                class="cx-pair-cell"
                data-on={focused() && locked() === 0 && i === Math.min(code().length, 5)}
                data-filled={i < code().length}
                classList={{ "ml-2.5": i === 3 }}
              >
                {code()[i] ?? ""}
              </span>
            )}
          </For>
        </label>

        <div class="mt-3 min-h-[20px] text-[12.5px]" role="status" aria-live="polite">
          <Show
            when={locked() > 0}
            fallback={
              <Show when={error()}>
                <span class="text-alert">{error()}</span>
              </Show>
            }
          >
            <span class="text-alert">Muitas tentativas erradas. Tente de novo em {wait(locked())}.</span>
          </Show>
        </div>

        <label class="mt-4 block text-left">
          <span class="mb-1.5 block text-[11.5px] text-faint">Como este dispositivo aparece na lista</span>
          <input
            class="cx-pair-name"
            value={name()}
            maxLength={40}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </label>

        <button class="cx-btn-primary mt-5 !h-[40px] w-full !text-[14.5px]" disabled={busy() || locked() > 0 || code().length !== 6}>
          {busy() ? "Pareando…" : "Entrar"}
          <Show when={!busy()}>
            <ArrowRight size={15} />
          </Show>
        </button>

        <p class="mt-5 flex items-center justify-center gap-1.5 text-[11.5px] text-faint">
          <Lock size={11} />
          O código vale 5 minutos e serve uma vez só.
        </p>
      </form>
      <Show when={props.version}>
        <span class="cx-pair-foot">Cosmos {props.version}</span>
      </Show>
    </div>
  );
}
