import { For, type JSX } from "solid-js";
import {
  Columns2,
  Grid2x2,
  LayoutPanelLeft,
  PanelLeft,
  Rows2,
  Square,
} from "lucide-solid";

import { sidebarOpen, toggleSidebar } from "../stores/layout";
import { layout, setLayout, type PaneLayout } from "../stores/panes";

/**
 * The window's drag strip.
 *
 * Dragging was broken for one reason: the window was configured `transparent`
 * alongside macOS's Overlay title bar, which drops the native titled style
 * mask and with it the OS-level drag. That's fixed in tauri.conf.json. Here we
 * simply mark the strip with `data-tauri-drag-region` and get out of the way —
 * the previous code *also* called `startDragging()` by hand on mousedown, and
 * two drag sessions racing on the same event is its own hang.
 *
 * Interactive children opt out with `data-no-drag` (Tauri skips any element
 * that isn't the drag region itself, but nested buttons still need pointer
 * events, so keeping them explicit documents the intent).
 */

const LAYOUT_ICONS: Record<PaneLayout, typeof Square> = {
  single: Square,
  cols2: Columns2,
  rows2: Rows2,
  "grid4": Grid2x2,
  "main-right": LayoutPanelLeft,
};

const LAYOUT_ORDER: { id: PaneLayout; hint: string }[] = [
  { id: "single", hint: "único · ⌘⌥1" },
  { id: "cols2", hint: "lado a lado · ⌘⌥2" },
  { id: "rows2", hint: "empilhado · ⌘⌥3" },
  { id: "grid4", hint: "quadrantes · ⌘⌥4" },
  { id: "main-right", hint: "principal + 2 · ⌘⌥5" },
];

interface Props {
  /** Rendered in the middle of the bar — the focused project's identity. */
  center?: JSX.Element;
}

export default function TitleBar(props: Props) {
  return (
    <div
      data-tauri-drag-region
      class="relative z-20 flex h-[var(--titlebar-h)] shrink-0 select-none items-center gap-2 border-b border-line bg-panel pr-2.5"
      style={{ "padding-left": "78px" }}
      title="Cosmos"
    >
      <button
        data-no-drag
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint transition hover:bg-white/8 hover:text-ink"
        classList={{ "text-dim": sidebarOpen() }}
        onClick={toggleSidebar}
        title="mostrar/ocultar projetos (⌘B)"
      >
        <PanelLeft size={13} />
      </button>

      <div data-tauri-drag-region class="flex min-w-0 flex-1 items-center gap-2">
        {props.center}
      </div>

      <div
        data-no-drag
        class="flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-white/[0.03] p-0.5"
      >
        <For each={LAYOUT_ORDER}>
          {(item) => {
            const Icon = LAYOUT_ICONS[item.id];
            const active = () => layout() === item.id;
            return (
              <button
                class="flex h-6 w-7 items-center justify-center rounded-md text-faint transition hover:bg-white/8 hover:text-ink"
                classList={{ "bg-white/12 text-ink shadow-sm": active() }}
                onClick={() => setLayout(item.id)}
                title={item.hint}
              >
                <Icon size={13} />
              </button>
            );
          }}
        </For>
      </div>
    </div>
  );
}
