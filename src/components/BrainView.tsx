import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { ArrowUpRight, Check, FileText, Link2, Maximize2, Pencil, Plus, Search, Waypoints, X } from "lucide-solid";

import { compact } from "../stores/layout";

import BrainGraph from "./BrainGraph";
import { cosmosEditorTheme } from "../lib/cmTheme";
import {
  brainCreate,
  brainOpen,
  brainSave,
  brainSearch,
  sourceColor,
  sourceLabel,
  SOURCES,
  type Hit,
  type Mention,
  type Note,
  type Opened,
} from "../lib/brain";
import {
  byId,
  closeNote,
  index,
  loaded,
  opened,
  openId,
  openNote,
  pane,
  refreshBrain,
  reloadOpen,
  setPane,
  setShowOrphans,
  setSourceFilter,
  setTagFilter,
  showOrphans,
  sourceFilter,
  tagFilter,
  watchBrain,
} from "../stores/brain";

const PAGE = 120;

function since(unix: number): string {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 90) return "agora";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  if (s < 86_400 * 14) return `${Math.round(s / 86_400)} d`;
  if (s < 86_400 * 60) return `${Math.round(s / (86_400 * 7))} sem`;
  return new Date(unix * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "2-digit" });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// What the open note's links point at, read by the renderer below.
let linkTargets: Record<string, string> = {};

const md = new Marked({ gfm: true, breaks: false });
md.use({
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start: (src: string) => src.indexOf("[["),
      tokenizer(src: string) {
        const m = /^\[\[([^\]\n|#]+)(#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/.exec(src);
        if (!m) return undefined;
        return { type: "wikilink", raw: m[0], target: m[1].trim(), label: (m[3] ?? m[1]).trim() };
      },
      renderer(token) {
        const target = String(token.target);
        const missing = linkTargets[target] ? "" : ' data-missing="true"';
        return `<a class="cx-wiki" data-wiki="${escapeHtml(target)}"${missing}>${escapeHtml(String(token.label))}</a>`;
      },
    },
  ],
});

function withoutFrontmatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\n---\r?\n?/, "");
}

function render(opened: Opened): string {
  linkTargets = opened.resolved ?? {};
  let body = withoutFrontmatter(opened.content).trimStart();
  // The pane already shows the title; a first heading repeating it is noise.
  const first = /^# +(.+)\r?\n?/.exec(body);
  if (first && first[1].trim() === opened.note.title) body = body.slice(first[0].length);
  return DOMPurify.sanitize(md.parse(body) as string);
}

