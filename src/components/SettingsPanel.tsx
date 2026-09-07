import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  Check,
  Copy,
  Globe,
  Keyboard,
  Loader2,
  Palette,
  RefreshCw,
  X,
} from "lucide-solid";

import { setSettingsOpen } from "../stores/layout";
import { applyTheme, theme, THEMES } from "../stores/theme";
import {
  autoCheck,
  autoInstall,
  checkNow,
  currentVersion,
  lastChecked,
  phase,
  setAutoCheck,
  setAutoInstall,
} from "../stores/updates";
import {
  remoteConfigGet,
  remoteConfigSet,
  webInfo,
  type RemoteConfigView,
  type WebInfo,
} from "../lib/remote";

type Tab = "aparencia" | "atalhos" | "remoto" | "updates";

const TABS: { id: Tab; label: string }[] = [
  { id: "aparencia", label: "aparência" },
  { id: "atalhos", label: "atalhos" },
  { id: "remoto", label: "remoto" },
  { id: "updates", label: "updates" },
];

export default function SettingsPanel() {
  const [tab, setTab] = createSignal<Tab>("aparencia");

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  return (
    <div
      class="fixed inset-0 z-50 flex items-start justify-center bg-sunken p-10 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) setSettingsOpen(false);
      }}
    >
      <div class="cx-glass cx-sheet flex max-h-full w-[34rem] flex-col overflow-hidden rounded-cx-lg border border-line">
        <header class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <h2 class="text-[13.5px] font-semibold">Configurações</h2>
          <div class="ml-auto flex items-center gap-0.5 rounded-cx border border-line bg-fill-1 p-0.5">
            <For each={TABS}>
              {(t) => (
                <button
                  class="rounded-[7px] px-2.5 py-1 text-[11.5px] text-faint transition hover:text-ink"
                  classList={{ "bg-fill-3 text-ink": tab() === t.id }}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              )}
            </For>
          </div>
          <button
            class="rounded p-1 text-faint transition hover:bg-fill-2 hover:text-ink"
            onClick={() => setSettingsOpen(false)}
            title="fechar (esc)"
          >
            <X size={13} />
          </button>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto p-4">
          <Show when={tab() === "aparencia"}>
            <ThemeSection />
          </Show>
          <Show when={tab() === "atalhos"}>
            <ShortcutsSection />
          </Show>
          <Show when={tab() === "remoto"}>
            <RemoteSection />
          </Show>
          <Show when={tab() === "updates"}>
            <UpdatesSection />
          </Show>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- aparência ------------------------------ */

function ThemeSection() {
  return (
    <section class="flex flex-col gap-3">
      <SectionTitle icon={Palette} title="tema" hint="⌘⇧T cicla" />
      <div class="grid grid-cols-2 gap-2">
        <For each={THEMES}>
          {(t) => {
            const active = () => theme() === t.id;
            return (
              <button
                class="flex items-center gap-2.5 rounded-cx border p-2.5 text-left transition"
                classList={{
                  "border-accent bg-accent-soft": active(),
                  "border-line hover:border-line-strong hover:bg-fill-1": !active(),
                }}
                onClick={() => applyTheme(t.id)}
              >
                <span
                  class="h-8 w-8 shrink-0 overflow-hidden rounded-[7px] border border-line"
                  style={{ background: t.swatch[0] }}
                >
                  <span
                    class="block h-full w-1/2"
                    style={{ background: t.swatch[1] }}
                  />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate text-[12.5px] font-medium">
                      {t.label}
                    </span>
                    <Show when={active()}>
                      <Check size={11} class="shrink-0 text-accent" />
                    </Show>
                  </span>
                  <span class="block truncate text-[10.5px] text-faint">
                    {t.hint}
                  </span>
                </span>
              </button>
            );
          }}
        </For>
      </div>
      <p class="text-[11px] leading-relaxed text-faint">
        O tema alcança tudo — barras, editor e terminal leem as mesmas
        variáveis.
      </p>
    </section>
  );
}

