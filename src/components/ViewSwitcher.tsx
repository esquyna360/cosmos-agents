import { For } from "solid-js";

import { setView, view, toggleComposer, composerVisible, type ViewMode } from "../stores/layout";

const SEGMENTS: { id: ViewMode; label: string; key: string }[] = [
  { id: "terminal", label: "terminal", key: "T" },
  { id: "editor", label: "editor", key: "E" },
  { id: "diff", label: "diff", key: "D" },
];

export default function ViewSwitcher() {
  return (
    <div class="flex items-center gap-3 px-3 py-1.5 text-[12px]">
      <div class="inline-flex overflow-hidden rounded-md border border-white/10 bg-white/[0.03]">
        <For each={SEGMENTS}>
          {(s) => {
            const active = () => view() === s.id;
            return (
              <button
                class="px-3 py-1 text-white/60 transition hover:bg-white/5 hover:text-white"
                classList={{ "!bg-white/15 !text-white": active() }}
                onClick={() => setView(s.id)}
                title={`${s.label} (⌘E to cycle)`}
              >
                {s.label}
              </button>
            );
          }}
        </For>
      </div>
      <button
        class="rounded-md border border-white/10 px-2 py-1 text-white/60 hover:bg-white/5 hover:text-white"
        classList={{ "!text-white/30 line-through decoration-1": !composerVisible() }}
        onClick={toggleComposer}
        title="⌘I — toggle composer"
      >
        compose
      </button>
    </div>
  );
}
