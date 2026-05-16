import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  EditorState,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  type ViewUpdate,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  Brain,
  Eye,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Scale,
  Scissors,
  Search,
  Square,
  Tag,
  Trash2,
  X,
} from "lucide-solid";

import {
  cardsFor,
  createCard,
  loadMemories,
  removeCard,
  updateCard,
} from "../stores/memory";
import type { MemoryCard, MemoryKind } from "../lib/memory";
import type { ProjectUI } from "../stores/projects";
import MarkdownView from "./MarkdownView";

interface Props {
  project: ProjectUI;
}

const KINDS: { id: MemoryKind; label: string; icon: typeof Brain }[] = [
  { id: "note", label: "note", icon: Brain },
  { id: "decision", label: "decision", icon: Scale },
  { id: "snippet", label: "snippet", icon: Scissors },
  { id: "todo", label: "todo", icon: Square },
];

const KIND_ICON = (k: MemoryKind) =>
  KINDS.find((x) => x.id === k)?.icon ?? Brain;

const AUTOSAVE_MS = 600;

export default function MemoryView(props: Props) {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [filterKind, setFilterKind] = createSignal<MemoryKind | "all">("all");
  const [search, setSearch] = createSignal("");
  const [mode, setMode] = createSignal<"edit" | "preview">("edit");

  // Always reload when the project changes (and on mount).
  createEffect(() => {
    loadMemories(props.project.id).catch(console.error);
  });

  const cards = createMemo(() => cardsFor(props.project.id));

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase();
    const k = filterKind();
    return cards().filter((c) => {
      if (k !== "all" && c.kind !== k) return false;
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.body.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  });

  // When the selected card disappears (delete) or list initialises, fall
  // back to the first available. Use cardsFor + selectedId directly to avoid
  // a separate `selected` memo whose identity flips on every save and would
  // re-key Show below, remounting the editor and dropping in-flight edits.
  createEffect(() => {
    const list = cards();
    if (list.length === 0) {
      setSelectedId(null);
      return;
    }
    const id = selectedId();
    if (!id || !list.some((c) => c.id === id)) {
      setSelectedId(list[0].id);
    }
  });

  async function onNew() {
    const k = filterKind();
    const card = await createCard(props.project.id, {
      title: "untitled",
      kind: k === "all" ? "note" : k,
    });
    setSelectedId(card.id);
    setMode("edit");
  }

  return (
    <div class="flex min-h-0 min-w-0 flex-1">
      <CardList
        cards={filtered()}
        totalCount={cards().length}
        selectedId={selectedId()}
        filterKind={filterKind()}
        search={search()}
        onSelect={setSelectedId}
        onSetKind={setFilterKind}
        onSetSearch={setSearch}
        onNew={onNew}
      />
      <div class="min-h-0 min-w-0 flex-1 border-l border-white/5">
        <Show
          when={selectedId()}
          fallback={
            <EmptyDetail
              hasAnyCards={cards().length > 0}
              onNew={onNew}
            />
          }
          keyed
        >
          {(id) => (
            <CardDetail
              projectId={props.project.id}
              cardId={id}
              mode={mode()}
              onSetMode={setMode}
            />
          )}
        </Show>
      </div>
    </div>
  );
}

/* ------------------------------- card list ------------------------------- */

function CardList(props: {
  cards: MemoryCard[];
  totalCount: number;
  selectedId: string | null;
  filterKind: MemoryKind | "all";
  search: string;
  onSelect: (id: string) => void;
  onSetKind: (k: MemoryKind | "all") => void;
  onSetSearch: (q: string) => void;
  onNew: () => void;
}) {
  return (
    <aside class="flex w-[320px] shrink-0 flex-col bg-[#0a0c0f]">
      <div class="flex shrink-0 items-center gap-2 px-3 py-2">
        <button
          class="flex shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-[12px] text-white hover:bg-white/15"
          onClick={props.onNew}
          title="new memory card"
        >
          <Plus size={12} />
          <span>new</span>
        </button>
        <div class="relative min-w-0 flex-1">
          <Search
            size={11}
            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-white/30"
          />
          <input
            class="w-full rounded-md border border-white/10 bg-black/30 py-1 pl-6 pr-2 text-[12px] text-white outline-none placeholder:text-white/30 focus:border-white/25"
            placeholder="search"
            value={props.search}
            onInput={(e) => props.onSetSearch(e.currentTarget.value)}
          />
        </div>
      </div>

      <div class="flex shrink-0 gap-1 overflow-x-auto px-3 pb-2">
        <KindPill
          active={props.filterKind === "all"}
          onClick={() => props.onSetKind("all")}
          icon={null}
          label="all"
          count={props.totalCount}
        />
        <For each={KINDS}>
          {(k) => (
            <KindPill
              active={props.filterKind === k.id}
              onClick={() => props.onSetKind(k.id)}
              icon={k.icon}
              label={k.label}
            />
          )}
        </For>
      </div>

      <ul class="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        <Show
          when={props.cards.length > 0}
          fallback={
            <li class="rounded-md border border-dashed border-white/10 px-3 py-4 text-center text-[11px] text-white/35">
              {props.totalCount === 0
                ? "no cards yet — hit + to add one"
                : "no matches"}
            </li>
          }
        >
          <For each={props.cards}>
            {(c) => (
              <CardRow
                card={c}
                active={props.selectedId === c.id}
                onClick={() => props.onSelect(c.id)}
              />
            )}
          </For>
        </Show>
      </ul>
    </aside>
  );
}

