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
 * Dragging was broken by Tauri 2's ACL, not by anything visual. Tauri injects
 * a `drag.js` that answers a mousedown on `data-tauri-drag-region` by invoking
 * `plugin:window|start_dragging` — but `core:window:default` does NOT grant
 * `allow-start-dragging`, so every one of those invokes was denied in silence.
 * The permission is now listed explicitly in capabilities/default.json. (The
 * old code also called `startDragging()` by hand, which failed for the exact
 * same reason, which is why removing it changed nothing.)
 *
 * `deep` means any click inside the strip drags, so there are no dead zones;
 * interactive clusters opt out with `data-tauri-drag-region="false"`.
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
      data-tauri-drag-region="deep"
      class="relative z-20 flex h-[var(--titlebar-h)] shrink-0 select-none items-center gap-2 border-b border-line bg-panel pr-2.5"
      style={{ "padding-left": "78px" }}
      title="Cosmos"
    >
      <button
        data-tauri-drag-region="false"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint transition hover:bg-fill-2 hover:text-ink"
        classList={{ "text-dim": sidebarOpen() }}
        onClick={toggleSidebar}
        title="mostrar/ocultar projetos (⌘B)"
      >
        <PanelLeft size={13} />
      </button>

      <div class="flex min-w-0 flex-1 items-center gap-2">
        {props.center}
      </div>

      <div
        data-tauri-drag-region="false"
        class="flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-fill-1 p-0.5"
      >
        <For each={LAYOUT_ORDER}>
          {(item) => {
            const Icon = LAYOUT_ICONS[item.id];
            const active = () => layout() === item.id;
            return (
              <button
                class="flex h-6 w-7 items-center justify-center rounded-md text-faint transition hover:bg-fill-2 hover:text-ink"
                classList={{ "bg-fill-3 text-ink shadow-sm": active() }}
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
