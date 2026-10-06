import { createEffect, on, onCleanup, onMount } from "solid-js";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

import { sourceColor, type Note } from "../lib/brain";
import { themeTick } from "../stores/theme";

interface GNode extends SimulationNodeDatum {
  id: string;
  title: string;
  color: string;
  r: number;
  degree: number;
  near: Set<GNode>;
}

type GLink = SimulationLinkDatum<GNode> & { source: GNode; target: GNode };

interface Props {
  notes: Note[];
  selected: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  /** Bumped by the parent's "fit" button. */
  fitTick: number;
}

const K_MIN = 0.12;
const K_MAX = 4;

/** The vault as a living graph: notes repel, links pull, and what you point
 *  at lights up with its neighbours. Drawn on one canvas so a thousand notes
 *  cost the same as ten. */
export default function BrainGraph(props: Props) {
  let host!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let sim: Simulation<GNode, GLink> | undefined;
  let nodes: GNode[] = [];
  let links: GLink[] = [];
  const known = new Map<string, GNode>();

  let width = 0;
  let height = 0;
  let dpr = 1;
  const view = { x: 0, y: 0, k: 1 };
  let goal: { x: number; y: number; k: number } | null = null;
  let following = true;
  let hovered: GNode | null = null;
  let glow = 0;
  let born = 0;
  let frame = 0;
  let dirty = true;
  let palette = { text: "#f5ead8", faint: "#7f776b", line: "rgba(245,234,216,0.1)", accent: "#e6935e", bg: "#201e1d" };

  function readPalette(): void {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    palette = {
      text: v("--text", palette.text),
      faint: v("--text-faint", palette.faint),
      line: v("--line-strong", palette.line),
      accent: v("--accent", palette.accent),
      bg: v("--void", palette.bg),
    };
  }

  function rebuild(notes: Note[]): void {
    const alive = new Set(notes.map((n) => n.id));
    for (const id of [...known.keys()]) if (!alive.has(id)) known.delete(id);
    const fresh = known.size === 0;
    nodes = notes.map((n) => {
      let node = known.get(n.id);
      if (!node) {
        // A newcomer starts next to something it links to, so it slides
        // into place instead of flying across the whole graph.
        const anchor = n.links.map((id) => known.get(id)).find((a) => a && a.x !== undefined);
        node = {
          id: n.id,
          title: n.title,
          color: sourceColor(n.source),
          r: 3,
          degree: 0,
          near: new Set(),
          x: anchor ? anchor.x! + (Math.random() - 0.5) * 30 : undefined,
          y: anchor ? anchor.y! + (Math.random() - 0.5) * 30 : undefined,
        };
        known.set(n.id, node);
      }
      node.title = n.title;
      node.color = sourceColor(n.source);
      node.degree = 0;
      node.near = new Set();
      return node;
    });
    links = [];
    for (const n of notes) {
      const from = known.get(n.id)!;
      for (const to of n.links) {
        const target = known.get(to);
        if (!target || target === from || from.near.has(target)) continue;
        links.push({ source: from, target });
        from.near.add(target);
        target.near.add(from);
      }
    }
    for (const node of nodes) {
      node.degree = node.near.size;
      node.r = 2.6 + Math.sqrt(node.degree) * 1.7;
    }
    sim?.stop();
    sim = forceSimulation<GNode, GLink>(nodes)
      .force(
        "link",
        forceLink<GNode, GLink>(links)
          .distance((l) => 34 + (l.source.r + l.target.r) * 1.6)
          .strength((l) => 1 / Math.min(Math.max(l.source.degree, 1), Math.max(l.target.degree, 1), 6)),
      )
      .force("charge", forceManyBody<GNode>().strength((n) => -46 - n.r * 9).distanceMax(520).theta(0.95))
      .force("collide", forceCollide<GNode>().radius((n) => n.r + 2.5).strength(0.7))
      .force("x", forceX<GNode>(0).strength(0.045))
      .force("y", forceY<GNode>(0).strength(0.055))
      .alpha(fresh ? 1 : 0.35)
      .alphaDecay(0.022)
      .velocityDecay(0.38)
      .on("tick", () => {
        dirty = true;
      });
    if (fresh) {
      born = performance.now();
      following = true;
    }
    dirty = true;
  }

  function bounds(): { x: number; y: number; k: number } | null {
    if (!nodes.length || !width) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of nodes) {
      if (n.x === undefined || n.y === undefined) continue;
      x0 = Math.min(x0, n.x - n.r);
      y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r);
      y1 = Math.max(y1, n.y + n.r);
    }
    if (!isFinite(x0)) return null;
    const pad = 56;
    const k = Math.min(K_MAX / 2, Math.max(K_MIN, Math.min((width - pad * 2) / (x1 - x0 || 1), (height - pad * 2) / (y1 - y0 || 1))));
    return { k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k };
  }

  function draw(now: number): void {
    const active = hovered ?? (props.selected ? known.get(props.selected) : undefined) ?? null;
    const lit = active && nodes.includes(active) ? active : null;
    const target = lit ? 1 : 0;
    glow += (target - glow) * 0.18;
    if (Math.abs(target - glow) > 0.01) dirty = true;
    else glow = target;

    const appear = Math.min(1, (now - born) / 700);
    if (appear < 1) dirty = true;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);

    const dim = 1 - glow * 0.82;
    ctx.lineWidth = 1 / view.k;
    ctx.strokeStyle = palette.line;
    ctx.globalAlpha = appear * dim * Math.min(1, 0.35 + view.k * 0.5);
    ctx.beginPath();
    for (const l of links) {
      if (lit && (l.source === lit || l.target === lit)) continue;
      ctx.moveTo(l.source.x!, l.source.y!);
      ctx.lineTo(l.target.x!, l.target.y!);
    }
    ctx.stroke();

    if (lit) {
      ctx.globalAlpha = appear * (0.25 + glow * 0.6);
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = 1.4 / view.k;
      ctx.beginPath();
      for (const other of lit.near) {
        ctx.moveTo(lit.x!, lit.y!);
        ctx.lineTo(other.x!, other.y!);
      }
      ctx.stroke();
    }

    for (const n of nodes) {
      const on = !lit || n === lit || lit.near.has(n);
      ctx.globalAlpha = appear * (on ? 1 : dim * 0.55);
      ctx.fillStyle = n.color;
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r * (0.4 + appear * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }

    const chosen = props.selected ? known.get(props.selected) : undefined;
    if (chosen && chosen.x !== undefined && nodes.includes(chosen)) {
      const beat = (Math.sin(now / 420) + 1) / 2;
      ctx.globalAlpha = 0.55 + beat * 0.35;
      ctx.strokeStyle = palette.text;
      ctx.lineWidth = 1.6 / view.k;
      ctx.beginPath();
      ctx.arc(chosen.x, chosen.y!, chosen.r + (3.5 + beat * 2) / view.k, 0, Math.PI * 2);
      ctx.stroke();
      dirty = true;
    }

    const size = 11.5 / view.k;
    ctx.font = `500 ${size}px "Figtree Variable", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    const everyone = Math.max(0, Math.min(1, (view.k - 1.05) / 0.5));
    const hubs = Math.max(0, Math.min(1, (view.k - 0.42) / 0.3));
    // Most wanted first; a label that would sit on another is left out.
    const wanted: { n: GNode; alpha: number; near: boolean; rank: number }[] = [];
    for (const n of nodes) {
      const near = lit !== null && (n === lit || lit.near.has(n));
      let alpha = near ? 0.35 + glow * 0.65 : n.degree >= 7 ? hubs * dim : everyone * dim;
      if (lit && !near) alpha *= 0.6;
      if (alpha < 0.04) continue;
      wanted.push({ n, alpha, near, rank: (n === lit ? 1e6 : near ? 1e3 : 0) + n.degree });
    }
    wanted.sort((a, b) => b.rank - a.rank);
    const taken: [number, number, number, number][] = [];
    const tall = size * 1.25;
    for (const { n, alpha, near } of wanted) {
      const label = n.title.length > 34 ? `${n.title.slice(0, 33)}…` : n.title;
      const half = ctx.measureText(label).width / 2 + 3 / view.k;
      const y = n.y! + n.r + 4 / view.k;
      const box: [number, number, number, number] = [n.x! - half, y, n.x! + half, y + tall];
      if (taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) continue;
      taken.push(box);
      ctx.globalAlpha = appear * alpha;
      ctx.strokeStyle = palette.bg;
      ctx.lineWidth = 3.5 / view.k;
      ctx.strokeText(label, n.x!, y);
      ctx.fillStyle = near ? palette.text : palette.faint;
      ctx.fillText(label, n.x!, y);
    }
    ctx.globalAlpha = 1;
  }

  function loop(now: number): void {
    frame = requestAnimationFrame(loop);
    if (!width || !height) return;
    if (following && (sim?.alpha() ?? 0) > 0.02) goal = bounds();
    if (goal) {
      const ease = following ? 0.09 : 0.16;
      view.x += (goal.x - view.x) * ease;
      view.y += (goal.y - view.y) * ease;
      view.k += (goal.k - view.k) * ease;
      if (Math.abs(goal.x - view.x) + Math.abs(goal.y - view.y) < 0.4 && Math.abs(goal.k - view.k) < 0.002) goal = null;
      dirty = true;
    }
    if (!dirty) return;
    dirty = false;
    draw(now);
  }

  function resize(): void {
    const box = host.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const first = !width;
    width = box.width;
    height = box.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    if (first) {
      view.x = width / 2;
      view.y = height / 2;
      view.k = 0.5;
      // Shown late (a phone opens on the list): the layout may have settled
      // already, so frame it now.
      goal = bounds() ?? goal;
    }
    dirty = true;
  }

  function at(e: { clientX: number; clientY: number }): { x: number; y: number; node: GNode | null } {
    const box = canvas.getBoundingClientRect();
    const x = (e.clientX - box.left - view.x) / view.k;
    const y = (e.clientY - box.top - view.y) / view.k;
    let best: GNode | null = null;
    let reach = Infinity;
    for (const n of nodes) {
      if (n.x === undefined) continue;
      const d = Math.hypot(n.x - x, n.y! - y) - n.r;
      if (d < 7 / view.k && d < reach) {
        reach = d;
        best = n;
      }
    }
    return { x, y, node: best };
  }

  let drag: { node: GNode | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null;
  let lastClick = { id: "", at: 0 };

  function onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const hit = at(e);
    drag = { node: hit.node, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    canvas.setPointerCapture(e.pointerId);
  }

  function onMove(e: PointerEvent): void {
    if (!drag) {
      const next = at(e).node;
      if (next !== hovered) {
        hovered = next;
        canvas.style.cursor = next ? "pointer" : "grab";
        dirty = true;
      }
      return;
    }
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    following = false;
    goal = null;
    if (drag.node) {
      const p = at(e);
      drag.node.fx = p.x;
      drag.node.fy = p.y;
      sim?.alphaTarget(0.25).restart();
    } else {
      view.x = drag.vx + dx;
      view.y = drag.vy + dy;
      canvas.style.cursor = "grabbing";
    }
    dirty = true;
  }

  function onUp(e: PointerEvent): void {
    const was = drag;
    drag = null;
    if (!was) return;
    canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = hovered ? "pointer" : "grab";
    if (was.node) {
      was.node.fx = null;
      was.node.fy = null;
      sim?.alphaTarget(0);
    }
    if (was.moved || !was.node) return;
    const now = performance.now();
    if (lastClick.id === was.node.id && now - lastClick.at < 380) props.onOpen(was.node.id);
    else props.onSelect(was.node.id);
    lastClick = { id: was.node.id, at: now };
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    following = false;
    goal = null;
    const box = canvas.getBoundingClientRect();
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5) {
      view.x -= e.deltaX;
      dirty = true;
      return;
    }
    const k = Math.min(K_MAX, Math.max(K_MIN, view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022))));
    view.x = px - ((px - view.x) / view.k) * k;
    view.y = py - ((py - view.y) / view.k) * k;
    view.k = k;
    dirty = true;
  }

  onMount(() => {
    ctx = canvas.getContext("2d")!;
    readPalette();
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    frame = requestAnimationFrame(loop);
    onCleanup(() => {
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(frame);
      sim?.stop();
    });
  });

  createEffect(() => rebuild(props.notes));

  createEffect(
    on(themeTick, () => {
      readPalette();
      dirty = true;
    }),
  );

  createEffect(
    on(
      () => props.fitTick,
      () => {
        following = false;
        goal = bounds();
      },
      { defer: true },
    ),
  );

  // Picking a note in the list brings it into view.
  createEffect(
    on(
      () => props.selected,
      (id) => {
        dirty = true;
        const node = id ? known.get(id) : undefined;
        if (!node || node.x === undefined || !width || drag) return;
        const sx = node.x * view.k + view.x;
        const sy = node.y! * view.k + view.y;
        const inside = sx > 80 && sx < width - 80 && sy > 80 && sy < height - 80;
        if (inside && view.k >= 0.5) return;
        following = false;
        const k = Math.max(view.k, 0.9);
        goal = { k, x: width / 2 - node.x * k, y: height / 2 - node.y! * k };
      },
      { defer: true },
    ),
  );

  return (
    <div ref={host} class="cx-brain-graph absolute inset-0 overflow-hidden">
      <canvas
        ref={canvas}
        class="block h-full w-full"
        style={{ cursor: "grab", "touch-action": "none" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => {
          if (!drag && hovered) {
            hovered = null;
            dirty = true;
          }
        }}
      />
    </div>
  );
}
