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

import { CornerDownLeft, FileSearch, Search } from "lucide-solid";

import { fsGrep, fsWalk, type GrepMatch } from "../lib/fs";
import { iconForFile } from "../lib/fileIcons";
import { openFileInEditor } from "../stores/projects";

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
      class="fixed inset-0 z-50 flex items-start justify-center bg-sunken backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="cx-glass cx-sheet mt-[12vh] flex max-h-[70vh] w-[660px] max-w-[92vw] flex-col overflow-hidden rounded-cx-lg border border-line">
        <div class="flex shrink-0 items-center gap-2 px-3 pt-2.5">
          <span class="shrink-0 text-faint">
            {props.mode === "files" ? <FileSearch size={13} /> : <Search size={13} />}
          </span>
          <input
            ref={inputRef}
            class="min-w-0 flex-1 bg-transparent py-1 text-[14px] text-ink outline-none placeholder:text-faint"
            placeholder={
              props.mode === "files"
                ? "abrir arquivo por nome…"
                : "buscar no conteúdo (2+ caracteres)…"
            }
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <Show when={showRootLabel()}>
            <span class="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-faint">
              {props.roots.length} pastas
            </span>
          </Show>
          <span class="shrink-0 text-[10.5px] text-faint">esc fecha</span>
        </div>

        <div class="mt-2 shrink-0 border-t border-line" />

        <ul class="min-h-0 flex-1 overflow-y-auto p-1">
          <Show when={props.mode === "files"}>
            <For each={filteredFiles()}>
              {(f, i) => {
                const { Icon, color } = iconForFile(basename(f.rel));
                const on = () => cursor() === i();
                return (
                  <li>
                    <button
                      class="relative flex w-full items-center gap-2 rounded-cx px-2 py-1.5 text-left text-[13px] transition"
                      classList={{
                        "bg-accent-soft text-ink shadow-[inset_2px_0_0_0_var(--accent)]":
                          on(),
                        "text-dim hover:bg-fill-1": !on(),
                      }}
                      onMouseEnter={() => setCursor(i())}
                      onClick={pickCurrent}
                    >
                      <Icon size={13} class="shrink-0" style={{ color }} />
                      <span class="truncate text-ink">{basename(f.rel)}</span>
                      <span class="ml-auto truncate pl-3 text-[11px] text-faint">
                        <Show when={showRootLabel()}>
                          <span class="text-dim">{basename(f.root)}/</span>
                        </Show>
                        {dirname(f.rel)}
                      </span>
                      <Show when={on()}>
                        <CornerDownLeft size={11} class="shrink-0 text-accent" />
                      </Show>
                    </button>
                  </li>
                );
              }}
            </For>
          </Show>
          <Show when={props.mode === "grep"}>
            <For each={grepResults() ?? []}>
              {(m, i) => {
                const on = () => cursor() === i();
                return (
                  <li>
                    <button
                      class="flex w-full flex-col items-start gap-0.5 rounded-cx px-2 py-1.5 text-left transition"
                      classList={{
                        "bg-accent-soft shadow-[inset_2px_0_0_0_var(--accent)]": on(),
                        "hover:bg-fill-1": !on(),
                      }}
                      onMouseEnter={() => setCursor(i())}
                      onClick={pickCurrent}
                    >
                      <span class="text-[10.5px] text-faint">
                        <Show when={showRootLabel()}>
                          <span class="text-dim">{basename(m.root)}/</span>
                        </Show>
                        {m.path}:{m.line}
                      </span>
                      <span class="w-full truncate font-mono text-[12px] text-ink">
                        {m.text}
                      </span>
                    </button>
                  </li>
                );
              }}
            </For>
          </Show>
          <Show when={total() === 0 && query().length > 0}>
            <li class="px-3 py-4 text-center text-[12.5px] text-faint">
              nada com “{query()}”
            </li>
          </Show>
          <Show when={props.mode === "grep" && query().length === 1}>
            <li class="px-3 py-4 text-center text-[12.5px] text-faint">
              digite 2+ caracteres
            </li>
          </Show>
        </ul>

        <div class="flex shrink-0 items-center gap-3 border-t border-line px-3 py-1.5 text-[10.5px] text-faint">
          <span>↑↓ navegar</span>
          <span>⏎ abrir</span>
          <span class="ml-auto tabular-nums">
            {total()} resultado{total() === 1 ? "" : "s"}
          </span>
        </div>
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
