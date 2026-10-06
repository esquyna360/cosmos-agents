import { batch, createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Archive, ArrowUp, ExternalLink, GitBranch, LayoutGrid, Minus, Plus, Scan, Waypoints, X } from "lucide-solid";

import {
  findRunner,
  focusProject,
  focusRunner,
  isMasterProject,
  isStale,
  masterRunner,
  projectsStore,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import {
  autoLayout,
  CARD_H,
  CARD_W,
  HEAD,
  hasSavedView,
  K_FAR,
  K_MAX,
  K_MIN,
  PAD,
  place,
  placed,
  savePlaced,
  setShowStale,
  setView,
  showStale,
  tidy,
  view,
  type Point,
  type View,
} from "../stores/canvas";
import { fmtCost, fmtTokens, prettyModel, vitalsOf, watchVitals } from "../stores/vitals";
import { ensureModels, modelLabel } from "../stores/models";
import { branchOf } from "../stores/git";
import { ptyScreens, type Run, type Snapshot } from "../lib/canvas";
import { runnerSend } from "../lib/hub";
import { relativeTime } from "../lib/time";
import { shortPath } from "../lib/toolDisplay";
import StatusGlyph, { glyphFor, needsYou, stateOf, TONE_TEXT } from "../ui/StatusGlyph";
import { RunnerIcon } from "../ui/EntityIcon";
import { openMenu } from "../ui/Menu";
import { runnerMenu } from "./menus";
import { SessionBody } from "./SessionView";

const MINI_ROWS = 10;
const POLL_MS = 900;

const ANSI = [
  "var(--term-black)",
  "var(--term-red)",
  "var(--term-green)",
  "var(--term-yellow)",
  "var(--term-blue)",
  "var(--term-magenta)",
  "var(--term-cyan)",
  "var(--term-white)",
  "var(--text-faint)",
  "var(--term-red)",
  "var(--term-green)",
  "var(--term-yellow)",
  "var(--term-blue)",
  "var(--term-magenta)",
  "var(--term-cyan)",
  "var(--term-fg)",
];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** Terminal rows as markup. One `innerHTML` per change is far cheaper than
 *  a reactive node per cell, and dozens of these repaint every second. */
function paint(lines: Run[][]): string {
  return lines
    .map((line) =>
      line
        .map((run) => {
          const color = run.c ? (run.c[0] === "#" ? run.c : ANSI[Number(run.c)]) : "";
          const style = `${color ? `color:${color};` : ""}${run.b ? "font-weight:600;" : ""}${run.d ? "opacity:.6;" : ""}`;
          return style ? `<span style="${style}">${esc(run.t)}</span>` : esc(run.t);
        })
        .join(""),
    )
    .join("\n");
}

interface Found {
  project: ProjectUI;
  runner: RunnerUI;
}

/** Every agent and terminal as a live card on one endless board, with a line
 *  from whoever delegated to whoever got the work. */
export default function CanvasView() {
  let board!: HTMLDivElement;
  let layer!: HTMLDivElement;

  const [size, setSize] = createSignal({ w: 0, h: 0 });
  const [panning, setPanning] = createSignal(false);
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal<{ id: string; from: DOMRect } | null>(null);
  const [pinged, setPinged] = createSignal(false);
  const [screens, setScreens] = createStore<Record<string, Snapshot>>({});
  const seen: Record<string, number> = {};

  const hubId = () => masterRunner()?.id ?? null;
  const keep = (r: RunnerUI) => (r.kind === "agent" || r.live) && (r.live || showStale() || !isStale(r));
  const groups = createMemo(() =>
    projectsStore.list
      .filter((p) => !isMasterProject(p))
      .map((p) => ({ project: p, ids: p.runners.filter(keep).map((r) => r.id) }))
      .filter((g) => g.ids.length > 0),
  );
  const hidden = createMemo(
    () =>
      projectsStore.list
        .filter((p) => !isMasterProject(p))
        .flatMap((p) => p.runners)
        .filter((r) => r.kind === "agent" && !r.live && isStale(r)).length,
  );
  const ids = createMemo(() => [...(hubId() ? [hubId()!] : []), ...groups().flatMap((g) => g.ids)]);
  const auto = createMemo(() => autoLayout(hubId(), groups()));
  const at = (id: string): Point => placed[id] ?? auto()[id] ?? { x: 0, y: 0 };
  const far = createMemo(() => view().k < K_FAR);

  const visible = createMemo(() => {
    const v = view();
    const s = size();
    const out = new Set<string>();
    for (const id of ids()) {
      const p = at(id);
      const x = p.x * v.k + v.x;
      const y = p.y * v.k + v.y;
      if (x < s.w + 300 && x + CARD_W * v.k > -300 && y < s.h + 300 && y + CARD_H * v.k > -300) out.add(id);
    }
    return out;
  });

  const frames = createMemo(() =>
    groups().map((g) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const id of g.ids) {
        const p = at(id);
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      return {
        project: g.project,
        count: g.ids.length,
        x: x0 - PAD,
        y: y0 - HEAD,
        w: x1 - x0 + CARD_W + 2 * PAD,
        h: y1 - y0 + CARD_H + HEAD + PAD,
      };
    }),
  );

  const edges = createMemo(() => {
    const have = new Set(ids());
    const out: { d: string; x: number; y: number; tone: string }[] = [];
    for (const id of ids()) {
      const child = findRunner(id)?.runner;
      if (!child?.parentId || !have.has(child.parentId)) continue;
      const a = at(child.parentId);
      const b = at(id);
      let p1: Point;
      let p2: Point;
      let c1: Point;
      let c2: Point;
      if (b.x >= a.x + CARD_W * 0.6 || b.x + CARD_W * 0.6 <= a.x) {
        const fwd = b.x > a.x;
        p1 = { x: a.x + (fwd ? CARD_W : 0), y: a.y + CARD_H / 2 };
        p2 = { x: b.x + (fwd ? 0 : CARD_W), y: b.y + CARD_H / 2 };
        const bend = Math.max(60, Math.abs(p2.x - p1.x) / 2) * (fwd ? 1 : -1);
        c1 = { x: p1.x + bend, y: p1.y };
        c2 = { x: p2.x - bend, y: p2.y };
      } else {
        const down = b.y > a.y;
        p1 = { x: a.x + CARD_W / 2, y: a.y + (down ? CARD_H : 0) };
        p2 = { x: b.x + CARD_W / 2, y: b.y + (down ? 0 : CARD_H) };
        const bend = Math.max(50, Math.abs(p2.y - p1.y) / 2) * (down ? 1 : -1);
        c1 = { x: p1.x, y: p1.y + bend };
        c2 = { x: p2.x, y: p2.y - bend };
      }
      const g = glyphFor(child);
      out.push({
        d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`,
        x: p2.x,
        y: p2.y,
        tone: g === "working" ? "working" : g === "awaiting" ? "awaiting" : "idle",
      });
    }
    return out;
  });

  const counts = createMemo(() => {
    const all = ids()
      .map((id) => findRunner(id)?.runner)
      .filter((r): r is RunnerUI => Boolean(r));
    return {
      agents: all.filter((r) => r.kind === "agent").length,
      working: all.filter((r) => glyphFor(r) === "working").length,
      waiting: all.filter(needsYou).length,
    };
  });

  function bounds(): { x: number; y: number; w: number; h: number } | null {
    if (ids().length === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of ids()) {
      const p = at(id);
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y - HEAD);
      x1 = Math.max(x1, p.x + CARD_W);
      y1 = Math.max(y1, p.y + CARD_H);
    }
    return { x: x0 - PAD, y: y0, w: x1 - x0 + 2 * PAD, h: y1 - y0 + PAD };
  }

  let anim = 0;
  function flyTo(target: View, ms = 380): void {
    cancelAnimationFrame(anim);
    const from = view();
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      setView({
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        k: from.k + (target.k - from.k) * e,
      });
      if (t < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function fit(animated = true): void {
    const b = bounds();
    const s = size();
    if (!b || s.w === 0) return;
    const margin = 56;
    const dock = 76;
    const k = Math.min(1, Math.max(K_MIN, Math.min((s.w - 2 * margin) / b.w, (s.h - 2 * margin - dock) / b.h)));
    const target = {
      k,
      x: (s.w - b.w * k) / 2 - b.x * k,
      y: (s.h - dock - b.h * k) / 2 - b.y * k,
    };
    if (animated) flyTo(target);
    else setView(target);
  }

  function zoomAt(cx: number, cy: number, next: number): void {
    const v = view();
    const k = Math.min(K_MAX, Math.max(K_MIN, next));
    setView({ k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k });
  }

  function zoomBy(factor: number): void {
    cancelAnimationFrame(anim);
    const v = view();
    const s = size();
    const k = Math.min(K_MAX, Math.max(K_MIN, v.k * factor));
    flyTo({ k, x: s.w / 2 - ((s.w / 2 - v.x) * k) / v.k, y: s.h / 2 - ((s.h / 2 - v.y) * k) / v.k }, 200);
  }

  function onWheel(e: WheelEvent): void {
    if ((e.target as HTMLElement).closest("[data-ui]")) return;
    e.preventDefault();
    cancelAnimationFrame(anim);
    const rect = board.getBoundingClientRect();
    const v = view();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - rect.left, e.clientY - rect.top, v.k * Math.exp(-e.deltaY * 0.01));
    else setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
  }

  function onBoardDown(e: PointerEvent): void {
    if (e.button > 1) return;
    if ((e.target as HTMLElement).closest("[data-card],[data-ui],button")) return;
    cancelAnimationFrame(anim);
    const start = view();
    const sx = e.clientX;
    const sy = e.clientY;
    board.setPointerCapture(e.pointerId);
    setPanning(true);
    const move = (m: PointerEvent) => setView({ ...start, x: start.x + m.clientX - sx, y: start.y + m.clientY - sy });
    const up = () => {
      board.removeEventListener("pointermove", move);
      board.removeEventListener("pointerup", up);
      board.removeEventListener("pointercancel", up);
      setPanning(false);
    };
    board.addEventListener("pointermove", move);
    board.addEventListener("pointerup", up);
    board.addEventListener("pointercancel", up);
  }

  function onCardDown(e: PointerEvent, id: string): void {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const origin = at(id);
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return;
      moved = true;
      setDragging(id);
      place(id, { x: origin.x + (m.clientX - sx) / view().k, y: origin.y + (m.clientY - sy) / view().k });
    };
    const up = (u: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (moved) {
        savePlaced();
        setDragging(null);
      } else if (u.type === "pointerup") {
        setOpen({ id, from: el.getBoundingClientRect() });
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  function ask(text: string): void {
    const id = hubId();
    if (!id) return;
    runnerSend(id, text).catch(console.error);
    setPinged(true);
    window.setTimeout(() => setPinged(false), 1400);
  }

  createEffect(() => {
    const v = view();
    layer.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.k})`;
    const step = 26 * v.k * (v.k < 0.5 ? 2 : 1);
    board.style.backgroundSize = `${step}px ${step}px`;
    board.style.backgroundPosition = `${v.x}px ${v.y}px`;
  });

  let fitted = hasSavedView;
  createEffect(() => {
    if (fitted || size().w === 0 || ids().length === 0) return;
    fitted = true;
    fit(false);
  });

  onMount(() => {
    ensureModels();
    const stopVitals = watchVitals();
    const ro = new ResizeObserver(() => setSize({ w: board.clientWidth, h: board.clientHeight }));
    ro.observe(board);
    board.addEventListener("wheel", onWheel, { passive: false });

    let busy = false;
    const poll = () => {
      if (busy || document.hidden || far()) return;
      const want = [...visible()].filter((id) => findRunner(id)?.runner.live);
      if (want.length === 0) return;
      const known: Record<string, number> = {};
      for (const id of want) if (seen[id] !== undefined) known[id] = seen[id];
      busy = true;
      ptyScreens(want, MINI_ROWS, known)
        .then((list) =>
          batch(() => {
            for (const s of list) {
              seen[s.id] = s.ver;
              setScreens(s.id, s);
            }
          }),
        )
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);

    onCleanup(() => {
      stopVitals();
      ro.disconnect();
      board.removeEventListener("wheel", onWheel);
      window.clearInterval(timer);
      cancelAnimationFrame(anim);
    });
  });

  return (
    <div class="relative flex min-h-0 flex-1 overflow-hidden">
      <div
        ref={board}
        class="cx-canvas absolute inset-0"
        data-panning={panning()}
        data-far={far()}
        data-dragging={dragging() !== null}
        onPointerDown={onBoardDown}
      >
        <div ref={layer} class="cx-canvas-layer">
          <Index each={frames()}>
            {(f) => (
              <div
                class="cx-frame"
                style={{
                  transform: `translate3d(${f().x}px, ${f().y}px, 0)`,
                  width: `${f().w}px`,
                  height: `${f().h}px`,
                }}
              >
                <button
                  class="cx-frame-label font-heading"
                  title="Abrir o projeto"
                  onClick={() => focusProject(f().project.id)}
                >
                  {f().project.name}
                  <span class="font-sans text-[11.5px] text-faint">{f().count}</span>
                </button>
              </div>
            )}
          </Index>

          <svg class="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
            <Index each={edges()}>
              {(e) => (
                <g data-tone={e().tone}>
                  <path class="cx-edge" d={e().d} />
                  <circle class="cx-edge-end" cx={e().x} cy={e().y} r="4" />
                </g>
              )}
            </Index>
          </svg>

          <For each={ids()}>
            {(id) => {
              const found = createMemo(() => findRunner(id) as Found | undefined);
              const shown = createMemo(() => visible().has(id));
              return (
                <div
                  data-card
                  class="cx-node"
                  classList={{ "cx-node-drag": dragging() === id }}
                  style={{
                    transform: `translate3d(${at(id).x}px, ${at(id).y}px, 0)`,
                    width: `${CARD_W}px`,
                    height: `${CARD_H}px`,
                  }}
                  onPointerDown={(e) => onCardDown(e, id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const f = found();
                    if (f) openMenu(e, runnerMenu(f.project, f.runner));
                  }}
                >
                  <Show when={shown() && found()}>
                    {(f) => (
                      <Card
                        found={f()}
                        hub={id === hubId()}
                        pinged={pinged() && id === hubId()}
                        screen={screens[id]}
                      />
                    )}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>

      <div data-ui class="cx-glass pointer-events-none absolute left-4 top-4 flex items-center gap-2.5 rounded-full border border-line px-3.5 py-2 text-[12px] text-dim">
        <span class="font-heading text-[14px] leading-none text-ink">Canvas</span>
        <span>{counts().agents === 1 ? "1 agente" : `${counts().agents} agentes`}</span>
        <Show when={counts().working > 0}>
          <span class="text-live">{counts().working} trabalhando</span>
        </Show>
        <Show when={counts().waiting > 0}>
          <span class="text-busy">
            {counts().waiting === 1 ? "1 precisa de você" : `${counts().waiting} precisam de você`}
          </span>
        </Show>
      </div>

      <div data-ui class="cx-glass absolute bottom-4 left-4 flex items-center gap-0.5 rounded-full border border-line p-1">
        <button class="cx-icon-btn" title="Afastar" onClick={() => zoomBy(1 / 1.25)}>
          <Minus size={13} />
        </button>
        <button
          class="w-[44px] text-center text-[11.5px] tabular-nums text-dim hover:text-ink"
          title="Voltar a 100%"
          onClick={() => zoomBy(1 / view().k)}
        >
          {Math.round(view().k * 100)}%
        </button>
        <button class="cx-icon-btn" title="Aproximar" onClick={() => zoomBy(1.25)}>
          <Plus size={13} />
        </button>
        <span class="mx-1 h-4 w-px bg-line-strong" />
        <button class="cx-icon-btn" title="Enquadrar tudo" onClick={() => fit()}>
          <Scan size={13} />
        </button>
        <button
          class="cx-icon-btn"
          title="Organizar os cartões"
          onClick={() => {
            tidy();
            requestAnimationFrame(() => fit());
          }}
        >
          <LayoutGrid size={13} />
        </button>
        <Show when={hidden() > 0}>
          <button
            class="cx-icon-btn"
            data-on={showStale()}
            title={showStale() ? "Esconder os parados há dias" : `Mostrar ${hidden()} parados há dias`}
            onClick={() => setShowStale(!showStale())}
          >
            <Archive size={13} />
          </button>
        </Show>
      </div>

      <HubBar onAsk={ask} ready={hubId() !== null} />

      <Minimap
        ids={ids()}
        at={at}
        size={size()}
        onJump={(wx, wy) => {
          const v = view();
          const s = size();
          setView({ ...v, x: s.w / 2 - wx * v.k, y: s.h / 2 - wy * v.k });
        }}
      />

      <Show when={ids().length <= (hubId() ? 1 : 0)}>
        <p class="pointer-events-none absolute inset-x-0 bottom-28 text-center text-[13px] text-faint">
          Nenhum agente ainda. Peça algo ao Hub e ele sobe o primeiro.
        </p>
      </Show>

      <Show when={open()} keyed>
        {(o) => <Expanded id={o.id} from={o.from} onClose={() => setOpen(null)} />}
      </Show>
    </div>
  );
}

function Card(props: { found: Found; hub: boolean; pinged: boolean; screen: Snapshot | undefined }) {
  const r = () => props.found.runner;
  const glyph = () => glyphFor(r());
  const state = () => stateOf(r());
  const v = () => vitalsOf(r().id);
  const model = () => modelLabel(r()) || (v()?.model ? prettyModel(v()!.model) : "");
  const parent = () => {
    if (!r().parentId) return undefined;
    return r().parentId === masterRunner()?.id ? "Hub" : findRunner(r().parentId)?.runner.name;
  };
  const branch = () => (r().cwd ? branchOf(props.found.project, r()) : "");
  const line = () =>
    r().activity ||
    v()?.last ||
    r().task ||
    (props.hub ? "Diga o que precisa. Ele decide quem faz." : r().kind === "shell" ? "" : "Sem tarefa ainda");

  return (
    <div class="cx-node-face" data-tone={glyph()} data-hub={props.hub} data-ping={props.pinged}>
      <header class="flex items-center gap-2 px-3.5 pt-3">
        <RunnerIcon runner={r()} size={15} ring="var(--raised)" />
        <span class="cx-node-name font-heading min-w-0 flex-1 truncate text-[15px] leading-[1.15] text-ink">
          {props.hub ? "Hub" : r().name}
        </span>
        <Show when={model()}>
          <span class="cx-node-detail shrink-0 rounded-full bg-fill-2 px-2 py-[3px] text-[10.5px] leading-none text-dim">
            {model()}
          </span>
        </Show>
      </header>
      <div class="flex items-center gap-1.5 px-3.5 pt-2 text-[11.5px]">
        <StatusGlyph glyph={glyph()} size={12} />
        <span class={TONE_TEXT[state().tone]}>{state().label}</span>
        <Show when={parent()}>
          <span class="cx-node-detail min-w-0 truncate text-faint">· delegado por {parent()}</span>
        </Show>
        <span class="cx-node-detail ml-auto shrink-0 text-faint">{relativeTime(r().lastActive)}</span>
      </div>
      <p class="cx-node-detail min-h-[18px] truncate px-3.5 pt-1.5 text-[12px] leading-[18px] text-dim">{line()}</p>
      <div class="cx-node-detail cx-mini mx-2.5 mt-2 min-h-0 flex-1">
        <Show
          when={r().live}
          fallback={<span class="cx-mini-off">Parado. Clique para abrir de onde parou.</span>}
        >
          <Mini screen={props.screen} />
        </Show>
      </div>
      <footer class="cx-node-detail flex h-[30px] shrink-0 items-center gap-2.5 px-3.5 text-[11px] tabular-nums text-faint">
        <Show when={v()?.contextTokens}>
          <span title="Tamanho do contexto na última resposta">{fmtTokens(v()!.contextTokens)} ctx</span>
        </Show>
        <Show when={v() && v()!.costUsd > 0}>
          <span title="Estimativa pelo preço de tabela">{fmtCost(v()!.costUsd)}</span>
        </Show>
        <Show when={r().kind === "shell"}>
          <span class="truncate font-mono text-[10.5px]">
            {shortPath(r().cwd || props.found.project.folders[0] || "", [])}
          </span>
        </Show>
        <Show when={branch()}>
          <span class="ml-auto flex min-w-0 items-center gap-1" title="Worktree própria">
            <GitBranch size={10} class="shrink-0" />
            <span class="truncate font-mono text-[10.5px]">{branch()}</span>
          </span>
        </Show>
      </footer>
    </div>
  );
}

function Mini(props: { screen: Snapshot | undefined }) {
  let pre!: HTMLPreElement;
  createEffect(() => {
    pre.innerHTML = props.screen ? paint(props.screen.lines) : "";
  });
  return <pre ref={pre} />;
}

function HubBar(props: { onAsk: (text: string) => void; ready: boolean }) {
  const [text, setText] = createSignal("");
  const submit = (e: Event) => {
    e.preventDefault();
    const t = text().trim();
    if (!t || !props.ready) return;
    props.onAsk(t);
    setText("");
  };
  return (
    <form
      data-ui
      class="cx-glass cx-hubbar absolute bottom-4 left-1/2 flex w-[min(560px,calc(100%-460px))] min-w-[300px] -translate-x-1/2 items-center gap-2 rounded-full border border-line-strong py-1.5 pl-4 pr-1.5"
      onSubmit={submit}
    >
      <Waypoints size={14} class="shrink-0 text-accent" />
      <input
        class="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
        placeholder="Peça ao Hub. Ele decide quem faz e em qual modelo."
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <button
        type="submit"
        class="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition disabled:opacity-35"
        disabled={!text().trim() || !props.ready}
        aria-label="Pedir ao Hub"
      >
        <ArrowUp size={14} />
      </button>
    </form>
  );
}

const MAP_W = 176;
const MAP_H = 110;

function Minimap(props: {
  ids: string[];
  at: (id: string) => Point;
  size: { w: number; h: number };
  onJump: (wx: number, wy: number) => void;
}) {
  const frame = createMemo(() => {
    const v = view();
    let x0 = -v.x / v.k;
    let y0 = -v.y / v.k;
    let x1 = x0 + props.size.w / v.k;
    let y1 = y0 + props.size.h / v.k;
    const port = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    for (const id of props.ids) {
      const p = props.at(id);
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + CARD_W);
      y1 = Math.max(y1, p.y + CARD_H);
    }
    const s = Math.min(MAP_W / (x1 - x0), MAP_H / (y1 - y0));
    return {
      s,
      ox: x0 - (MAP_W / s - (x1 - x0)) / 2,
      oy: y0 - (MAP_H / s - (y1 - y0)) / 2,
      port,
    };
  });
  const tone = (id: string) => {
    const r = findRunner(id)?.runner;
    if (!r) return "var(--fill-3)";
    const g = glyphFor(r);
    if (g === "awaiting" || g === "error") return "var(--busy)";
    if (g === "working") return "var(--live)";
    return r.live ? "var(--text-faint)" : "var(--fill-4)";
  };
  const jump = (e: PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = frame();
    props.onJump(f.ox + (e.clientX - rect.left) / f.s, f.oy + (e.clientY - rect.top) / f.s);
  };

  return (
    <Show when={props.ids.length > 1 && props.size.w > 0}>
      <div
        data-ui
        class="cx-glass absolute bottom-4 right-4 cursor-pointer overflow-hidden rounded-[12px] border border-line"
        style={{ width: `${MAP_W}px`, height: `${MAP_H}px` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          jump(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) jump(e);
        }}
      >
        <For each={props.ids}>
          {(id) => (
            <span
              class="absolute rounded-[2px]"
              style={{
                left: `${(props.at(id).x - frame().ox) * frame().s}px`,
                top: `${(props.at(id).y - frame().oy) * frame().s}px`,
                width: `${Math.max(3, CARD_W * frame().s)}px`,
                height: `${Math.max(2, CARD_H * frame().s)}px`,
                background: tone(id),
              }}
            />
          )}
        </For>
        <span
          class="absolute rounded-[3px] border border-accent bg-accent-soft"
          style={{
            left: `${(frame().port.x - frame().ox) * frame().s}px`,
            top: `${(frame().port.y - frame().oy) * frame().s}px`,
            width: `${frame().port.w * frame().s}px`,
            height: `${frame().port.h * frame().s}px`,
          }}
        />
      </div>
    </Show>
  );
}

/** A card grown into the real session, without leaving the board. */
function Expanded(props: { id: string; from: DOMRect; onClose: () => void }) {
  let panel!: HTMLDivElement;
  let veil!: HTMLDivElement;
  const found = createMemo(() => findRunner(props.id) as Found | undefined);
  const SPRING = "cubic-bezier(.2,.8,.2,1)";

  function origin(): Keyframe {
    const to = panel.getBoundingClientRect();
    const f = props.from;
    return {
      transform: `translate(${f.left - to.left}px, ${f.top - to.top}px) scale(${f.width / to.width}, ${f.height / to.height})`,
      opacity: 0.2,
    };
  }

  let closing = false;
  function close(): void {
    if (closing) return;
    closing = true;
    veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" });
    panel
      .animate([{ transform: "none", opacity: 1 }, origin()], { duration: 220, easing: SPRING, fill: "forwards" })
      .finished.then(props.onClose, props.onClose);
  }

  onMount(() => {
    veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
    panel.animate([origin(), { transform: "none", opacity: 1 }], { duration: 300, easing: SPRING });
    // Plain Esc belongs to the agent (it interrupts a turn), so leaving the
    // card takes Shift.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  createEffect(() => {
    if (!found()) props.onClose();
  });

  return (
    <div data-ui class="absolute inset-0 z-30">
      <div ref={veil} class="cx-veil absolute inset-0" onClick={close} />
      <div
        ref={panel}
        class="absolute inset-x-[5%] inset-y-[4%] flex flex-col overflow-hidden rounded-cx-lg border border-line-strong bg-void shadow-cx-lg"
        style={{ "transform-origin": "0 0" }}
      >
        <Show when={found()}>
          {(f) => (
            <>
              <header class="flex h-[44px] shrink-0 items-center gap-2.5 border-b border-line bg-panel px-4">
                <RunnerIcon runner={f().runner} size={15} ring="var(--panel)" />
                <span class="font-heading min-w-0 truncate text-[15px] text-ink">{f().runner.name}</span>
                <span class={`shrink-0 text-[12px] ${TONE_TEXT[stateOf(f().runner).tone]}`}>
                  {stateOf(f().runner).label}
                </span>
                <span class="truncate text-[12px] text-faint">{f().project.name}</span>
                <div class="ml-auto flex shrink-0 items-center gap-1">
                  <button
                    class="cx-pill cx-pill-line"
                    onClick={() => {
                      props.onClose();
                      focusRunner(f().project.id, f().runner.id);
                    }}
                  >
                    <ExternalLink size={12} />
                    Abrir sessão
                  </button>
                  <button class="cx-icon-btn" title="Voltar ao canvas (⇧esc)" aria-label="Fechar" onClick={close}>
                    <X size={15} />
                  </button>
                </div>
              </header>
              <div class="flex min-h-0 flex-1">
                <SessionBody project={f().project} runner={f().runner} />
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
