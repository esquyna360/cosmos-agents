import {
  batch,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { rust } from "@codemirror/lang-rust";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { php } from "@codemirror/lang-php";
import { ChevronRight, Search as SearchIcon } from "lucide-solid";

import FileTree from "./FileTree";
import EditorTabs from "./EditorTabs";
import { fsReadFile, fsWriteFile } from "../lib/fs";
import { cosmosEditorTheme } from "../lib/cmTheme";
import { themeTick } from "../stores/theme";
import {
  deleteFileState,
  editorOpenRequest,
  focusedProject,
  focusedProjectId,
  getFileState,
  setEditorActivePath,
  setEditorDirty,
  setEditorOpenPaths,
  setFileState,
} from "../stores/projects";

interface Props {
  roots: string[];
}

const AUTOSAVE_MS = 800;
const MAX_OPEN_TABS = 12;

// Save timers live per project so a debounced save survives a view switch.
// (When Editor unmounts the timer keeps ticking; when it remounts we don't
// re-create a duplicate timer because we look up by projectId+path.)
const saveTimersByProject = new Map<
  string,
  Map<string, ReturnType<typeof setTimeout>>
>();
function getTimers(projectId: string): Map<string, ReturnType<typeof setTimeout>> {
  let m = saveTimersByProject.get(projectId);
  if (!m) {
    m = new Map();
    saveTimersByProject.set(projectId, m);
  }
  return m;
}

interface Cursor {
  line: number;
  col: number;
  ranges: number;
  selected: number;
}

export default function Editor(props: Props) {
  const projectId = () => focusedProjectId() ?? "";
  // Slice the store-backed editor state for this project. Two reads per
  // render but Solid caches, and it lets us avoid wiring a third store on
  // each consumer.
  const openPaths = () => focusedProject()?.editor.openPaths ?? [];
  const activePath = () => focusedProject()?.editor.activePath ?? null;
  const dirty = () => focusedProject()?.editor.dirty ?? {};

  const [saving, setSaving] = createSignal<Record<string, boolean>>({});
  const [cursor, setCursor] = createSignal<Cursor>({
    line: 1,
    col: 1,
    ranges: 1,
    selected: 0,
  });

  let view: EditorView | undefined;
  let host!: HTMLDivElement;

  function markDirty(path: string, isDirty: boolean) {
    const pid = projectId();
    if (pid) setEditorDirty(pid, path, isDirty);
  }
  function markSaving(path: string, on: boolean) {
    setSaving((d) => ({ ...d, [path]: on }));
  }

  async function flush(path: string) {
    const pid = projectId();
    const state = getFileState<EditorState>(pid, path);
    if (!state) return;
    const text = state.doc.toString();
    markSaving(path, true);
    try {
      await fsWriteFile(path, text);
      markDirty(path, false);
    } catch (e) {
      console.error("[editor] save failed", e);
    } finally {
      markSaving(path, false);
    }
  }

  function scheduleSave(path: string) {
    const pid = projectId();
    if (!pid) return;
    markDirty(path, true);
    const timers = getTimers(pid);
    const prev = timers.get(path);
    if (prev) clearTimeout(prev);
    timers.set(
      path,
      setTimeout(() => flush(path), AUTOSAVE_MS),
    );
  }

  /** ⌘S — the file already autosaves, but muscle memory deserves an answer. */
  function saveNow(): boolean {
    const pid = projectId();
    const path = activePath();
    if (!pid || !path) return false;
    if (view) setFileState(pid, path, view.state);
    const t = getTimers(pid).get(path);
    if (t) clearTimeout(t);
    flush(path);
    return true;
  }

  function readCursor(state: EditorState): Cursor {
    const sel = state.selection;
    const head = sel.main.head;
    const line = state.doc.lineAt(head);
    let selected = 0;
    for (const r of sel.ranges) selected += r.to - r.from;
    return {
      line: line.number,
      col: head - line.from + 1,
      ranges: sel.ranges.length,
      selected,
    };
  }

  function buildState(doc: string, path: string, at?: number): EditorState {
    const pid = projectId();
    const exts: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      EditorState.allowMultipleSelections.of(true),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      indentUnit.of("  "),
      indentationMarkers({ hideFirstIndent: true, highlightActiveBlock: true }),
      autocompletion({ activateOnTyping: true, closeOnBlur: true }),
      search({ top: true }),
      highlightSelectionMatches(),
      keymap.of([
        { key: "Mod-s", run: saveNow, preventDefault: true },
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      cosmosEditorTheme(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u: ViewUpdate) => {
        if (u.docChanged) {
          setFileState(pid, path, u.state);
          scheduleSave(path);
        }
        if (u.docChanged || u.selectionSet) setCursor(readCursor(u.state));
      }),
    ];
    const lang = languageFor(path);
    if (lang) exts.push(lang);
    const anchor = at === undefined ? undefined : Math.min(at, doc.length);
    return EditorState.create({
      doc,
      extensions: exts,
      selection: anchor === undefined ? undefined : { anchor },
    });
  }

  async function ensureLoaded(path: string) {
    const pid = projectId();
    if (getFileState(pid, path)) return;
    try {
      const text = await fsReadFile(path);
      setFileState(pid, path, buildState(text, path));
    } catch (e) {
      console.error("[editor] open failed", e);
    }
  }

  async function openFile(path: string) {
    const pid = projectId();
    if (!pid) return;
    // Persist current edits before switching.
    const cur = activePath();
    if (cur && view) setFileState(pid, cur, view.state);
    if (cur && dirty()[cur]) {
      const t = getTimers(pid).get(cur);
      if (t) clearTimeout(t);
      await flush(cur);
    }
    await ensureLoaded(path);

    batch(() => {
      const paths = openPaths();
      let next = paths;
      if (!paths.includes(path)) {
        next = [...paths, path];
        if (next.length > MAX_OPEN_TABS) {
          next = next.slice(next.length - MAX_OPEN_TABS);
        }
        setEditorOpenPaths(pid, next);
      }
      setEditorActivePath(pid, path);
    });

    const state = getFileState<EditorState>(pid, path);
    if (state && view) {
      view.setState(state);
      setCursor(readCursor(state));
      view.focus();
    }
  }

  async function closeFile(path: string) {
    const pid = projectId();
    if (!pid) return;
    if (dirty()[path]) {
      const t = getTimers(pid).get(path);
      if (t) clearTimeout(t);
      await flush(path);
    }
    deleteFileState(pid, path);
    getTimers(pid).delete(path);

    const wasActive = activePath() === path;
    const newPaths = openPaths().filter((p) => p !== path);
    batch(() => {
      setEditorOpenPaths(pid, newPaths);
      setEditorDirty(pid, path, false);
      if (wasActive) {
        const next = newPaths[newPaths.length - 1] ?? null;
        setEditorActivePath(pid, next);
        if (next && view) {
          const s = getFileState<EditorState>(pid, next);
          if (s) view.setState(s);
        } else if (view) {
          // No tabs left — show empty state via a blank readonly doc.
          view.setState(
            EditorState.create({
              doc: "",
              extensions: [EditorState.readOnly.of(true)],
            }),
          );
        }
      }
    });
  }

  // External requests (Cmd+P / grep) open the file in a tab.
  createEffect(() => {
    const req = editorOpenRequest();
    if (!req?.path) return;
    openFile(req.path).then(() => {
      if (req.line && view) {
        const line = Math.max(1, req.line);
        const pos = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      }
    });
  });

  // CodeMirror bakes its colours in at extension-build time, so a theme swap
  // means rebuilding every cached state. Cheap: they are already in memory,
  // and the caret position survives.
  createEffect(
    on(
      themeTick,
      () => {
        const pid = projectId();
        if (!pid) return;
        const cur = activePath();
        if (cur && view) setFileState(pid, cur, view.state);
        for (const path of openPaths()) {
          const s = getFileState<EditorState>(pid, path);
          if (!s) continue;
          setFileState(pid, path, buildState(s.doc.toString(), path, s.selection.main.head));
        }
        if (cur && view) {
          const s = getFileState<EditorState>(pid, cur);
          if (s) view.setState(s);
        }
      },
      { defer: true },
    ),
  );

  onMount(() => {
    view = new EditorView({
      state: EditorState.create({ doc: "", extensions: [EditorState.readOnly.of(true)] }),
      parent: host,
    });
    // Rehydrate from persisted state on (re-)mount: if a path was active in
    // this project's editor view, load it back into the visible CM6 view.
    const pid = projectId();
    const persistedActive = activePath();
    if (pid && persistedActive) {
      // For every previously-open path, lazy-load its content so its CM6
      // state is in the map before the user clicks the tab. We only mount
      // the active path into the visible view immediately.
      Promise.all(openPaths().map(ensureLoaded)).then(() => {
        const s = getFileState<EditorState>(pid, persistedActive);
        if (s && view) {
          view.setState(s);
          setCursor(readCursor(s));
        }
      });
    }
  });

  onCleanup(() => {
    // Best-effort flush of dirty files. Timers stay in the per-project map
    // and continue ticking even after unmount — that's intentional, so the
    // file gets written even if Bruno switches view before AUTOSAVE_MS.
    const pid = projectId();
    if (pid) {
      const d = dirty();
      for (const p of Object.keys(d)) {
        if (d[p]) flush(p);
      }
    }
    view?.destroy();
    view = undefined;
  });

  const crumbs = () => {
    const path = activePath();
    if (!path) return [];
    const root = props.roots.find((r) => path.startsWith(r));
    const rel = root ? path.slice(root.length).replace(/^\/+/, "") : path;
    return rel.split("/").filter(Boolean);
  };

  return (
    <div class="flex h-full w-full">
      <div class="flex w-60 shrink-0 flex-col overflow-hidden border-r border-line bg-panel">
        <div class="flex items-center justify-between px-3 pb-1.5 pt-2 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-faint">
          <span>arquivos</span>
          <span class="tracking-normal">⌘P · ⌘⇧F</span>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <FileTree
            roots={props.roots}
            onOpenFile={openFile}
            selectedPath={activePath()}
          />
        </div>
      </div>

      <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-void">
        <EditorTabs
          paths={openPaths()}
          active={activePath()}
          dirty={dirty()}
          onSelect={openFile}
          onClose={closeFile}
        />

        <Show
          when={activePath()}
          fallback={
            <div class="flex flex-1 flex-col items-center justify-center gap-2 text-faint">
              <p class="text-[12.5px] text-dim">nenhum arquivo aberto</p>
              <p class="text-[11px]">⌘P por nome · ⌘⇧F por conteúdo</p>
            </div>
          }
        >
          <div class="flex h-[26px] shrink-0 items-center gap-1 border-b border-line px-3 text-[10.5px] text-faint">
            {crumbs().map((c, i) => (
              <>
                <Show when={i > 0}>
                  <ChevronRight size={9} class="shrink-0 opacity-60" />
                </Show>
                <span
                  class="truncate"
                  classList={{ "text-dim": i === crumbs().length - 1 }}
                >
                  {c}
                </span>
              </>
            ))}
            <button
              class="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition hover:bg-fill-2 hover:text-ink"
              onClick={() => view && openSearchPanel(view)}
              title="buscar no arquivo (⌘F)"
            >
              <SearchIcon size={10} />
              ⌘F
            </button>
          </div>
        </Show>

        <div ref={host} class="min-h-0 flex-1 overflow-hidden" />

        <Show when={activePath()}>
          <div class="flex h-[22px] shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[10.5px] tabular-nums text-faint">
            <span>
              Ln {cursor().line}, Col {cursor().col}
            </span>
            <Show when={cursor().selected > 0}>
              <span>
                {cursor().selected} sel
                {cursor().ranges > 1 ? ` · ${cursor().ranges} cursores` : ""}
              </span>
            </Show>
            <span class="ml-auto">2 espaços</span>
            <span>{languageLabel(activePath()!)}</span>
            <span
              classList={{
                "text-busy": !!dirty()[activePath()!],
                "text-live": !dirty()[activePath()!],
              }}
            >
              {saving()[activePath()!]
                ? "salvando…"
                : dirty()[activePath()!]
                  ? "modificado"
                  : "salvo"}
            </span>
          </div>
        </Show>
      </div>
    </div>
  );
}

const LANGUAGES: Record<string, { label: string; ext: () => Extension }> = {
  ts: { label: "TypeScript", ext: () => javascript({ jsx: true, typescript: true }) },
  tsx: { label: "TSX", ext: () => javascript({ jsx: true, typescript: true }) },
  mts: { label: "TypeScript", ext: () => javascript({ typescript: true }) },
  cts: { label: "TypeScript", ext: () => javascript({ typescript: true }) },
  js: { label: "JavaScript", ext: () => javascript({ jsx: true }) },
  jsx: { label: "JSX", ext: () => javascript({ jsx: true }) },
  mjs: { label: "JavaScript", ext: () => javascript() },
  cjs: { label: "JavaScript", ext: () => javascript() },
  json: { label: "JSON", ext: () => json() },
  jsonc: { label: "JSON", ext: () => json() },
  rs: { label: "Rust", ext: () => rust() },
  md: { label: "Markdown", ext: () => markdown() },
  markdown: { label: "Markdown", ext: () => markdown() },
  mdx: { label: "MDX", ext: () => markdown() },
  html: { label: "HTML", ext: () => html() },
  htm: { label: "HTML", ext: () => html() },
  vue: { label: "Vue", ext: () => html() },
  svelte: { label: "Svelte", ext: () => html() },
  css: { label: "CSS", ext: () => css() },
  scss: { label: "SCSS", ext: () => css() },
  less: { label: "Less", ext: () => css() },
  py: { label: "Python", ext: () => python() },
  yaml: { label: "YAML", ext: () => yaml() },
  yml: { label: "YAML", ext: () => yaml() },
  sql: { label: "SQL", ext: () => sql() },
  xml: { label: "XML", ext: () => xml() },
  svg: { label: "SVG", ext: () => xml() },
  plist: { label: "XML", ext: () => xml() },
  go: { label: "Go", ext: () => go() },
  java: { label: "Java", ext: () => java() },
  kt: { label: "Kotlin", ext: () => java() },
  c: { label: "C", ext: () => cpp() },
  h: { label: "C", ext: () => cpp() },
  cc: { label: "C++", ext: () => cpp() },
  cpp: { label: "C++", ext: () => cpp() },
  hpp: { label: "C++", ext: () => cpp() },
  m: { label: "Obj-C", ext: () => cpp() },
  php: { label: "PHP", ext: () => php() },
  dart: { label: "Dart", ext: () => java() },
};

function extOf(path: string): string {
  return path.split("/").pop()?.split(".").slice(1).pop()?.toLowerCase() ?? "";
}

function languageFor(path: string): Extension | null {
  return LANGUAGES[extOf(path)]?.ext() ?? null;
}

function languageLabel(path: string): string {
  return LANGUAGES[extOf(path)]?.label ?? "texto";
}
