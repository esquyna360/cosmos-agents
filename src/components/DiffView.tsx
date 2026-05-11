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
  root: string;
}

export default function DiffView(props: Props) {
  const [reloadToken, bumpReload] = createSignal(0);
  const [diff] = createResource(
    () => ({ root: props.root, token: reloadToken() }),
    async ({ root }) => {
      try {
        return { ok: true as const, text: await gitDiff(root) };
      } catch (e) {
        return { ok: false as const, err: String(e) };
      }
    },
  );

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-[#0b0d10]">
      <div class="flex h-7 shrink-0 items-center justify-between border-b border-white/5 px-3 text-[11px] text-white/40">
        <span class="truncate">git diff · {props.root}</span>
        <button
          class="rounded px-2 py-0.5 text-white/60 hover:bg-white/10 hover:text-white"
          onClick={() => bumpReload(reloadToken() + 1)}
          title="refresh"
        >
          ↻
        </button>
      </div>
      <Show
        when={diff()}
        fallback={
          <div class="flex flex-1 items-center justify-center text-white/30">
            loading diff…
          </div>
        }
        keyed
      >
        {(d) =>
          d.ok ? (
            <DiffEditor doc={d.text} />
          ) : (
            <div class="flex flex-1 items-center justify-center p-6 text-center text-white/40">
              <div>
                <p class="mb-2 text-sm text-white/60">no diff available</p>
                <p class="text-[11px]">{d.err}</p>
              </div>
            </div>
          )
        }
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