function KindPill(props: {
  active: boolean;
  onClick: () => void;
  icon: typeof Brain | null;
  label: string;
  count?: number;
}) {
  return (
    <button
      class="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] transition"
      classList={{
        "border-white/30 bg-white/15 text-white": props.active,
        "border-white/10 text-white/55 hover:border-white/20 hover:text-white":
          !props.active,
      }}
      onClick={props.onClick}
    >
      <Show when={props.icon}>
        {(I) => <Dynamic component={I()} size={10} />}
      </Show>
      <span>{props.label}</span>
      <Show when={typeof props.count === "number"}>
        <span class="text-white/35">·{props.count}</span>
      </Show>
    </button>
  );
}

function CardRow(props: {
  card: MemoryCard;
  active: boolean;
  onClick: () => void;
}) {
  const preview = () => {
    const stripped = props.card.body
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[#>*`_-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.slice(0, 140);
  };
  const accent = () => kindAccent(props.card.kind);
  return (
    <li>
      <button
        class="group flex w-full flex-col gap-1.5 rounded-md border bg-white/[0.02] p-2.5 text-left transition hover:bg-white/[0.05]"
        classList={{
          "!border-white/25 !bg-white/[0.08]": props.active,
          [accent().border]: !props.active,
        }}
        onClick={props.onClick}
      >
        <div class="flex items-center gap-1.5">
          <span class={`shrink-0 ${accent().icon}`}>
            <Dynamic component={KIND_ICON(props.card.kind)} size={11} />
          </span>
          <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium text-white/90">
            {props.card.title || "untitled"}
          </span>
          <Show when={props.card.pinned}>
            <Pin size={10} class="shrink-0 text-amber-300/80" />
          </Show>
        </div>
        <Show when={preview()}>
          <p class="line-clamp-2 text-[11px] leading-snug text-white/45">
            {preview()}
          </p>
        </Show>
        <Show when={props.card.tags.length > 0}>
          <div class="flex flex-wrap gap-1">
            <For each={props.card.tags.slice(0, 4)}>
              {(t) => (
                <span class="rounded-full bg-white/[0.06] px-1.5 py-[1px] text-[9.5px] text-white/55">
                  #{t}
                </span>
              )}
            </For>
          </div>
        </Show>
      </button>
    </li>
  );
}

function kindAccent(kind: MemoryKind): { border: string; icon: string } {
  switch (kind) {
    case "decision":
      return { border: "border-sky-400/15", icon: "text-sky-300/85" };
    case "snippet":
      return { border: "border-violet-400/15", icon: "text-violet-300/85" };
    case "todo":
      return { border: "border-emerald-400/15", icon: "text-emerald-300/85" };
    case "note":
    default:
      return { border: "border-white/10", icon: "text-white/55" };
  }
}

/* ------------------------------ card detail ------------------------------ */

function CardDetail(props: {
  projectId: string;
  cardId: string;
  mode: "edit" | "preview";
  onSetMode: (m: "edit" | "preview") => void;
}) {
  // Reactive lookup. When the card is saved, this memo updates with the
  // server's persisted version. We DON'T propagate that back into our local
  // title/body signals (that would clobber in-flight edits) — only the meta
  // pills (kind, tags, pinned) read it.
  const card = createMemo<MemoryCard | null>(
    () => cardsFor(props.projectId).find((c) => c.id === props.cardId) ?? null,
  );

  // Initial values are read ONCE at mount via `untrack`, so we don't subscribe
  // CardDetail to its own card. Show keyed on selectedId means we get a fresh
  // CardDetail when the user picks a different card — at that point this
  // initial read runs again with the new card's content.
  const initial = untrack(() => card());
  const [title, setTitle] = createSignal(initial?.title ?? "");
  const [body, setBody] = createSignal(initial?.body ?? "");
  const [tagDraft, setTagDraft] = createSignal("");

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSave(patch: Partial<MemoryCard>) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushSave(patch), AUTOSAVE_MS);
  }
  async function flushSave(patch: Partial<MemoryCard>) {
    const cur = card();
    if (!cur) return;
    try {
      await updateCard(props.projectId, {
        ...cur,
        title: title(),
        body: body(),
        ...patch,
      });
    } catch (e) {
      console.error("[memory] save failed", e);
    }
  }
  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer);
  });

  function commitImmediate(patch: Partial<MemoryCard>) {
    if (saveTimer) clearTimeout(saveTimer);
    flushSave(patch);
  }

  function onTagAdd(raw: string) {
    const cur = card();
    if (!cur) return;
    const t = raw.trim().replace(/^#/, "");
    if (!t) return;
    if (cur.tags.includes(t)) return;
    commitImmediate({ tags: [...cur.tags, t] });
  }
  function onTagRemove(t: string) {
    const cur = card();
    if (!cur) return;
    commitImmediate({ tags: cur.tags.filter((x) => x !== t) });
  }
  function onKindChange(k: MemoryKind) {
    commitImmediate({ kind: k });
  }
  function onTogglePin() {
    const cur = card();
    if (!cur) return;
    commitImmediate({ pinned: !cur.pinned });
  }
  async function onDelete() {
    await removeCard(props.projectId, props.cardId);
  }

  return (
    <div class="flex h-full flex-col">
      {/* Toolbar */}
      <div class="flex shrink-0 items-center gap-2 border-b border-white/5 px-4 py-2">
        <input
          class="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-[14px] font-medium text-white outline-none placeholder:text-white/35 hover:bg-white/[0.04] focus:bg-white/[0.06]"
          placeholder="untitled"
          value={title()}
          onInput={(e) => {
            setTitle(e.currentTarget.value);
            scheduleSave({});
          }}
          onBlur={() => commitImmediate({})}
        />
        <div class="flex shrink-0 items-center gap-0.5 rounded-md border border-white/10 bg-white/[0.03] p-0.5">
          <ToggleSeg
            active={props.mode === "edit"}
            onClick={() => props.onSetMode("edit")}
            icon={Pencil}
            label="edit"
          />
          <ToggleSeg
            active={props.mode === "preview"}
            onClick={() => props.onSetMode("preview")}
            icon={Eye}
            label="preview"
          />
        </div>
        <button
          class="shrink-0 rounded p-1.5"
          classList={{
            "text-amber-300/90 hover:bg-amber-300/10": !!card()?.pinned,
            "text-white/40 hover:bg-white/10 hover:text-white": !card()?.pinned,
          }}
          onClick={onTogglePin}
          title={
            card()?.pinned
              ? "unpin (won't auto-flow to Claude)"
              : "pin (auto-flows into the project CLAUDE.md)"
          }
        >
          {card()?.pinned ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
        <button
          class="shrink-0 rounded p-1.5 text-white/40 hover:bg-rose-500/15 hover:text-rose-300"
          onClick={onDelete}
          title="delete card"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Meta row */}
      <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/5 px-4 py-2 text-[11px]">
        <span class="text-white/40">kind:</span>
        <div class="flex items-center gap-0.5">
          <For each={KINDS}>
            {(k) => (
              <button
                class="flex items-center gap-1 rounded px-2 py-0.5 text-white/55 transition hover:bg-white/5 hover:text-white"
                classList={{
                  "!bg-white/10 !text-white": card()?.kind === k.id,
                }}
                onClick={() => onKindChange(k.id)}
              >
                <Dynamic component={k.icon} size={10} />
                <span>{k.label}</span>
              </button>
            )}
          </For>
        </div>
        <span class="ml-2 flex items-center gap-1 text-white/40">
          <Tag size={10} /> tags:
        </span>
        <div class="flex flex-wrap items-center gap-1">
          <For each={card()?.tags ?? []}>
            {(t) => (
              <span class="group/tag flex items-center gap-1 rounded-full bg-white/[0.06] px-2 py-[1px] text-white/75">
                <span>#{t}</span>
                <button
                  class="text-white/40 hover:text-white"
                  onClick={() => onTagRemove(t)}
                >
                  <X size={9} />
                </button>
              </span>
            )}
          </For>
          <input
            class="w-24 rounded-md bg-transparent px-1.5 py-0.5 text-white outline-none placeholder:text-white/30 focus:bg-white/[0.04]"
            placeholder="+ tag"
            value={tagDraft()}
            onInput={(e) => setTagDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              const tags = card()?.tags ?? [];
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                onTagAdd(tagDraft());
                setTagDraft("");
              } else if (e.key === "Backspace" && !tagDraft() && tags.length > 0) {
                onTagRemove(tags[tags.length - 1]);
              }
            }}
          />
        </div>
      </div>

      {/* Body. The wrapper is a flex column so the editor/preview can claim
          the remaining height via flex-1 + min-h-0. Earlier version used
          `overflow-y-auto` here which broke `h-full` inside, leaving CM6 at
          0px and silently dropping all keystrokes. */}
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <Show
          when={props.mode === "edit"}
          fallback={
            <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              <MarkdownView source={body()} />
              <Show when={!body().trim()}>
                <p class="text-[12px] italic text-white/30">empty</p>
              </Show>
            </div>
          }
        >
          <MarkdownEditor
            // Initial doc is the local body snapshot at CardDetail mount —
            // captured once via `untrack` so subsequent saves (which update
            // card() reactively) don't re-render this prop. The editor owns
            // its own state thereafter.
            initial={body()}
            onChange={(next) => {
              setBody(next);
              scheduleSave({ body: next });
            }}
          />
        </Show>
      </div>
    </div>
  );
}

