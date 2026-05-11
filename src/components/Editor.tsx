import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewUpdate, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
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
import { fsReadFile, fsWriteFile } from "../lib/fs";
import { editorOpenRequest } from "../stores/agents";

interface Props {
  root: string;
}

const AUTOSAVE_MS = 800;

export default function Editor(props: Props) {
  const [openPath, setOpenPath] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleSave() {
    setDirty(true);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, AUTOSAVE_MS);
  }

  async function flush() {
    const path = openPath();
    if (!path || !view) return;
    const content = view.state.doc.toString();
    setSaving(true);
    try {
      await fsWriteFile(path, content);
      setDirty(false);
    } catch (e) {
      console.error("autosave failed", e);
    } finally {
      setSaving(false);
    }
  }

  async function openFile(path: string) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      await flush();
    }
    setOpenPath(path);
    try {
      const text = await fsReadFile(path);
      mountEditor(text, path);
    } catch (e) {
      console.error(e);
    }
  }

  function mountEditor(initial: string, path: string) {
    view?.destroy();
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
        "&": { height: "100%", fontSize: "13px" },
        ".cm-scroller": { fontFamily: '"Fira Code", ui-monospace, monospace' },
        ".cm-content": { padding: "8px 0" },
      }),
      EditorView.updateListener.of((u: ViewUpdate) => {
        if (u.docChanged) scheduleSave();
      }),
    ];
    const lang = languageFor(path);
    if (lang) exts.push(lang);
    view = new EditorView({
      state: EditorState.create({ doc: initial, extensions: exts }),
      parent: host,
    });
    view.focus();
  }

  onMount(() => {
    /* tree is the entrypoint — editor starts empty */
  });

  // External open requests (Cmd+P / grep results).
  createEffect(() => {
    const req = editorOpenRequest();
    if (req?.path) {
      openFile(req.path).then(() => {
        if (req.line && view) {
          const line = Math.max(1, req.line);
          const pos = view.state.doc.line(Math.min(line, view.state.doc.lines)).from;
          view.dispatch({
            selection: { anchor: pos },
            scrollIntoView: true,
          });
        }
      });
    }
  });

  onCleanup(() => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      flush();
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
            root={props.root}
            onOpenFile={openFile}
            selectedPath={openPath()}
          />
        </div>
      </div>
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <div class="flex h-7 shrink-0 items-center gap-2 border-b border-white/5 px-3 text-[11px] text-white/40">
          <Show when={openPath()} fallback={<span>select a file or ⌘P</span>}>
            <span class="truncate">{relativeTo(openPath()!, props.root)}</span>
            <Show when={dirty() || saving()}>
              <span class="text-white/30">{saving() ? "saving…" : "modified"}</span>
            </Show>
          </Show>
        </div>
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

function relativeTo(path: string, root: string): string {
  if (path.startsWith(root + "/")) return path.slice(root.length + 1);
  return path;
}
