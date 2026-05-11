import { batch, createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { rust } from "@codemirror/lang-rust";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";

import FileTree from "./FileTree";
import EditorTabs from "./EditorTabs";
import { fsReadFile, fsWriteFile } from "../lib/fs";
import { editorOpenRequest } from "../stores/agents";

interface Props {
  roots: string[];
}

const AUTOSAVE_MS = 800;
const MAX_OPEN_TABS = 12;

export default function Editor(props: Props) {
  // Open files (in tab order) and which one is active.
  const [openPaths, setOpenPaths] = createSignal<string[]>([]);
  const [activePath, setActivePath] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal<Record<string, boolean>>({});
  const [saving, setSaving] = createSignal<Record<string, boolean>>({});

  // Per-file CM6 state so switching tabs preserves cursor/selection.
  const fileStates = new Map<string, EditorState>();
  let view: EditorView | undefined;
  let host!: HTMLDivElement;
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function markDirty(path: string, isDirty: boolean) {
    setDirty((d) => ({ ...d, [path]: isDirty }));
  }
  function markSaving(path: string, on: boolean) {
    setSaving((d) => ({ ...d, [path]: on }));
  }

  async function flush(path: string) {
    if (!view) return;
    const state = fileStates.get(path);
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
    markDirty(path, true);
    const prev = saveTimers.get(path);
    if (prev) clearTimeout(prev);
    saveTimers.set(
      path,
      setTimeout(() => flush(path), AUTOSAVE_MS),
    );
  }

  function buildState(doc: string, path: string): EditorState {
    const exts: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      bracketMatching(),
      indentOnInput(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      oneDark,
      EditorView.lineWrapping,
      EditorView.theme({
        "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
        ".cm-scroller": { fontFamily: '"Fira Code", ui-monospace, monospace' },
        ".cm-content": { padding: "8px 0" },
        ".cm-gutters": { backgroundColor: "transparent", border: "none" },
      }),
      EditorView.updateListener.of((u: ViewUpdate) => {
        if (u.docChanged) {
          fileStates.set(path, u.state);
          scheduleSave(path);
        }
      }),
    ];
    const lang = languageFor(path);
    if (lang) exts.push(lang);
    return EditorState.create({ doc, extensions: exts });
  }

  async function ensureLoaded(path: string) {
    if (fileStates.has(path)) return;
    try {
      const text = await fsReadFile(path);
      fileStates.set(path, buildState(text, path));
    } catch (e) {
      console.error("[editor] open failed", e);
    }
  }

  async function openFile(path: string) {
    // Persist current edits before switching.
    const cur = activePath();
    if (cur && view) fileStates.set(cur, view.state);
    if (cur && dirty()[cur]) {
      const t = saveTimers.get(cur);
      if (t) clearTimeout(t);
      await flush(cur);
    }
    await ensureLoaded(path);

    batch(() => {
      setOpenPaths((paths) => {
        if (paths.includes(path)) return paths;
        const next = [...paths, path];
        return next.length > MAX_OPEN_TABS ? next.slice(next.length - MAX_OPEN_TABS) : next;
      });
      setActivePath(path);
    });

    // Drop the loaded state into the view.
    const state = fileStates.get(path);
    if (state && view) {
      view.setState(state);
      view.focus();
    }
  }

  async function closeFile(path: string) {
    if (dirty()[path]) {
      const t = saveTimers.get(path);
      if (t) clearTimeout(t);
      await flush(path);
    }
    fileStates.delete(path);
    saveTimers.delete(path);

    const wasActive = activePath() === path;
    const newPaths = openPaths().filter((p) => p !== path);
    batch(() => {
      setOpenPaths(newPaths);
      setDirty((d) => {
        const n = { ...d };
        delete n[path];
        return n;
      });
      if (wasActive) {
        const next = newPaths[newPaths.length - 1] ?? null;
        setActivePath(next);
        if (next && view) {
          const s = fileStates.get(next);
          if (s) view.setState(s);
        } else if (view) {
          // No tabs left — show empty state by mounting a blank readonly doc.
          view.setState(EditorState.create({ doc: "", extensions: [EditorState.readOnly.of(true)] }));
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

  onMount(() => {
    view = new EditorView({
      state: EditorState.create({ doc: "", extensions: [EditorState.readOnly.of(true)] }),
      parent: host,
    });
  });

  onCleanup(() => {
    for (const t of saveTimers.values()) clearTimeout(t);
    saveTimers.clear();
    // Best-effort flush remaining dirty files.
    for (const p of Object.keys(dirty())) {
      if (dirty()[p]) flush(p);
    }
    view?.destroy();
  });

  return (
    <div class="flex h-full w-full">
      <div class="flex w-64 shrink-0 flex-col overflow-hidden border-r border-white/5 bg-[#0a0c0f]">
        <div class="flex items-center justify-between px-3 pb-2 pt-2 text-[11px] uppercase tracking-wider text-white/40">
          <span>files</span>
          <span class="normal-case text-white/30">⌘P · ⌘⇧F</span>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <FileTree
            roots={props.roots}
            onOpenFile={openFile}
            selectedPath={activePath()}
          />
        </div>
      </div>
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
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
            <div class="flex flex-1 items-center justify-center text-white/30">
              select a file from the tree or ⌘P
            </div>
          }
        >
          <div class="flex h-5 shrink-0 items-center justify-end gap-2 px-3 text-[10px] text-white/35">
            <Show when={dirty()[activePath()!]}>
              <span>{saving()[activePath()!] ? "saving…" : "modified"}</span>
            </Show>
          </div>
        </Show>
        <div ref={host} class="min-h-0 flex-1 overflow-hidden bg-[#0b0d10]" />
      </div>
    </div>
  );
}

function languageFor(path: string): Extension | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: true });
    case "json":
      return json();
    case "rs":
      return rust();
    case "md":
    case "markdown":
      return markdown();
    case "html":
    case "htm":
      return html();
    case "css":
    case "scss":
      return css();
    case "py":
      return python();
    default:
      return null;
  }
}
