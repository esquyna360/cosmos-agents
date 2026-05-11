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
  roots: string[];
  onClose: () => void;
}

/** A unified entry in the merged file index: { root, rel } so we can rebuild
 *  the absolute path on selection and label results by root when there are
 *  multiple. */
interface FileEntry {
  root: string;
  rel: string;
}

/** A grep hit augmented with its source root for display + open. */
interface MatchEntry extends GrepMatch {
  root: string;
}

export default function CommandPalette(props: Props) {
  let inputRef!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);

  // Files: walk every root once, flatten into a merged list.
  const [files] = createResource(
    () => (props.mode === "files" ? props.roots.join("|") : null),
    async () => {
      const out: FileEntry[] = [];
      for (const root of props.roots) {
        try {
          const list = await fsWalk(root);
          for (const rel of list) out.push({ root, rel });
        } catch (e) {
          console.error("[palette] fsWalk failed for", root, e);
        }
      }
      return out;
    },
  );

  // Grep: debounce the query, then hit each root in parallel.
  const [debouncedGrepQuery, setDebouncedGrepQuery] = createSignal("");
  let grepTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (props.mode !== "grep") return;
    const q = query();
    if (grepTimer) clearTimeout(grepTimer);
    grepTimer = setTimeout(() => setDebouncedGrepQuery(q), 180);
  });

  const [grepResults] = createResource<MatchEntry[], string>(
    () => (props.mode === "grep" ? debouncedGrepQuery() : ""),
    async (q) => {
      if (!q || q.length < 2) return [];
      const out: MatchEntry[] = [];
      const results = await Promise.all(
        props.roots.map((root) =>
          fsGrep(root, q).then(
            (rs) => ({ root, rs }),
            (e) => {
              console.error("[palette] fsGrep failed for", root, e);
              return { root, rs: [] as GrepMatch[] };
            },
          ),
        ),
      );
      for (const { root, rs } of results) {
        for (const m of rs) out.push({ ...m, root });
      }
      return out;
    },
  );

  const showRootLabel = () => props.roots.length > 1;

  const filteredFiles = createMemo(() => {
    if (props.mode !== "files") return [] as FileEntry[];
    const all = files() ?? [];
    const q = query().toLowerCase();
    if (!q) return all.slice(0, 200);
    return all.filter((f) => f.rel.toLowerCase().includes(q)).slice(0, 200);
  });

  const total = createMemo(() => {
    if (props.mode === "files") return filteredFiles().length;
    return (grepResults() ?? []).length;
  });

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
      const f = filteredFiles()[cursor()];
      if (!f) return;
      openFileInEditor(joinPath(f.root, f.rel));
      props.onClose();
    } else {
      const m = (grepResults() ?? [])[cursor()];
      if (!m) return;
      openFileInEditor(joinPath(m.root, m.path), m.line);
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
          <Show when={showRootLabel()}>
            <span class="text-white/30">· {props.roots.length} roots</span>
          </Show>
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
              {(f, i) => (
                <li>
                  <button
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-white/5"
                    classList={{ "bg-white/10": cursor() === i() }}
                    onMouseEnter={() => setCursor(i())}
                    onClick={pickCurrent}
                  >
                    <span class="truncate text-white/90">{basename(f.rel)}</span>
                    <span class="ml-auto truncate text-[11px] text-white/40">
                      <Show when={showRootLabel()}>
                        <span class="text-white/55">{basename(f.root)}/</span>
                      </Show>
                      {dirname(f.rel)}
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
                      <Show when={showRootLabel()}>
                        <span class="text-white/55">{basename(m.root)}/</span>
                      </Show>
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
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
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
