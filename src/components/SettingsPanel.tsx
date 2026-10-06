import { navChildren, navLabel, navMode, setNavChildren, setNavLabel, setNavMode } from "../stores/nav";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  Check,
  Copy,
  Globe,
  Keyboard,
  Loader2,
  LogOut,
  Monitor,
  MonitorSmartphone,
  Palette,
  RefreshCw,
  Smartphone,
  X,
} from "lucide-solid";
import { listen } from "@tauri-apps/api/event";

import { isWeb } from "../lib/platform";

import { setSettingsOpen } from "../stores/layout";
import { applyTheme, theme, themePref, THEMES } from "../stores/theme";
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
  webDeviceRevoke,
  webDevices,
  webInfo,
  webPairCancel,
  webPairCurrent,
  webPairStart,
  type PairCode,
  type RemoteConfigView,
  type WebDevice,
  type WebInfo,
} from "../lib/remote";

type Tab = "aparencia" | "atalhos" | "remoto" | "updates";

const TABS: { id: Tab; label: string }[] = [
  { id: "aparencia", label: "aparência" },
  { id: "atalhos", label: "atalhos" },
  { id: "remoto", label: "remoto" },
  // A browser runs whatever the computer is running.
  ...(isWeb ? [] : [{ id: "updates" as Tab, label: "updates" }]),
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
      class="fixed inset-0 z-50 flex items-start justify-center bg-sunken p-10 backdrop-blur-[2px] max-[760px]:p-3"
      onClick={(e) => {
        if (e.target === e.currentTarget) setSettingsOpen(false);
      }}
    >
      <div class="cx-glass cx-sheet flex max-h-full w-[34rem] max-w-full flex-col overflow-hidden rounded-cx-lg border border-line">
        <header class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
          <h2 class="text-[13.5px] font-semibold max-[760px]:hidden">Configurações</h2>
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
            <NavSection />
            <ThemeSection />
          </Show>
          <Show when={tab() === "atalhos"}>
            <ShortcutsSection />
          </Show>
          <Show when={tab() === "remoto"}>
            <Show when={isWeb} fallback={<RemoteSection />}>
              <WebSessionSection />
            </Show>
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

function NavSection() {
  const Pick = (props: { on: boolean; label: string; onClick: () => void }) => (
    <button class="cx-pill cx-pill-line" data-on={props.on} onClick={props.onClick}>
      {props.label}
    </button>
  );
  return (
    <section class="mb-6 flex flex-col gap-2.5">
      <SectionTitle icon={Palette} title="navegação" hint="⌘B recolhe a barra" />
      <div class="flex flex-wrap gap-1.5">
        <Pick on={navMode() === "sidebar"} label="Barra lateral" onClick={() => setNavMode("sidebar")} />
        <Pick on={navMode() === "tabs"} label="Abas no topo" onClick={() => setNavMode("tabs")} />
      </div>
      <div class="flex flex-wrap gap-1.5">
        <Pick on={navLabel() === "name"} label="Nome do projeto" onClick={() => setNavLabel("name")} />
        <Pick on={navLabel() === "path"} label="Caminho completo" onClick={() => setNavLabel("path")} />
      </div>
      <div class="flex flex-wrap gap-1.5">
        <Pick on={navChildren() === "none"} label="Só projetos" onClick={() => setNavChildren("none")} />
        <Pick on={navChildren() === "agents"} label="Com agentes" onClick={() => setNavChildren("agents")} />
        <Pick on={navChildren() === "all"} label="Com agentes e terminais" onClick={() => setNavChildren("all")} />
      </div>
    </section>
  );
}

function ThemeSection() {
  return (
    <section class="flex flex-col gap-3">
      <SectionTitle icon={Palette} title="tema" hint="⌘⇧T alterna claro e escuro" />
      <button
        class="flex items-center justify-between rounded-cx border p-2.5 text-left text-[12.5px] transition"
        classList={{
          "border-accent bg-accent-soft": themePref() === "system",
          "border-line hover:border-line-strong hover:bg-fill-1": themePref() !== "system",
        }}
        onClick={() => applyTheme("system")}
      >
        <span>
          <span class="block font-medium">Seguir o sistema</span>
          <span class="block text-[10.5px] text-faint">Claro de dia, escuro à noite, conforme o macOS</span>
        </span>
        <Show when={themePref() === "system"}>
          <Check size={11} class="shrink-0 text-accent" />
        </Show>
      </button>
      <div class="grid grid-cols-2 gap-2">
        <For each={THEMES}>
          {(t) => {
            const active = () => themePref() !== "system" && theme() === t.id;
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
      ["⌘0", "início"],
      ["⌘B", "recolher ou fixar a barra lateral"],
      ["⌘⇧H", "Hub"],
      ["⌘N", "novo agente"],
      ["⌘,", "configurações"],
      ["⌘⇧T", "próximo tema"],
      ["⌘E", "arquivos, mudanças, memória do projeto"],
      ["⌘I", "mostrar/ocultar composer"],
    ],
  },
  {
    title: "projetos",
    items: [
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

  const up = () => Boolean(info()?.port);

  return (
    <section class="flex flex-col gap-3">
      <SectionTitle icon={Globe} title="acesso remoto" hint="o Cosmos no navegador" />

      <Show when={cfg()} fallback={<Muted>carregando…</Muted>} keyed>
        {(c) => (
          <>
            <Show when={up()}>
              <PairBox />
              <div class="flex flex-col gap-1.5">
                <Show when={info()?.tunnel}>
                  {(url) => <Address label="de qualquer lugar" url={url()} live />}
                </Show>
                <Show when={info()?.lan}>{(url) => <Address label="na sua rede" url={url()} />}</Show>
                <Show when={!info()?.tunnel && !info()?.lan && info()?.local}>
                  {(url) => <Address label="só neste computador" url={url()} />}
                </Show>
              </div>
              <DeviceList />
            </Show>

            <div class="mt-1 flex flex-col gap-2">
              <Toggle
                label="servir o Cosmos no navegador"
                hint="vale ao reabrir o Cosmos"
                checked={c.enabled}
                disabled={busy()}
                onChange={(v) => patch({ enabled: v }, "o servidor só liga ou desliga ao reabrir o Cosmos")}
              />
              <Toggle
                label="rede local"
                hint="celular e outros computadores no mesmo Wi-Fi — vale ao reabrir"
                checked={c.lan}
                disabled={busy()}
                onChange={(v) => patch({ lan: v }, "a rede local só liga ou desliga ao reabrir o Cosmos")}
              />
              <Toggle
                label="túnel Cloudflare"
                hint={
                  c.cloudflared_present
                    ? "um endereço público que funciona fora de casa — aplica na hora"
                    : "cloudflared não encontrado nesta máquina"
                }
                checked={c.tunnel}
                disabled={busy() || !c.cloudflared_present}
                onChange={(v) => patch({ tunnel: v })}
              />
              <Toggle
                label="avisar no Telegram"
                hint="manda o endereço novo toda vez que o túnel reconecta"
                checked={c.telegram_notify}
                disabled={busy()}
                onChange={(v) => patch({ telegram_notify: v })}
              />
            </div>

            <Show when={note()}>
              <p class="text-[11px] leading-relaxed text-busy">{note()}</p>
            </Show>
            <p class="text-[11px] leading-relaxed text-faint">
              O endereço sozinho não abre nada: cada navegador entra com um código mostrado aqui e pode ser
              desligado da lista a qualquer momento.
            </p>
          </>
        )}
      </Show>
    </section>
  );
}

function Address(props: { label: string; url: string; live?: boolean }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="flex items-center gap-2 rounded-cx border border-line bg-fill-1 px-2.5 py-2">
      <span class="h-1.5 w-1.5 shrink-0 rounded-full" classList={{ "bg-live": props.live, "bg-faint": !props.live }} />
      <span class="w-[104px] shrink-0 text-[11px] text-faint">{props.label}</span>
      <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-dim">{props.url}</span>
      <button
        class="shrink-0 rounded p-1 text-faint transition hover:bg-fill-2 hover:text-ink"
        title="copiar endereço"
        onClick={() =>
          navigator.clipboard.writeText(props.url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied() ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

/** The code a new browser types. It is shown only on request, counts down,
 *  and leaves the screen the moment someone uses it. */
function PairBox() {
  const [code, setCode] = createSignal<PairCode | null>(null);
  const [now, setNow] = createSignal(Date.now() / 1000);
  const [joined, setJoined] = createSignal<string | null>(null);
  const left = () => Math.max(0, Math.round((code()?.expires ?? 0) - now()));

  onMount(() => {
    webPairCurrent().then(setCode).catch(() => {});
    const t = setInterval(() => {
      setNow(Date.now() / 1000);
      if (code() && left() === 0) setCode(null);
    }, 1000);
    const off = listen<{ paired?: WebDevice }>("web-devices-changed", (e) => {
      if (!e.payload?.paired) return;
      setCode(null);
      setJoined(e.payload.paired.name);
      setTimeout(() => setJoined(null), 6000);
    });
    onCleanup(() => {
      clearInterval(t);
      off.then((u) => u());
    });
  });

  const start = () => {
    setJoined(null);
    setNow(Date.now() / 1000);
    webPairStart().then(setCode).catch(() => {});
  };
  const cancel = () => {
    setCode(null);
    webPairCancel().catch(() => {});
  };
  const clock = () => `${Math.floor(left() / 60)}:${String(left() % 60).padStart(2, "0")}`;

  return (
    <div class="cx-pairbox" data-on={Boolean(code())}>
      <Show
        when={code()}
        fallback={
          <div class="flex items-center gap-3">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-accent-soft text-accent">
              <MonitorSmartphone size={17} strokeWidth={1.7} />
            </span>
            <span class="min-w-0 flex-1">
              <Show
                when={joined()}
                fallback={
                  <>
                    <span class="block text-[12.5px] font-medium">Parear dispositivo</span>
                    <span class="block text-[11px] text-faint">Mostra um código de 6 dígitos que vale 5 minutos</span>
                  </>
                }
              >
                <span class="flex items-center gap-1.5 text-[12.5px] font-medium text-live">
                  <Check size={13} />
                  {joined()} entrou
                </span>
                <span class="block text-[11px] text-faint">Já aparece na lista abaixo</span>
              </Show>
            </span>
            <button class="cx-btn-primary !h-[28px] !px-3 !text-[12px]" onClick={start}>
              Gerar código
            </button>
          </div>
        }
      >
        {(c) => (
          <div class="flex flex-col items-center gap-2 py-1">
            <span class="text-[11px] text-faint">Digite no navegador que quer entrar</span>
            <span class="cx-pairbox-code" aria-label={`Código ${c().code.split("").join(" ")}`}>
              <For each={c().code.split("")}>
                {(d, i) => <span classList={{ "ml-2.5": i() === 3 }}>{d}</span>}
              </For>
            </span>
            <span class="cx-pairbox-bar">
              <span style={{ width: `${(left() / 300) * 100}%` }} />
            </span>
            <span class="flex items-center gap-3 text-[11px] text-faint">
              <span class="tabular-nums">vale por {clock()}</span>
              <button class="underline-offset-2 hover:text-ink hover:underline" onClick={start}>
                gerar outro
              </button>
              <button class="underline-offset-2 hover:text-ink hover:underline" onClick={cancel}>
                cancelar
              </button>
            </span>
          </div>
        )}
      </Show>
    </div>
  );
}

function seenAgo(unix: number): string {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - unix) / 60));
  if (mins < 15) return "ativo agora";
  if (mins < 60) return `visto há ${mins} min`;
  if (mins < 60 * 24) return `visto há ${Math.round(mins / 60)} h`;
  return `visto há ${Math.round(mins / (60 * 24))} d`;
}

function DeviceList() {
  const [devices, setDevices] = createSignal<WebDevice[] | null>(null);
  const refresh = () => webDevices().then(setDevices).catch(() => {});

  onMount(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    const off = listen("web-devices-changed", refresh);
    onCleanup(() => {
      clearInterval(t);
      off.then((u) => u());
    });
  });

  return (
    <div class="flex flex-col gap-1.5">
      <span class="text-[11px] text-faint">
        {devices()?.length ? "Navegadores com acesso" : "Nenhum navegador tem acesso ainda"}
      </span>
      <For each={devices() ?? []}>
        {(d) => (
          <div class="group flex items-center gap-2.5 rounded-cx border border-line px-2.5 py-2">
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-fill-2 text-dim">
              {/iPhone|iPad|Android/.test(d.agent) ? <Smartphone size={14} /> : <Monitor size={14} />}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[12.5px] font-medium">{d.name}</span>
              <span class="block truncate text-[10.5px] text-faint">
                {seenAgo(d.lastSeen)} · {d.address}
              </span>
            </span>
            <button
              class="cx-pill !h-[24px] !px-2.5 !text-[11.5px] text-faint hover:!bg-alert-soft hover:!text-alert"
              title="Encerrar a sessão deste navegador"
              onClick={() => webDeviceRevoke(d.id).then(refresh)}
            >
              Desligar
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

/** In a browser there is no desk to manage: only this session to end. */
function WebSessionSection() {
  const [device, setDevice] = createSignal<WebDevice | null>(null);
  onMount(() => {
    fetch("/api/session", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((s) => setDevice(s.device ?? null))
      .catch(() => {});
  });
  return (
    <section class="flex flex-col gap-3">
      <SectionTitle icon={Globe} title="este navegador" hint="acesso remoto" />
      <div class="flex items-center gap-2.5 rounded-cx border border-line px-2.5 py-2.5">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-live-soft text-live">
          <MonitorSmartphone size={15} />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[12.5px] font-medium">{device()?.name ?? "Pareado"}</span>
          <span class="block text-[10.5px] text-faint">
            A sessão dura 30 dias sem uso e pode ser desligada no Cosmos do computador
          </span>
        </span>
        <button
          class="cx-pill cx-pill-line !h-[26px] !text-[12px]"
          onClick={() => import("../web/bridge").then((m) => m.signOut())}
        >
          <LogOut size={12} />
          Sair
        </button>
      </div>
      <p class="text-[11px] leading-relaxed text-faint">
        Parear outros dispositivos e ligar ou desligar o acesso remoto se faz no Cosmos do computador, em Ajustes ›
        Acesso remoto.
      </p>
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