/** A line of Markdown as plain reading text, for excerpts. */
function plain(line: string): string {
  return line
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target, label) => label ?? target)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+\.|#+|>)\s+/, "")
    .replace(/[*_`]{1,2}/g, "");
}

export default function BrainView() {
  onCleanup(watchBrain());

  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<Hit[] | null>(null);
  const [cursor, setCursor] = createSignal(0);
  const [shown, setShown] = createSignal(PAGE);
  const [moreTags, setMoreTags] = createSignal(false);
  const [fitTick, setFitTick] = createSignal(0);
  const [creating, setCreating] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal(false);
  let searchInput!: HTMLInputElement;

  const filtered = createMemo(() => {
    const source = sourceFilter();
    const tag = tagFilter();
    return index().notes.filter((n) => (!source || n.source === source) && (!tag || n.tags.includes(tag)));
  });

  const recent = createMemo(() => [...filtered()].sort((a, b) => b.modified - a.modified));

  const counts = createMemo(() => {
    const out: Record<string, number> = {};
    for (const n of index().notes) out[n.source] = (out[n.source] ?? 0) + 1;
    return out;
  });

  const graphNotes = createMemo(() => {
    const all = filtered();
    if (showOrphans()) return all;
    const inside = new Set(all.map((n) => n.id));
    const linked = new Set<string>();
    for (const n of all) {
      for (const to of n.links) {
        if (inside.has(to) && to !== n.id) {
          linked.add(n.id);
          linked.add(to);
        }
      }
    }
    return all.filter((n) => linked.has(n.id));
  });

  const linkCount = createMemo(() => {
    const inside = new Set(graphNotes().map((n) => n.id));
    let total = 0;
    for (const n of graphNotes()) for (const to of n.links) if (inside.has(to)) total++;
    return total;
  });

  let searchTimer: number | undefined;
  let searchTicket = 0;
  createEffect(
    on([query, sourceFilter, tagFilter], ([q, source, tag]) => {
      window.clearTimeout(searchTimer);
      setCursor(0);
      setShown(PAGE);
      const text = q.trim();
      if (!text) {
        searchTicket++;
        setHits(null);
        return;
      }
      const full = [text, source ? `fonte:${source}` : "", tag ? `tag:${tag}` : ""].filter(Boolean).join(" ");
      const mine = ++searchTicket;
      searchTimer = window.setTimeout(() => {
        brainSearch(full, 80)
          .then((found) => {
            if (mine === searchTicket) setHits(found ?? []);
          })
          .catch(console.error);
      }, 110);
    }),
  );

  interface Row {
    id: string;
    title: string;
    source: string;
    group: string;
    detail: string;
    when: number;
  }

  const rows = createMemo<Row[]>(() => {
    const found = hits();
    if (found) {
      return found.map((h) => ({
        id: h.id,
        title: h.title,
        source: h.source,
        group: h.group,
        detail: h.snippet,
        when: byId().get(h.id)?.modified ?? 0,
      }));
    }
    return recent()
      .slice(0, shown())
      .map((n) => ({ id: n.id, title: n.title, source: n.source, group: n.group, detail: n.description, when: n.modified }));
  });

  // On a phone the three columns become three screens.
  const [phone, setPhone] = createSignal<"list" | "main" | "ctx">("list");

  function pick(id: string): void {
    if (compact()) {
      openNote(id, "note");
      setPhone("main");
      return;
    }
    openNote(id, pane() === "graph" ? null : "note");
  }

  function onSearchKey(e: KeyboardEvent): void {
    const list = rows();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(list.length - 1, Math.max(0, cursor() + (e.key === "ArrowDown" ? 1 : -1)));
      setCursor(next);
      document.querySelector(`[data-brain-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && list[cursor()]) {
      e.preventDefault();
      openNote(list[cursor()].id);
    } else if (e.key === "Escape") {
      if (query()) setQuery("");
      else searchInput.blur();
    }
  }

  function onKey(e: KeyboardEvent): void {
    const typing = (e.target as HTMLElement)?.closest("input, textarea, .cm-editor, [contenteditable]");
    if (e.key === "/" && !typing) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && !e.shiftKey) {
      e.preventDefault();
      setCreating("");
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g" && !e.shiftKey && !typing) {
      e.preventDefault();
      setPane(pane() === "graph" ? "note" : "graph");
    }
  }
  onMount(() => {
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  async function create(title: string, tags: string[]): Promise<string | null> {
    try {
      const note = await brainCreate(title, "", tags);
      await refreshBrain();
      setCreating(null);
      setQuery("");
      openNote(note.id);
      setEditing(true);
      return null;
    } catch (e) {
      return String(e);
    }
  }

  createEffect(on(openId, () => setEditing(false), { defer: true }));

  const visibleTags = createMemo(() => index().tags.slice(0, moreTags() ? 60 : 12));

  return (
    <div class="cx-brain flex min-h-0 flex-1" data-m={compact() ? phone() : undefined}>
      <aside class="cx-brain-side flex w-[300px] shrink-0 flex-col border-r border-line bg-panel">
        <div class="flex items-center gap-2 px-3 pb-2 pt-3">
          <label class="cx-brain-search flex h-[32px] min-w-0 flex-1 items-center gap-2 rounded-[9px] px-2.5">
            <Search size={13} class="shrink-0 text-faint" />
            <input
              ref={searchInput}
              class="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
              placeholder="Buscar no cérebro"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onSearchKey}
              spellcheck={false}
            />
            <Show when={query()} fallback={<span class="cx-kbd">/</span>}>
              <button class="text-faint hover:text-ink" title="Limpar" onClick={() => setQuery("")}>
                <X size={13} />
              </button>
            </Show>
          </label>
          <button class="cx-icon-btn !h-[32px] !w-[32px]" title="Nova nota (⌘N)" onClick={() => setCreating("")}>
            <Plus size={15} />
          </button>
        </div>

        <div class="flex flex-wrap gap-1 px-3 pb-2">
          <button class="cx-brain-chip" data-on={!sourceFilter()} onClick={() => setSourceFilter(null)}>
            Tudo <span class="opacity-60">{index().notes.length}</span>
          </button>
          <For each={SOURCES.filter((s) => counts()[s.id])}>
            {(s) => (
              <button
                class="cx-brain-chip"
                data-on={sourceFilter() === s.id}
                onClick={() => setSourceFilter(sourceFilter() === s.id ? null : s.id)}
              >
                <span class="h-[7px] w-[7px] rounded-full" style={{ background: s.color }} />
                {s.label} <span class="opacity-60">{counts()[s.id]}</span>
              </button>
            )}
          </For>
        </div>

        <Show when={index().tags.length > 0}>
          <div class="flex flex-wrap gap-x-2 gap-y-0.5 border-t border-line px-3 py-2">
            <For each={visibleTags()}>
              {([tag, n]) => (
                <button
                  class="cx-brain-tag"
                  data-on={tagFilter() === tag}
                  onClick={() => setTagFilter(tagFilter() === tag ? null : tag)}
                >
                  #{tag}
                  <span class="opacity-50">{n}</span>
                </button>
              )}
            </For>
            <Show when={index().tags.length > 12}>
              <button class="cx-brain-tag !text-faint" onClick={() => setMoreTags(!moreTags())}>
                {moreTags() ? "menos" : `+${Math.min(index().tags.length, 60) - 12}`}
              </button>
            </Show>
          </div>
        </Show>

        <div
          class="min-h-0 flex-1 overflow-y-auto border-t border-line px-1.5 py-1.5"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (!hits() && el.scrollTop + el.clientHeight > el.scrollHeight - 400 && shown() < recent().length) {
              setShown(shown() + PAGE);
            }
          }}
        >
          <Show
            when={rows().length > 0}
            fallback={
              <div class="px-3 py-10 text-center text-[12.5px] leading-relaxed text-faint">
                <Show when={loaded()} fallback="Lendo o vault…">
                  <Show when={query()} fallback="Nenhuma nota com esse filtro.">
                    Nada com “{query()}”.
                    <button class="mt-2 block w-full text-accent hover:underline" onClick={() => setCreating(query())}>
                      Criar a nota “{query()}”
                    </button>
                  </Show>
                </Show>
              </div>
            }
          >
            <For each={rows()}>
              {(row, i) => (
                <button
                  class="cx-brain-row"
                  data-brain-row={i()}
                  data-on={openId() === row.id}
                  data-cursor={hits() !== null && cursor() === i()}
                  onClick={() => pick(row.id)}
                  onDblClick={() => openNote(row.id)}
                >
                  <span class="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: sourceColor(row.source) }} />
                  <span class="min-w-0 flex-1">
                    <span class="flex items-baseline gap-2">
                      <span class="min-w-0 flex-1 truncate text-[13px] text-ink">{row.title}</span>
                      <span class="shrink-0 text-[11px] tabular-nums text-faint">{row.when ? since(row.when) : ""}</span>
                    </span>
                    <span class="block truncate text-[11.5px] text-faint">
                      {sourceLabel(row.source)}
                      {row.group ? ` · ${row.group}` : ""}
                    </span>
                    <Show when={row.detail}>
                      <span class="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-dim">{row.detail}</span>
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </aside>

      <section class="relative flex min-w-0 flex-1 flex-col">
        <header class="flex h-[44px] shrink-0 items-center gap-2 border-b border-line px-3">
          <div class="cx-brain-seg">
            <button data-on={pane() === "graph"} onClick={() => setPane("graph")} title="Grafo (⌘G)">
              <Waypoints size={13} /> Grafo
            </button>
            <button data-on={pane() === "note"} onClick={() => setPane("note")} title="Nota (⌘G)">
              <FileText size={13} /> Nota
            </button>
          </div>
          <Show when={pane() === "graph"}>
            <span class="ml-1 text-[12px] tabular-nums text-faint">
              {graphNotes().length} notas · {linkCount()} links
            </span>
            <div class="flex-1" />
            <button
              class="cx-pill !h-[26px]"
              data-on={showOrphans()}
              title="Mostrar também as notas sem nenhum link"
              onClick={() => setShowOrphans(!showOrphans())}
            >
              Soltas
            </button>
            <button class="cx-icon-btn" title="Enquadrar tudo" onClick={() => setFitTick(fitTick() + 1)}>
              <Maximize2 size={14} />
            </button>
          </Show>
        </header>

        <div class="relative min-h-0 flex-1">
          <div class="absolute inset-0" style={{ display: pane() === "graph" ? "block" : "none" }}>
            <Show
              when={graphNotes().length > 0}
              fallback={
                <div class="flex h-full items-center justify-center text-[13px] text-faint">
                  {loaded() ? "Nenhuma nota ligada com esse filtro. Ative “Soltas” para ver todas." : "Lendo o vault…"}
                </div>
              }
            >
              <BrainGraph
                notes={graphNotes()}
                selected={openId()}
                onSelect={(id) => openNote(id, null)}
                onOpen={(id) => openNote(id)}
                fitTick={fitTick()}
              />
              <div class="cx-brain-legend">
                <For each={SOURCES.filter((s) => counts()[s.id])}>
                  {(s) => (
                    <button
                      data-off={sourceFilter() !== null && sourceFilter() !== s.id}
                      onClick={() => setSourceFilter(sourceFilter() === s.id ? null : s.id)}
                    >
                      <span class="h-[8px] w-[8px] rounded-full" style={{ background: s.color }} />
                      {s.label}
                    </button>
                  )}
                </For>
              </div>
              <div class="cx-brain-hint">arraste para mover · role para aproximar · dois cliques abrem a nota</div>
            </Show>
          </div>
          <Show when={pane() === "note"}>
            <Show
              when={opened()?.note.id}
              keyed
              fallback={
                <div class="flex h-full flex-col items-center justify-center gap-3 text-center text-faint">
                  <FileText size={26} class="opacity-50" />
                  <div class="text-[13px] leading-relaxed">
                    Escolha uma nota na lista ou no grafo.
                    <br />
                    <span class="cx-kbd">/</span> busca · <span class="cx-kbd">⌘N</span> nova nota
                  </div>
                </div>
              }
            >
              {(id) => {
                // Saving reloads the note; the pane (and the cursor in its
                // editor) must outlive that.
                const current = createMemo<Opened>((prev) => {
                  const next = opened();
                  return next && next.note.id === id ? next : prev;
                }, opened()!);
                return (
                  <NotePane
                    opened={current()}
                    editing={editing()}
                    setEditing={setEditing}
                    onMissing={(title) => setCreating(title)}
                  />
                );
              }}
            </Show>
          </Show>
        </div>
      </section>

      <aside class="cx-brain-ctx flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
        <Show when={opened()} fallback={<Overview />}>
          {(current) => <Context opened={current()} showOpen={pane() === "graph"} onMissing={(t) => setCreating(t)} />}
        </Show>
      </aside>

      <Show when={creating() !== null}>
        <NewNote initial={creating() ?? ""} onClose={() => setCreating(null)} onCreate={create} />
      </Show>
      <Show when={compact()}>
        <nav class="cx-brain-phone">
          <button data-on={phone() === "list"} onClick={() => setPhone("list")}>
            <Search size={14} /> Notas
          </button>
          <button
            data-on={phone() === "main"}
            onClick={() => {
              setPhone("main");
              // The graph was laid out while it had no room.
              requestAnimationFrame(() => setFitTick(fitTick() + 1));
            }}
          >
            <Waypoints size={14} /> {pane() === "graph" ? "Grafo" : "Nota"}
          </button>
          <button data-on={phone() === "ctx"} onClick={() => setPhone("ctx")}>
            <Link2 size={14} /> Ligações
          </button>
        </nav>
      </Show>
    </div>
  );
}

