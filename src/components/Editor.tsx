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

export default function Editor(props: Props) {
  const projectId = () => focusedProjectId() ?? "";
  // Slice the store-backed editor state for this project. Two reads per
  // render but Solid caches, and it lets us avoid wiring a third store on
  // each consumer.
  const openPaths = () => focusedProject()?.editor.openPaths ?? [];
  const activePath = () => focusedProject()?.editor.activePath ?? null;
  const dirty = () => focusedProject()?.editor.dirty ?? {};

  const [saving, setSaving] = createSignal<Record<string, boolean>>({});

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

  function buildState(doc: string, path: string): EditorState {
    const pid = projectId();
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
          setFileState(pid, path, u.state);
          scheduleSave(path);
        }
      }),
    ];
    const lang = languageFor(path);
    if (lang) exts.push(lang);
    return EditorState.create({ doc, extensions: exts });
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
