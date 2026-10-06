import { createStore, reconcile } from "solid-js/store";

import { runnersVitals, type Vitals } from "../lib/canvas";

const [vitals, setVitals] = createStore<Record<string, Vitals>>({});
let watchers = 0;
let timer: number | undefined;

function pull(): void {
  if (document.hidden) return;
  runnersVitals()
    .then((v) => setVitals(reconcile(v)))
    .catch(() => {});
}

/** Keeps spend and context fresh while a view that shows them is mounted. */
export function watchVitals(): () => void {
  if (++watchers === 1) {
    pull();
    timer = window.setInterval(pull, 5000);
  }
  return () => {
    if (--watchers === 0) window.clearInterval(timer);
  };
}

export function vitalsOf(id: string): Vitals | undefined {
  return vitals[id];
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** An estimate from list prices, hence the "≈". */
export function fmtCost(usd: number): string {
  if (usd <= 0) return "";
  return `≈ $${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)}`;
}

/** "claude-opus-5-5" → "Opus 5.5". */
export function prettyModel(id: string): string {
  const m = id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const parts = m.split("-");
  if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
    const name = parts[0][0].toUpperCase() + parts[0].slice(1);
    return `${name} ${parts.slice(1).join(".")}`;
  }
  return m;
}
