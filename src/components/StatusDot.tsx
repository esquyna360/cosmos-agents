import { Show } from "solid-js";
import type { AgentStatus } from "../lib/ipc";

interface Props {
  color: string;
  status: AgentStatus;
  live: boolean;
}

const SIZE = 11;

/**
 * Each state gets its own *shape*, not just a pulse:
 *   idle           ○  hollow ring (the resting state — claude finished, nothing to do)
 *   streaming      ●  filled disc (actively producing output)
 *   awaiting_input ▲  filled amber triangle (rare; demands attention)
 *   error          ✕  red cross
 *   tool_running   ●  treated like streaming (we don't emit this from the heuristic)
 * Non-live (ghost) agents fade everything to ~30% opacity.
 */
export default function StatusDot(props: Props) {
  const opacity = () => (props.live ? 1 : 0.3);
  return (
    <span
      class="relative inline-flex h-3 w-3 shrink-0 items-center justify-center"
      style={{ opacity: opacity() }}
    >
      <Show when={props.status === "idle"}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={SIZE / 2 - 1.2}
            fill="none"
            stroke={props.color}
            stroke-width={1.4}
            opacity={0.7}
          />
        </svg>
      </Show>
      <Show when={props.status === "streaming" || props.status === "tool_running"}>
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          class="animate-spin"
          style={{ "animation-duration": "1.1s" }}
        >
          {/* faint full ring underneath so the moving arc reads as "incomplete" */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={SIZE / 2 - 1.2}
            fill="none"
            stroke={props.color}
            stroke-width={1.4}
            opacity={0.18}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={SIZE / 2 - 1.2}
            fill="none"
            stroke={props.color}
            stroke-width={1.6}
            stroke-linecap="round"
            pathLength="100"
            stroke-dasharray="65 100"
          />
        </svg>
      </Show>
      <Show when={props.status === "awaiting_input"}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <polygon
            points={`${SIZE / 2},1 ${SIZE - 1},${SIZE - 1} 1,${SIZE - 1}`}
            fill="#f59e0b"
            style={{ filter: "drop-shadow(0 0 4px #f59e0b)" }}
          />
        </svg>
      </Show>
      <Show when={props.status === "error"}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <path
            d={`M2 2 L${SIZE - 2} ${SIZE - 2} M${SIZE - 2} 2 L2 ${SIZE - 2}`}
            stroke="#ef4444"
            stroke-width={1.6}
            stroke-linecap="round"
          />
        </svg>
      </Show>
    </span>
  );
}
