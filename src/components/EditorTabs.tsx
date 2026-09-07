import { For, Show } from "solid-js";
import { X } from "lucide-solid";

import { iconForFile } from "../lib/fileIcons";

interface Props {
  paths: string[];
  active: string | null;
  dirty: Record<string, boolean>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

export default function EditorTabs(props: Props) {
  return (
    <div class="flex h-8 shrink-0 items-center overflow-x-auto border-b border-line bg-panel">
      <For each={props.paths}>
        {(path) => {
          const isActive = () => props.active === path;
          const isDirty = () => !!props.dirty[path];
          const { Icon, color } = iconForFile(basenameOf(path));
          return (
            <div
              class="group relative flex h-full shrink-0 items-center gap-1.5 border-r border-line px-2.5 text-[12px] text-dim transition hover:bg-fill-1"
              classList={{ "bg-void text-ink": isActive() }}
            >
              <Show when={isActive()}>
                <span class="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-accent" />
              </Show>
              <button
                class="flex items-center gap-1.5"
                onClick={() => props.onSelect(path)}
                title={path}
              >
                <Icon size={13} class="shrink-0" style={{ color }} />
                <span
                  class="max-w-[200px] truncate"
                  classList={{ "font-medium": isActive() }}
                >
                  {basenameOf(path)}
                </span>
                <Show when={isDirty()}>
                  <span class="ml-0.5 text-[14px] leading-none text-dim">•</span>
                </Show>
              </button>
              <button
                class="rounded p-0.5 text-faint opacity-0 transition hover:bg-fill-2 hover:text-ink group-hover:opacity-100"
                classList={{ "opacity-100": isActive() }}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(path);
                }}
                title="fechar"
              >
                <X size={12} />
              </button>
            </div>
          );
        }}
      </For>
    </div>
  );
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
