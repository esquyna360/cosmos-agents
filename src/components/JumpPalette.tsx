import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { Plus, Search } from "lucide-solid";

import { focusRunner, newSession, projectsStore, type ProjectUI, type RunnerUI } from "../stores/projects";
import { closeJump } from "../stores/jump";
import { relativeTime } from "../lib/time";
import StatusGlyph, { glyphFor } from "../ui/StatusGlyph";

type Entry =
  | { kind: "session"; project: ProjectUI; runner: RunnerUI }
  | { kind: "new"; project: ProjectUI };

/** ⌘K: every session in every project, most recent first. */
export default function JumpPalette() {
  let input: HTMLInputElement | undefined;
  const [query, setQuery] = createSignal("");
  const [index, setIndex] = createSignal(0);
  onMount(() => input?.focus());

  const entries = createMemo<Entry[]>(() => {
    const q = query().trim().toLowerCase();
    const sessions: Entry[] = projectsStore.list
      .flatMap((project) => project.runners.map((runner) => ({ kind: "session" as const, project, runner })))
      .filter((e) => !q || `${e.runner.name} ${e.project.name}`.toLowerCase().includes(q))
      .sort((a, b) => b.runner.lastActive - a.runner.lastActive);
    const create: Entry[] = projectsStore.list
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .map((project) => ({ kind: "new" as const, project }));
    return [...sessions, ...create].slice(0, 40);
  });

  function run(e: Entry) {
    closeJump();
    if (e.kind === "session") focusRunner(e.project.id, e.runner.id);
    else void newSession(e.project.id);
  }

  return (
    <div
      class="fixed inset-0 z-50 flex items-start justify-center bg-sunken backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && closeJump()}
    >
      <div class="cx-glass cx-sheet mt-[12vh] flex max-h-[64vh] w-[580px] max-w-[92vw] flex-col overflow-hidden rounded-cx-lg border border-line-strong">
        <div class="flex shrink-0 items-center gap-2.5 border-b border-line px-3.5 py-2.5">
          <Search size={14} class="shrink-0 text-faint" />
          <input
            ref={input}
            class="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-faint"
            placeholder="Ir para uma sessão ou projeto"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              const n = entries().length;
              if (e.key === "Escape") closeJump();
              else if (e.key === "ArrowDown" && n) (e.preventDefault(), setIndex((index() + 1) % n));
              else if (e.key === "ArrowUp" && n) (e.preventDefault(), setIndex((index() - 1 + n) % n));
              else if (e.key === "Enter" && entries()[index()]) run(entries()[index()]);
            }}
          />
        </div>
        <ul class="min-h-0 flex-1 overflow-y-auto p-1">
          <For each={entries()} fallback={<li class="px-3 py-6 text-center text-[12.5px] text-faint">Nada com esse nome.</li>}>
            {(e, i) => (
              <li>
                <button
                  class="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left"
                  classList={{ "bg-fill-2": i() === index() }}
                  onMouseEnter={() => setIndex(i())}
                  onClick={() => run(e)}
                >
                  <Show
                    when={e.kind === "session" && e}
                    keyed
                    fallback={
                      <>
                        <Plus size={14} class="shrink-0 text-faint" />
                        <span class="truncate text-[13px] text-dim">Nova sessão em {e.project.name}</span>
                      </>
                    }
                  >
                    {(s) => (
                      <>
                        <StatusGlyph glyph={glyphFor(s.runner)} />
                        <span class="min-w-0 truncate text-[13px] text-ink">{s.runner.name}</span>
                        <span class="shrink-0 truncate text-[12px] text-faint">{s.project.name}</span>
                        <span class="ml-auto shrink-0 text-[11.5px] tabular-nums text-faint">
                          {relativeTime(s.runner.lastActive)}
                        </span>
                      </>
                    )}
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </div>
  );
}