/* --------------------------------- note --------------------------------- */

function NotePane(props: {
  opened: Opened;
  editing: boolean;
  setEditing: (on: boolean) => void;
  onMissing: (title: string) => void;
}) {
  const note = () => props.opened.note;
  const [draft, setDraft] = createSignal(props.opened.content);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [conflict, setConflict] = createSignal(false);
  const [error, setError] = createSignal("");
  const dirty = () => draft() !== props.opened.content;
  const html = createMemo(() => render(props.opened));

  async function save(force = false): Promise<void> {
    if (!dirty() || saving()) return;
    setSaving(true);
    setError("");
    try {
      if (!force) {
        const disk = await brainOpen(note().id);
        if (disk.content !== props.opened.content) {
          setConflict(true);
          return;
        }
      }
      await brainSave(note().id, draft());
      setConflict(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
      await refreshBrain();
      reloadOpen();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // Leaving a note with edits keeps them, unless the file changed underneath.
  onCleanup(() => {
    if (!dirty() || conflict()) return;
    const id = note().id;
    const mine = draft();
    const base = props.opened.content;
    brainOpen(id)
      .then((disk) => (disk.content === base ? brainSave(id, mine) : null))
      .then((done) => done && refreshBrain())
      .catch(console.error);
  });

  function onKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
      e.preventDefault();
      toggle();
    }
  }
  onMount(() => {
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  function toggle(): void {
    if (props.editing && dirty()) void save();
    props.setEditing(!props.editing);
  }

  function onClick(e: MouseEvent): void {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const wiki = a.getAttribute("data-wiki");
    if (wiki !== null) {
      const to = props.opened.resolved[wiki];
      if (to) openNote(to);
      else props.onMissing(wiki);
      return;
    }
    const href = a.getAttribute("href") ?? "";
    if (/^https?:\/\//.test(href)) {
      invoke("open_external", { url: href }).catch(console.error);
      return;
    }
    let local = href.split("#")[0];
    try {
      local = decodeURIComponent(local);
    } catch {
      /* keep as written */
    }
    const to = props.opened.resolved[local];
    if (to) openNote(to);
  }

  return (
    <div class="cx-brain-note absolute inset-0 flex flex-col">
      <div class="flex shrink-0 items-start gap-3 px-8 pb-3 pt-6">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 text-[11.5px] text-faint">
            <span class="h-[7px] w-[7px] rounded-full" style={{ background: sourceColor(note().source) }} />
            {sourceLabel(note().source)}
            <Show when={note().group}> · {note().group}</Show>
            <span>· {since(note().modified)}</span>
          </div>
          <h1 class="cx-brain-title mt-1 truncate">{note().title}</h1>
          <Show when={note().description && !props.editing}>
            <p class="mt-1 text-[13.5px] leading-relaxed text-dim">{note().description}</p>
          </Show>
        </div>
        <Show when={saved()}>
          <span class="mt-1 flex items-center gap-1 text-[12px] text-live">
            <Check size={13} /> salvo
          </span>
        </Show>
        <Show when={props.editing}>
          <button class="cx-btn-primary !h-[28px] !px-3 !text-[12.5px]" disabled={!dirty() || saving()} onClick={() => save()}>
            Salvar <span class="opacity-60">⌘S</span>
          </button>
        </Show>
        <button class="cx-pill cx-pill-line" data-on={props.editing} title="Editar (⌘E)" onClick={toggle}>
          <Pencil size={12} /> {props.editing ? "Ler" : "Editar"}
        </button>
        <button class="cx-icon-btn" title="Fechar a nota" onClick={closeNote}>
          <X size={15} />
        </button>
      </div>

      <Show when={conflict()}>
        <div class="mx-8 mb-2 flex items-center gap-3 rounded-[10px] bg-busy-soft px-3 py-2 text-[12.5px] text-ink">
          <span class="min-w-0 flex-1">Esta nota mudou no disco enquanto você editava (um agente escreveu nela).</span>
          <button class="cx-pill cx-pill-line !h-[26px]" onClick={() => save(true)}>
            Ficar com a minha
          </button>
          <button
            class="cx-pill cx-pill-line !h-[26px]"
            onClick={() => {
              setConflict(false);
              props.setEditing(false);
              reloadOpen();
            }}
          >
            Recarregar
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <div class="mx-8 mb-2 rounded-[10px] bg-alert-soft px-3 py-2 text-[12.5px] text-ink">{error()}</div>
      </Show>

      <Show
        when={props.editing}
        fallback={
          <div class="min-h-0 flex-1 overflow-y-auto px-8 pb-16">
            <div
              class="cosmos-prose cx-brain-prose max-w-[760px] text-[14px] leading-relaxed text-ink"
              onClick={onClick}
              // eslint-disable-next-line solid/no-innerhtml
              innerHTML={html()}
            />
          </div>
        }
      >
        <NoteEditor initial={props.opened.content} onChange={setDraft} />
      </Show>
    </div>
  );
}

function NoteEditor(props: { initial: string; onChange: (next: string) => void }) {
  let host!: HTMLDivElement;
  onMount(() => {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.initial,
        selection: { anchor: props.initial.length },
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          cosmosEditorTheme(),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "100%", fontSize: "13.5px", backgroundColor: "transparent" },
            ".cm-scroller": { padding: "4px 32px 64px", lineHeight: "1.65" },
            ".cm-content": { padding: "0", maxWidth: "760px" },
            "&.cm-focused": { outline: "none" },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) props.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    queueMicrotask(() => view.focus());
    onCleanup(() => view.destroy());
  });
  return <div ref={host} class="min-h-0 min-w-0 flex-1 overflow-hidden" />;
}

/* -------------------------------- context ------------------------------- */

function Mentions(props: { title: string; list: Mention[]; empty: string }) {
  return (
    <section class="border-t border-line px-3 py-3">
      <h3 class="cx-brain-h">
        {props.title} <span class="opacity-60">{props.list.length}</span>
      </h3>
      <Show when={props.list.length > 0} fallback={<p class="text-[12px] leading-relaxed text-faint">{props.empty}</p>}>
        <For each={props.list}>
          {(m) => (
            <button class="cx-brain-mention" onClick={() => openNote(m.id, null)} onDblClick={() => openNote(m.id)}>
              <span class="flex items-center gap-1.5">
                <span class="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: sourceColor(m.source) }} />
                <span class="min-w-0 flex-1 truncate text-[12.5px] text-ink">{m.title}</span>
              </span>
              <Show when={m.context}>
                <span class="mt-0.5 line-clamp-3 block text-[11.5px] leading-snug text-dim">{plain(m.context)}</span>
              </Show>
            </button>
          )}
        </For>
      </Show>
    </section>
  );
}

function Context(props: { opened: Opened; showOpen: boolean; onMissing: (title: string) => void }) {
  const note = () => props.opened.note;
  const excerpt = createMemo(() => {
    const body = withoutFrontmatter(props.opened.content)
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("<!--") && !l.startsWith("```"))
      .map(plain)
      .join(" ");
    return body.length > 320 ? `${body.slice(0, 320).trimEnd()}…` : body;
  });
  const [copied, setCopied] = createSignal(false);

  return (
    <>
      <section class="px-3 pb-3 pt-3.5">
        <div class="flex items-center gap-2 text-[11.5px] text-faint">
          <span class="h-[7px] w-[7px] rounded-full" style={{ background: sourceColor(note().source) }} />
          {sourceLabel(note().source)}
          <Show when={note().group}> · {note().group}</Show>
        </div>
        <div class="mt-1 text-[14px] font-medium leading-snug text-ink">{note().title}</div>
        <Show when={props.showOpen}>
          <p class="mt-1.5 text-[12.5px] leading-relaxed text-dim">{note().description || excerpt()}</p>
          <button class="cx-btn-primary mt-3 !h-[30px] w-full !text-[12.5px]" onClick={() => setPane("note")}>
            Abrir nota <ArrowUpRight size={13} />
          </button>
        </Show>
        <div class="mt-3 flex flex-wrap gap-x-2 gap-y-0.5">
          <For each={note().tags}>
            {(tag) => (
              <button class="cx-brain-tag" data-on={tagFilter() === tag} onClick={() => setTagFilter(tagFilter() === tag ? null : tag)}>
                #{tag}
              </button>
            )}
          </For>
        </div>
        <div class="mt-2 text-[11.5px] tabular-nums text-faint">
          {note().words} palavras · mudou há {since(note().modified)}
        </div>
        <button
          class="mt-1 block w-full truncate text-left font-mono text-[11px] text-faint hover:text-dim"
          title="Copiar o caminho"
          onClick={() => {
            navigator.clipboard?.writeText(note().path).catch(() => {});
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied() ? "copiado" : note().id}
        </button>
      </section>
      <Mentions title="Citada por" list={props.opened.backlinks} empty="Nenhuma nota cita esta ainda. Escreva [[nome]] em outra para ligar." />
      <Mentions title="Cita" list={props.opened.outgoing} empty="Esta nota não cita nenhuma outra." />
      <Show when={note().dangling.length > 0}>
        <section class="border-t border-line px-3 py-3">
          <h3 class="cx-brain-h">
            Links sem nota <span class="opacity-60">{note().dangling.length}</span>
          </h3>
          <div class="flex flex-wrap gap-1">
            <For each={note().dangling}>
              {(name) => (
                <button class="cx-brain-chip" title="Criar esta nota" onClick={() => props.onMissing(name)}>
                  <Plus size={11} /> {name}
                </button>
              )}
            </For>
          </div>
        </section>
      </Show>
    </>
  );
}

function Overview() {
  const top = createMemo(() =>
    [...index().notes]
      .filter((n) => n.backlinks > 0)
      .sort((a, b) => b.backlinks - a.backlinks)
      .slice(0, 10),
  );
  const fresh = createMemo(() => [...index().notes].sort((a, b) => b.modified - a.modified).slice(0, 6));
  const links = createMemo(() => index().notes.reduce((sum, n) => sum + n.links.length, 0));
  const missing = createMemo(() => index().notes.reduce((sum, n) => sum + n.dangling.length, 0));

  const Row = (p: { note: Note; right: string }) => (
    <button class="cx-brain-mention" onClick={() => openNote(p.note.id, null)} onDblClick={() => openNote(p.note.id)}>
      <span class="flex items-center gap-1.5">
        <span class="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: sourceColor(p.note.source) }} />
        <span class="min-w-0 flex-1 truncate text-[12.5px] text-ink">
          {p.note.title}
          <Show when={p.note.group && !p.note.title.includes(p.note.group)}>
            <span class="text-faint"> · {p.note.group}</span>
          </Show>
        </span>
        <span class="shrink-0 text-[11px] tabular-nums text-faint">{p.right}</span>
      </span>
    </button>
  );

  return (
    <>
      <section class="px-3 pb-3 pt-3.5">
        <div class="cx-brain-title !text-[19px]">Cérebro</div>
        <p class="mt-1 text-[12.5px] leading-relaxed text-dim">
          Tudo que os agentes sabem, num lugar só: memórias, CLAUDE.md, diretrizes e dev logs, ligados por <code>[[links]]</code>.
        </p>
        <div class="mt-3 grid grid-cols-3 gap-1.5">
          <Stat n={index().notes.length} label="notas" />
          <Stat n={links()} label="links" />
          <Stat n={missing()} label="sem nota" />
        </div>
      </section>
      <Show when={top().length > 0}>
        <section class="border-t border-line px-3 py-3">
          <h3 class="cx-brain-h">Mais citadas</h3>
          <For each={top()}>{(n) => <Row note={n} right={String(n.backlinks)} />}</For>
        </section>
      </Show>
      <section class="border-t border-line px-3 py-3">
        <h3 class="cx-brain-h">Mexidas por último</h3>
        <For each={fresh()}>{(n) => <Row note={n} right={since(n.modified)} />}</For>
      </section>
      <section class="border-t border-line px-3 py-3">
        <h3 class="cx-brain-h">Os agentes usam assim</h3>
        <pre class="cx-brain-cli">
          cosmos brain search upload poki{"\n"}cosmos brain read web-portal-upload{"\n"}cosmos brain new "Título" --body -
        </pre>
      </section>
    </>
  );
}

function Stat(props: { n: number; label: string }) {
  return (
    <div class="rounded-[10px] bg-fill-1 px-2 py-2 text-center">
      <div class="text-[17px] font-semibold tabular-nums text-ink">{props.n.toLocaleString("pt-BR")}</div>
      <div class="text-[11px] text-faint">{props.label}</div>
    </div>
  );
}

/* -------------------------------- new note ------------------------------ */

function NewNote(props: {
  initial: string;
  onClose: () => void;
  onCreate: (title: string, tags: string[]) => Promise<string | null>;
}) {
  const [title, setTitle] = createSignal(props.initial);
  const [tags, setTags] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let input!: HTMLInputElement;
  onMount(() => input.focus());

  async function submit(e: Event): Promise<void> {
    e.preventDefault();
    if (!title().trim() || busy()) return;
    setBusy(true);
    const failed = await props.onCreate(
      title().trim(),
      tags()
        .split(/[\s,]+/)
        .map((t) => t.replace(/^#/, ""))
        .filter(Boolean),
    );
    setBusy(false);
    if (failed) setError(failed);
  }

  return (
    <div class="cx-brain-veil" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <form
        class="cx-brain-sheet"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div class="text-[11.5px] text-faint">Nova nota em ~/.cosmos/brain</div>
        <input
          ref={input}
          class="cx-brain-title mt-1 w-full bg-transparent outline-none placeholder:text-faint"
          placeholder="Título"
          value={title()}
          onInput={(e) => {
            setTitle(e.currentTarget.value);
            setError("");
          }}
          spellcheck={false}
        />
        <input
          class="mt-2 w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
          placeholder="tags, separadas por espaço (opcional)"
          value={tags()}
          onInput={(e) => setTags(e.currentTarget.value)}
          spellcheck={false}
        />
        <Show when={error()}>
          <div class="mt-3 rounded-[9px] bg-alert-soft px-3 py-2 text-[12.5px] text-ink">{error()}</div>
        </Show>
        <div class="mt-4 flex items-center justify-end gap-2">
          <button type="button" class="cx-pill" onClick={props.onClose}>
            Cancelar
          </button>
          <button type="submit" class="cx-btn-primary !h-[30px] !px-4 !text-[12.5px]" disabled={!title().trim() || busy()}>
            Criar e escrever
          </button>
        </div>
      </form>
    </div>
  );
}
