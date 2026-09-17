import { Match, Switch } from "solid-js";
import { SquareTerminal } from "lucide-solid";

import type { RunnerUI } from "../stores/projects";

export type Glyph =
  | "working"
  | "awaiting"
  | "unread"
  | "error"
  | "ready"
  | "stopped"
  | "shell-live"
  | "shell-stopped";

export function glyphFor(r: RunnerUI): Glyph {
  if (r.kind === "shell") return r.live ? "shell-live" : "shell-stopped";
  if (r.status === "awaiting_input") return "awaiting";
  if (r.status === "error") return "error";
  if (r.live && (r.status === "streaming" || r.status === "tool_running"))
    return "working";
  if (r.unread) return "unread";
  return r.live ? "ready" : "stopped";
}

export const GLYPH_LABEL: Record<Glyph, string> = {
  working: "trabalhando",
  awaiting: "esperando você",
  unread: "terminou, você ainda não viu",
  error: "erro",
  ready: "pronto",
  stopped: "parado, abre de onde parou",
  "shell-live": "terminal aberto",
  "shell-stopped": "terminal fechado",
};

export default function StatusGlyph(props: { glyph: Glyph; size?: number }) {
  const s = () => props.size ?? 14;
  return (
    <span
      class="inline-flex shrink-0 items-center justify-center"
      style={{ width: `${s()}px`, height: `${s()}px` }}
      title={GLYPH_LABEL[props.glyph]}
    >
      <Switch>
        <Match when={props.glyph === "working"}>
          <svg viewBox="0 0 14 14" class="cx-spin h-full w-full text-accent">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-opacity="0.22" stroke-width="1.6" />
            <path d="M7 2.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </Match>
        <Match when={props.glyph === "awaiting"}>
          <span class="cx-pulse h-[7px] w-[7px] rounded-full bg-busy shadow-[0_0_0_3px_var(--busy-soft)]" />
        </Match>
        <Match when={props.glyph === "unread"}>
          <span class="h-[7px] w-[7px] rounded-full bg-accent" />
        </Match>
        <Match when={props.glyph === "error"}>
          <span class="h-[7px] w-[7px] rounded-full bg-alert" />
        </Match>
        <Match when={props.glyph === "ready"}>
          <span class="h-[7px] w-[7px] rounded-full border-[1.5px] border-dim" />
        </Match>
        <Match when={props.glyph === "stopped"}>
          <span class="h-[5px] w-[5px] rounded-full bg-fill-4" />
        </Match>
        <Match when={props.glyph === "shell-live"}>
          <SquareTerminal size={s() - 1} class="text-dim" />
        </Match>
        <Match when={props.glyph === "shell-stopped"}>
          <SquareTerminal size={s() - 1} class="text-faint opacity-60" />
        </Match>
      </Switch>
    </span>
  );
}
