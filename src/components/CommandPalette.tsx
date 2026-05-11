import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  onCleanup,
  onMount,
} from "solid-js";

import { fsGrep, fsWalk, type GrepMatch } from "../lib/fs";
import { openFileInEditor } from "../stores/agents";

export type PaletteMode = "files" | "grep";

interface Props {
  mode: PaletteMode;
  root: string;
  onClose: () => void;
}

export default function CommandPalette(props: Props) {
  let inputRef!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);

  // Files: walked once per root, then filtered client-side as the user types.
  const [files] = createResource(
    () => (props.mode === "files" ? props.root : null),
    (root) => fsWalk(root),
  );

  // Grep: hits the backend whenever the (debounced) query changes.
  const [debouncedGrepQuery, setDebouncedGrepQuery] = createSignal("");
  let grepTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (props.mode !== "grep") return;
    const q = query();
    if (grepTimer) clearTimeout(grepTimer);
    grepTimer = setTimeout(() => setDebouncedGrepQuery(q), 180);
  });

  const [grepResults] = createResource<GrepMatch[], string>(
    () => (props.mode === "grep" ? debouncedGrepQuery() : ""),
    async (q) => {
      if (!q || q.length < 2) return [];
      return fsGrep(props.root, q);
    },
  );

  const filteredFiles = createMemo(() => {
    if (props.mode !== "files") return [];
    const all = files() ?? [];
    const q = query().toLowerCase();
    if (!q) return all.slice(0, 200);
    return all.filter((p) => p.toLowerCase().includes(q)).slice(0, 200);
  });

  const total = createMemo(() => {
    if (props.mode === "files") return filteredFiles().length;
    return (grepResults() ?? []).length;
  });

  // Reset cursor whenever the result set churns.
  createEffect(() => {
    void total();
    setCursor(0);
  });

  onMount(() => {
    inputRef.focus();
    document.addEventListener("keydown", onKey, true);
  });

  onCleanup(() => {
    document.removeEventListener("keydown", onKey, true);
    if (grepTimer) clearTimeout(grepTimer);
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(total() - 1, 0)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      pickCurrent();
    }
  }

  function pickCurrent() {
    if (props.mode === "files") {
      const rel = filteredFiles()[cursor()];
      if (!rel) return;
      openFileInEditor(joinPath(props.root, rel));
      props.onClose();
    } else {
      const m = (grepResults() ?? [])[cursor()];
      if (!m) return;
      openFileInEditor(joinPath(props.root, m.path), m.line);
      props.onClose();
    }
  }

  return (
    <div
      class="absolute inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="mt-20 w-[640px] max-w-[90vw] overflow-hidden rounded-lg border border-white/10 bg-[#0e1116] shadow-2xl">
        <div class="flex items-center gap-2 border-b border-white/5 px-3 py-2 text-xs uppercase tracking-wider text-white/40">
          {props.mode === "files" ? "find file" : "search in files"}
          <span class="ml-auto text-white/30">esc to close</span>
        </div>
        <input
          ref={inputRef}
          class="w-full bg-transparent px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/30"
          placeholder={
            props.mode === "files"
              ? "filename fragment…"
              : "text to find (>=2 chars)…"
          }
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <ul class="max-h-[420px] overflow-y-auto border-t border-white/5">
          <Show when={props.mode === "files"}>
            <For each={filteredFiles()}>
              {(rel, i) => (
                <li>
                  <button
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-white/5"
                    classList={{ "bg-white/10": cursor() === i() }}
                    onMouseEnter={() => setCursor(i())}
                    onClick={pickCurrent}
                  >
                    <span class="truncate text-white/90">{basename(rel)}</span>
                    <span class="ml-auto truncate text-[11px] text-white/40">
                      {dirname(rel)}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </Show>
          <Show when={props.mode === "grep"}>
            <For each={grepResults() ?? []}>
              {(m, i) => (
                <li>
                  <button
                    class="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm hover:bg-white/5"
                    classList={{ "bg-white/10": cursor() === i() }}
                    onMouseEnter={() => setCursor(i())}
                    onClick={pickCurrent}
                  >
                    <span class="text-[11px] text-white/40">
                      {m.path}:{m.line}
                    </span>
                    <span class="line-clamp-1 w-full truncate text-white/85">
                      {m.text}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </Show>
          <Show when={total() === 0 && query().length > 0}>
            <li class="px-3 py-3 text-sm text-white/40">no matches</li>
          </Show>
          <Show when={props.mode === "grep" && query().length === 1}>
            <li class="px-3 py-3 text-sm text-white/40">type 2+ characters</li>
          </Show>
        </ul>
      </div>
    </div>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}
function joinPath(root: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  return `${root.replace(/\/$/, "")}/${rel}`;
}