/* ------------------------------- atalhos -------------------------------- */

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "janela",
    items: [
      ["⌘B", "mostrar/ocultar projetos"],
      ["⌘,", "configurações"],
      ["⌘⇧T", "próximo tema"],
      ["⌘D", "workflow"],
      ["⌘E", "ciclar view"],
      ["⌘I", "mostrar/ocultar composer"],
    ],
  },
  {
    title: "painéis",
    items: [
      ["⌘\\", "dividir em dois"],
      ["⌘⌥1–5", "layout do grid"],
      ["⌃1–4", "focar painel"],
      ["⌘1–9", "trocar de projeto"],
    ],
  },
  {
    title: "runners",
    items: [
      ["⌘T", "novo projeto"],
      ["⌘⇧N", "novo agente"],
      ["⌘W", "parar o runner focado"],
      ["⌘⇧W", "parar o projeto inteiro"],
    ],
  },
  {
    title: "código",
    items: [
      ["⌘P", "abrir arquivo por nome"],
      ["⌘⇧F", "buscar no projeto"],
      ["⌘F", "buscar no arquivo"],
      ["⌘S", "salvar agora"],
    ],
  },
];

function ShortcutsSection() {
  return (
    <section class="flex flex-col gap-4">
      <SectionTitle
        icon={Keyboard}
        title="atalhos"
        hint="arrastar reordena a sidebar"
      />
      <For each={GROUPS}>
        {(g) => (
          <div class="flex flex-col gap-1">
            <h4 class="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
              {g.title}
            </h4>
            <For each={g.items}>
              {([keys, what]) => (
                <div class="flex items-baseline gap-3 rounded-cx px-1 py-[3px] text-[12px]">
                  <kbd class="w-[74px] shrink-0 rounded border border-line bg-fill-1 px-1.5 py-0.5 text-center font-mono text-[10.5px] text-dim">
                    {keys}
                  </kbd>
                  <span class="text-dim">{what}</span>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </section>
  );
}

/* -------------------------------- remoto -------------------------------- */

function RemoteSection() {
  const [cfg, setCfg] = createSignal<RemoteConfigView | null>(null);
  const [info, setInfo] = createSignal<WebInfo | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);

  const refresh = () => {
    remoteConfigGet().then(setCfg).catch(() => {});
    webInfo().then(setInfo).catch(() => setInfo(null));
  };

  onMount(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    onCleanup(() => clearInterval(t));
  });

  async function patch(next: Partial<RemoteConfigView>, restartNote?: string) {
    const c = cfg();
    if (!c) return;
    const merged = { ...c, ...next };
    setCfg(merged);
    setBusy(true);
    try {
      const {
        // Runtime-only fields the backend doesn't accept back.
        tunnel_running: _r,
        cloudflared_present: _p,
        ...stored
      } = merged;
      await remoteConfigSet(stored);
      setNote(restartNote ?? null);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const link = () => info()?.link || info()?.local || null;

  return (
    <section class="flex flex-col gap-3">
      <SectionTitle icon={Globe} title="acesso remoto" hint="web UI + túnel" />

      <Show when={cfg()} fallback={<Muted>carregando…</Muted>} keyed>
        {(c) => (
          <>
            <Toggle
              label="web UI"
              hint="servidor local em 127.0.0.1 — vale no próximo start"
              checked={c.enabled}
              disabled={busy()}
              onChange={(v) =>
                patch({ enabled: v }, "o servidor só liga/desliga ao reabrir o Cosmos")
              }
            />

            <Toggle
              label="túnel Cloudflare"
              hint={
                c.cloudflared_present
                  ? "expõe a web UI numa URL pública — aplica na hora"
                  : "cloudflared não encontrado nesta máquina"
              }
              checked={c.tunnel}
              disabled={busy() || !c.cloudflared_present}
              onChange={(v) => patch({ tunnel: v })}
            />

            <Toggle
              label="avisar no Telegram"
              hint="manda a URL nova toda vez que o túnel reconecta"
              checked={c.telegram_notify}
              disabled={busy()}
              onChange={(v) => patch({ telegram_notify: v })}
            />

            <div class="flex items-center gap-2 rounded-cx border border-line bg-fill-1 px-2.5 py-2">
              <span
                class="h-1.5 w-1.5 shrink-0 rounded-full"
                classList={{
                  "bg-live": c.tunnel_running,
                  "bg-faint": !c.tunnel_running,
                }}
              />
              <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-dim">
                {link() ?? "web UI desligada"}
              </span>
              <button
                class="shrink-0 rounded p-1 text-faint transition hover:bg-fill-2 hover:text-ink disabled:opacity-40"
                disabled={!link()}
                title="copiar link"
                onClick={() => {
                  const u = link();
                  if (!u) return;
                  navigator.clipboard.writeText(u).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied() ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>

            <Show when={note()}>
              <p class="text-[11px] leading-relaxed text-busy">{note()}</p>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

/* ------------------------------- updates -------------------------------- */

function UpdatesSection() {
  const checking = () => phase() === "checking";
  const when = () => {
    const t = lastChecked();
    if (!t) return "ainda não checou";
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return "agora há pouco";
    if (mins < 60) return `há ${mins} min`;
    return `há ${Math.round(mins / 60)} h`;
  };

  return (
    <section class="flex flex-col gap-3">
      <SectionTitle
        icon={RefreshCw}
        title="atualizações"
        hint={currentVersion() ? `v${currentVersion()}` : ""}
      />

      <Toggle
        label="procurar sozinho"
        hint="na abertura e a cada 6 h, em Mac e Windows"
        checked={autoCheck()}
        onChange={setAutoCheck}
      />

      <Toggle
        label="instalar sozinho quando nada estiver rodando"
        hint="instalar reinicia o app; com agente vivo ele espera e só avisa"
        checked={autoInstall()}
        onChange={setAutoInstall}
      />

      <div class="flex items-center gap-2">
        <button
          class="flex items-center gap-1.5 rounded-cx border border-line px-3 py-1.5 text-[11.5px] text-ink transition hover:border-line-strong hover:bg-fill-1 disabled:opacity-50"
          disabled={checking()}
          onClick={() => checkNow(true)}
        >
          <Show when={checking()} fallback={<RefreshCw size={12} />}>
            <Loader2 size={12} class="animate-spin" />
          </Show>
          procurar agora
        </button>
        <span class="text-[11px] text-faint">checado {when()}</span>
      </div>

      <Show when={phase() === "idle" && lastChecked()}>
        <Muted>Está na versão mais nova.</Muted>
      </Show>
    </section>
  );
}

/* ------------------------------ primitives ------------------------------ */

function SectionTitle(props: {
  icon: typeof Palette;
  title: string;
  hint?: string;
}) {
  return (
    <div class="flex items-baseline gap-2">
      <props.icon size={12} class="translate-y-px text-faint" />
      <h3 class="text-[11px] font-semibold uppercase tracking-[0.13em] text-dim">
        {props.title}
      </h3>
      <Show when={props.hint}>
        <span class="ml-auto text-[10.5px] text-faint">{props.hint}</span>
      </Show>
    </div>
  );
}

function Muted(props: { children: string }) {
  return <p class="text-[11.5px] text-faint">{props.children}</p>;
}

function Toggle(props: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      class="flex items-start gap-3 rounded-cx border border-line px-2.5 py-2 text-left transition hover:border-line-strong disabled:opacity-50"
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span
        class="mt-0.5 flex h-[15px] w-[26px] shrink-0 items-center rounded-full p-[2px] transition"
        classList={{
          "bg-accent": props.checked,
          "bg-fill-3": !props.checked,
        }}
      >
        <span
          class="h-[11px] w-[11px] rounded-full bg-float shadow-cx transition-transform"
          style={{
            transform: props.checked ? "translateX(11px)" : "none",
            background: props.checked ? "var(--accent-ink)" : "var(--text-dim)",
          }}
        />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block text-[12.5px] leading-tight">{props.label}</span>
        <Show when={props.hint}>
          <span class="mt-0.5 block text-[10.5px] leading-snug text-faint">
            {props.hint}
          </span>
        </Show>
      </span>
    </button>
  );
}