function ToggleSeg(props: {
  active: boolean;
  onClick: () => void;
  icon: typeof Pencil;
  label: string;
}) {
  return (
    <button
      class="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/55 transition hover:bg-white/5 hover:text-white"
      classList={{ "!bg-white/15 !text-white": props.active }}
      onClick={props.onClick}
    >
      <props.icon size={10} />
      <span>{props.label}</span>
    </button>
  );
}

/* ---------------------------- markdown editor ---------------------------- */

/// CM6 wrapper that owns its own scrolling and undo history. The parent
/// component (CardDetail) is keyed on cardId via Show, so a different card
/// gives us a fresh MarkdownEditor instance with a fresh CM6 state — no
/// manual remount logic needed here.
function MarkdownEditor(props: {
  initial: string;
  onChange: (next: string) => void;
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;

  onMount(() => {
    const exts: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      oneDark,
      EditorView.lineWrapping,
      EditorView.theme({
        "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
        ".cm-scroller": {
          fontFamily: '"Fira Code", ui-monospace, monospace',
          padding: "12px 16px",
        },
        ".cm-content": { padding: "0" },
        ".cm-gutters": { backgroundColor: "transparent", border: "none" },
      }),
      EditorView.updateListener.of((u: ViewUpdate) => {
        if (u.docChanged) {
          props.onChange(u.state.doc.toString());
        }
      }),
    ];
    view = new EditorView({
      state: EditorState.create({ doc: props.initial, extensions: exts }),
      parent: host,
    });
    // Focus on mount so the user can type immediately after picking a card.
    queueMicrotask(() => view?.focus());
  });

  onCleanup(() => {
    view?.destroy();
    view = undefined;
  });

  return (
    <div
      ref={host}
      class="min-h-0 min-w-0 flex-1 overflow-hidden bg-[#0b0d10]"
    />
  );
}

/* ------------------------------ empty state ------------------------------ */

function EmptyDetail(props: { hasAnyCards: boolean; onNew: () => void }) {
  return (
    <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-white/40">
      <Brain size={28} class="text-white/25" />
      <Show
        when={props.hasAnyCards}
        fallback={
          <>
            <p class="text-sm">no memory yet — your project, your context</p>
            <p class="max-w-sm text-[12px] leading-relaxed text-white/35">
              cards are markdown files saved to{" "}
              <code class="rounded bg-white/[0.06] px-1 py-0.5 text-[11px]">
                ~/.cosmos/projects/&lt;slug&gt;/memories/
              </code>
              . pinned cards auto-flow into the project's generated CLAUDE.md
              so Claude reads them on every turn.
            </p>
            <button
              class="mt-1 flex items-center gap-1.5 rounded-md bg-white/15 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-white/25"
              onClick={props.onNew}
            >
              <Plus size={12} />
              new card
            </button>
          </>
        }
      >
        <p class="text-sm">pick a card on the left</p>
      </Show>
    </div>
  );
}
