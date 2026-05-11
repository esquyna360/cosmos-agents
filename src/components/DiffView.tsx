import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  EditorView,
  Decoration,
  ViewPlugin,
  type ViewUpdate,
  lineNumbers,
} from "@codemirror/view";

import { gitDiff } from "../lib/git";

interface Props {
  roots: string[];
}

interface FolderDiff {
  root: string;
  ok: boolean;
  text: string;
}

function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

export default function DiffView(props: Props) {
  const [reloadToken, bumpReload] = createSignal(0);
  // Walk each root in parallel. For workspaces this gives a concatenated view
  // of every git repo's pending changes, headed by a folder marker line.
  const [diffs] = createResource(
    () => ({ roots: props.roots.join("|"), token: reloadToken() }),
    async () => {
      const results: FolderDiff[] = await Promise.all(
        props.roots.map(async (root) => {
          try {
            const text = await gitDiff(root);
            return { root, ok: true, text };
          } catch (e) {
            return { root, ok: false, text: String(e) };
          }
        }),
      );
      return results;
    },
  );

  const combinedDoc = () => {
    const list = diffs();
    if (!list) return null;
    if (list.length === 1) return list[0].ok ? list[0].text : null;
    // Multi-root: separator + folder marker before each diff body. The
    // separator line uses `### ` so the diff highlighter paints it as meta.
    const parts: string[] = [];
    for (const d of list) {
      parts.push(`### ${basename(d.root)} (${d.root})`);
      if (d.ok) {
        parts.push(d.text.trim().length === 0 ? "(no changes)" : d.text);
      } else {
        parts.push(`-- not a git repository --`);
      }
      parts.push("");
    }
    return parts.join("\n");
  };

  const allFailed = () => {
    const list = diffs();
    return !!list && list.length > 0 && list.every((d) => !d.ok);
  };

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-[#0b0d10]">
      <div class="flex h-7 shrink-0 items-center justify-between border-b border-white/5 px-3 text-[11px] text-white/40">
        <span class="truncate">
          git diff · {props.roots.length === 1 ? props.roots[0] : `${props.roots.length} roots`}
        </span>
        <button
          class="rounded px-2 py-0.5 text-white/60 hover:bg-white/10 hover:text-white"
          onClick={() => bumpReload(reloadToken() + 1)}
          title="refresh"
        >
          ↻
        </button>
      </div>
      <Show
        when={diffs()}
        fallback={
          <div class="flex flex-1 items-center justify-center text-white/30">
            loading diff…
          </div>
        }
      >
        <Show
          when={!allFailed() && combinedDoc() !== null}
          fallback={
            <div class="flex flex-1 items-center justify-center p-6 text-center text-white/40">
              <div>
                <p class="mb-2 text-sm text-white/60">no diff available</p>
                <p class="text-[11px]">
                  {diffs()?.find((d) => !d.ok)?.text ?? "none of the roots are git repositories"}
                </p>
              </div>
            </div>
          }
        >
          <DiffEditor doc={combinedDoc() ?? ""} />
        </Show>
      </Show>
    </div>
  );
}

function DiffEditor(props: { doc: string }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;

  onMount(() => {
    view = new EditorView({
      state: EditorState.create({
        doc: props.doc.length === 0 ? "(no changes)" : props.doc,
        extensions: [
          EditorState.readOnly.of(true),
          lineNumbers(),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "100%", fontSize: "12.5px", backgroundColor: "transparent" },
            ".cm-scroller": { fontFamily: '"Fira Code", ui-monospace, monospace' },
            ".cm-content": { padding: "4px 0" },
            ".cm-gutters": {
              backgroundColor: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.25)",
            },
            ".cm-line": { padding: "0 10px" },
            ".cosmos-diff-add": {
              backgroundColor: "rgba(46,160,67,0.16)",
              color: "#7ee787",
            },
            ".cosmos-diff-del": {
              backgroundColor: "rgba(248,81,73,0.18)",
              color: "#ffa198",
            },
            ".cosmos-diff-hunk": {
              color: "#7d9bd5",
              backgroundColor: "rgba(125,155,213,0.07)",
            },
            ".cosmos-diff-meta": { color: "#7e8693" },
          }),
          diffHighlight(),
        ],
      }),
      parent: host,
    });
  });

  onCleanup(() => view?.destroy());

  return <div ref={host} class="min-h-0 flex-1 overflow-hidden" />;
}

/** Highlight every line based on its leading character: +, -, @, or diff header. */
function diffHighlight(): Extension {
  const addDeco = Decoration.line({ class: "cosmos-diff-add" });
  const delDeco = Decoration.line({ class: "cosmos-diff-del" });
  const hunkDeco = Decoration.line({ class: "cosmos-diff-hunk" });
  const metaDeco = Decoration.line({ class: "cosmos-diff-meta" });
  return ViewPlugin.fromClass(
    class {
      decorations;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
      }
      build(view: EditorView) {
        const b = new RangeSetBuilder<Decoration>();
        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          while (pos <= to) {
            const line = view.state.doc.lineAt(pos);
            const ch = line.text[0];
            const next2 = line.text.slice(0, 2);
            if (line.text.startsWith("+++") || line.text.startsWith("---")) {
              b.add(line.from, line.from, metaDeco);
            } else if (line.text.startsWith("@@")) {
              b.add(line.from, line.from, hunkDeco);
            } else if (
              ch === "+" &&
              next2 !== "++" /* exclude file headers handled above */
            ) {
              b.add(line.from, line.from, addDeco);
            } else if (ch === "-" && next2 !== "--") {
              b.add(line.from, line.from, delDeco);
            } else if (
              line.text.startsWith("diff ") ||
              line.text.startsWith("index ") ||
              line.text.startsWith("new file") ||
              line.text.startsWith("deleted file") ||
              line.text.startsWith("similarity") ||
              line.text.startsWith("rename ")
            ) {
              b.add(line.from, line.from, metaDeco);
            }
            pos = line.to + 1;
          }
        }
        return b.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
