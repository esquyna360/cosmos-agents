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
    <div class="flex h-8 shrink-0 items-center gap-px overflow-x-auto border-b border-white/5 bg-[#0a0c0f]">
      <For each={props.paths}>
        {(path) => {
          const isActive = () => props.active === path;
          const isDirty = () => !!props.dirty[path];
          const { Icon, color } = iconForFile(basenameOf(path));
          return (
            <div
              class="group flex h-full shrink-0 items-center gap-1.5 border-r border-white/5 px-2 text-[12px] text-white/70 hover:bg-white/5"
              classList={{ "bg-[#13161c] text-white": isActive() }}
            >
              <button
                class="flex items-center gap-1.5"
                onClick={() => props.onSelect(path)}
                title={path}
              >
                <Icon size={13} class="shrink-0" style={{ color }} />
                <span class="max-w-[200px] truncate">{basenameOf(path)}</span>
                <Show when={isDirty()}>
                  <span class="ml-0.5 text-[14px] leading-none text-white/60">•</span>
                </Show>
              </button>
              <button
                class="rounded p-0.5 text-white/30 opacity-0 hover:text-white group-hover:opacity-100"
                classList={{ "opacity-100": isActive() }}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(path);
                }}
                title="close"
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
