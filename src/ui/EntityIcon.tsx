import { Show } from "solid-js";
import { Bot, Folder, SquareTerminal } from "lucide-solid";

import type { RunnerUI } from "../stores/projects";
import { GLYPH_LABEL, glyphFor, type Glyph } from "./StatusGlyph";

const ICON_TONE: Record<Glyph, string> = {
  working: "text-live",
  awaiting: "text-busy",
  unread: "text-accent",
  error: "text-alert",
  ready: "text-dim",
  stopped: "text-faint",
  "shell-live": "text-dim",
  "shell-stopped": "text-faint",
};

const DOT: Partial<Record<Glyph, string>> = {
  working: "bg-live cx-pulse",
  awaiting: "bg-busy cx-pulse",
  unread: "bg-accent",
  error: "bg-alert",
  "shell-live": "bg-live",
};

/** A robot for an agent, a prompt window for a terminal; the colour and the
 *  corner dot carry the state. */
export function RunnerIcon(props: { runner: RunnerUI; size?: number; ring?: string }) {
  const s = () => props.size ?? 14;
  const g = () => glyphFor(props.runner);
  return (
    <span
      class={`relative inline-flex shrink-0 items-center justify-center ${ICON_TONE[g()]}`}
      style={{ width: `${s()}px`, height: `${s()}px` }}
      title={GLYPH_LABEL[g()]}
    >
      <Show when={props.runner.kind === "shell"} fallback={<Bot size={s()} stroke-width={1.7} />}>
        <SquareTerminal size={s()} stroke-width={1.7} />
      </Show>
      <Show when={DOT[g()]}>
        <span
          class={`absolute -right-[2px] -top-[2px] h-[6px] w-[6px] rounded-full ring-[1.5px] ${DOT[g()]}`}
          style={{ "--tw-ring-color": props.ring ?? "var(--panel)" }}
        />
      </Show>
    </span>
  );
}

export function ProjectIcon(props: { size?: number; class?: string }) {
  return <Folder size={props.size ?? 14} stroke-width={1.7} class={`shrink-0 ${props.class ?? ""}`} />;
}
