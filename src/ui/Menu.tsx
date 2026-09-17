import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Check } from "lucide-solid";

export interface MenuItem {
  label: string;
  hint?: string;
  icon?: (p: { size?: number }) => JSX.Element;
  danger?: boolean;
  disabled?: boolean;
  /** Marks the current choice in a pick-one group. */
  checked?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

interface OpenAt {
  x: number;
  y: number;
  items: MenuItem[];
}

const [open, setOpen] = createSignal<OpenAt | null>(null);

/** True while the popup is up, so hover-driven chrome can hold still. */
export const menuOpen = () => open() !== null;

/** Opens the app's one popup menu at a point, or anchored under an element. */
export function openMenu(at: MouseEvent | HTMLElement, items: MenuItem[]): void {
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    setOpen({ x: r.left, y: r.bottom + 4, items });
  } else {
    at.preventDefault();
    setOpen({ x: at.clientX, y: at.clientY, items });
  }
}

export function closeMenu(): void {
  setOpen(null);
}

export function MenuHost() {
  let el: HTMLDivElement | undefined;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open()) {
      e.stopPropagation();
      closeMenu();
    }
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  const pos = () => {
    const o = open()!;
    const w = 220;
    const h = o.items.length * 30 + 12;
    return {
      left: `${Math.min(o.x, window.innerWidth - w - 8)}px`,
      top: `${Math.min(o.y, window.innerHeight - h - 8)}px`,
    };
  };

  return (
    <Show when={open()}>
      <Portal>
        <div
          class="fixed inset-0 z-[90]"
          onMouseDown={closeMenu}
          onContextMenu={(e) => {
            e.preventDefault();
            closeMenu();
          }}
        />
        <div
          ref={el}
          role="menu"
          class="cx-glass cx-sheet fixed z-[91] min-w-[200px] rounded-cx border border-line-strong p-1"
          style={pos()}
        >
          <For each={open()!.items}>
            {(item) => (
              <>
                <Show when={item.separatorBefore}>
                  <div class="mx-1 my-1 h-px bg-line" />
                </Show>
                <button
                  role="menuitem"
                  disabled={item.disabled}
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition disabled:opacity-35"
                  classList={{
                    "text-ink hover:bg-fill-2": !item.danger,
                    "text-alert hover:bg-alert-soft": item.danger,
                  }}
                  onClick={() => {
                    closeMenu();
                    item.onSelect();
                  }}
                >
                  <Show when={item.icon}>
                    <span class="flex w-4 shrink-0 justify-center opacity-70">
                      {item.icon!({ size: 13 })}
                    </span>
                  </Show>
                  <span class="min-w-0 flex-1 truncate">{item.label}</span>
                  <Show when={item.checked}>
                    <Check size={12} class="shrink-0 text-accent" />
                  </Show>
                  <Show when={item.hint}>
                    <span class="shrink-0 text-[11px] text-faint">{item.hint}</span>
                  </Show>
                </button>
              </>
            )}
          </For>
        </div>
      </Portal>
    </Show>
  );
}
