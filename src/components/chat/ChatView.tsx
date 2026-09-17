import { isMasterProject } from "../../stores/projects";
import { createEffect, createMemo, createSignal, For, Match, on, onMount, Show, Switch } from "solid-js";
import { ArrowDown, ChevronRight, X } from "lucide-solid";

import { chatOf, openChat, unqueue, type ChatItem } from "../../stores/chat";
import type { ProjectUI, RunnerUI } from "../../stores/projects";
import MarkdownView from "../MarkdownView";
import Composer from "./Composer";
import RequestCard from "./RequestCard";
import ToolRow from "./ToolRow";

interface Props {
  runner: RunnerUI;
  project: ProjectUI;
}

type Tool = Extract<ChatItem, { kind: "tool" }>;

export default function ChatView(props: Props) {
  let scroller: HTMLDivElement | undefined;
  const chat = () => chatOf(props.runner.id);
  const [pinned, setPinned] = createSignal(true);

  onMount(() => void openChat(props.runner.id));

  const top = createMemo(() => chat().items.filter((it) => !("parent" in it) || !it.parent));
  const stepsByParent = createMemo(() => {
    const map = new Map<string, Tool[]>();
    for (const it of chat().items) {
      if (it.kind !== "tool" || !it.parent) continue;
      map.set(it.parent, [...(map.get(it.parent) ?? []), it]);
    }
    return map;
  });

  const toBottom = () => scroller && (scroller.scrollTop = scroller.scrollHeight);

  // Follow the conversation only while the reader is already at the end;
  // scrolling up to read must not be fought.
  createEffect(
    on(
      () => {
        const items = chat().items;
        const last = items[items.length - 1];
        return [items.length, last && "text" in last ? last.text.length : 0, chat().pending.length];
      },
      () => pinned() && queueMicrotask(toBottom),
    ),
  );

  const lastIsStreaming = () => {
    const last = top()[top().length - 1];
    return !!last && (last.kind === "text" || last.kind === "thinking") && last.streaming;
  };

  return (
    <div class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-void">
      <div
        ref={scroller}
        class="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
        }}
      >
        <div class="mx-auto flex w-full max-w-[760px] flex-col gap-1 px-5 pb-6 pt-5">
          <Show when={top().length === 0 && chat().historyLoaded}>
            <Blank project={props.project} />
          </Show>
          <For each={top()}>
            {(item) => (
              <Switch>
                <Match when={item.kind === "user" && item} keyed>
                  {(u) => (
                    <div class="mb-1 mt-4 flex justify-end first:mt-0">
                      <div
                        class="group relative max-w-[85%] rounded-cx-lg bg-fill-2 px-3.5 py-2"
                        classList={{ "opacity-60": u.queued }}
                      >
                        <Show when={u.images.length > 0}>
                          <div class="mb-1.5 flex flex-wrap gap-1.5">
                            <For each={u.images}>
                              {(src) => (
                                <img src={src} alt="Imagem enviada" class="max-h-40 rounded-md border border-line" />
                              )}
                            </For>
                          </div>
                        </Show>
                        <p class="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink">
                          {u.text}
                        </p>
                        <Show when={u.queued}>
                          <p class="mt-1 flex items-center gap-1.5 text-[11.5px] text-dim">
                            Na fila
                            <button
                              class="rounded p-0.5 hover:bg-fill-3 hover:text-ink"
                              onClick={() => unqueue(props.runner.id, u.id)}
                              aria-label="Tirar da fila"
                              title="Tirar da fila"
                            >
                              <X size={11} />
                            </button>
                          </p>
                        </Show>
                      </div>
                    </div>
                  )}
                </Match>
                <Match when={item.kind === "text" && item} keyed>
                  {(t) => <MarkdownView source={t.text} class="chat-prose py-1 text-[13.5px]" />}
                </Match>
                <Match when={item.kind === "thinking" && item} keyed>
                  {(t) => <Thinking text={t.text} streaming={t.streaming} />}
                </Match>
                <Match when={item.kind === "tool" && item} keyed>
                  {(t) => (
                    <ToolRow
                      tool={t}
                      roots={props.project.folders}
                      steps={stepsByParent().get(t.id) ?? []}
                    />
                  )}
                </Match>
                <Match when={item.kind === "notice" && item} keyed>
                  {(n) => (
                    <p
                      class="my-1.5 whitespace-pre-wrap rounded-md px-2.5 py-1.5 text-[12.5px]"
                      classList={{
                        "bg-alert-soft text-alert": n.tone === "error",
                        "text-faint": n.tone === "info",
                      }}
                    >
                      {n.text}
                    </p>
                  )}
                </Match>
              </Switch>
            )}
          </For>
          <Show when={chat().busy && !lastIsStreaming() && chat().pending.length === 0}>
            <div class="flex items-center gap-2 px-1.5 py-1.5 text-[12.5px] text-dim">
              <span class="cx-spin h-3 w-3 rounded-full border-[1.5px] border-accent border-t-transparent" />
              {props.runner.activity || "Pensando"}
            </div>
          </Show>
        </div>
      </div>

      <Show when={!pinned()}>
        <button
          class="absolute bottom-[132px] left-1/2 z-10 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-line-strong bg-float text-dim shadow-cx transition hover:text-ink"
          onClick={() => {
            setPinned(true);
            toBottom();
          }}
          aria-label="Ir para o fim"
        >
          <ArrowDown size={14} />
        </button>
      </Show>

      <div class="mx-auto flex w-full max-w-[760px] shrink-0 flex-col gap-2 px-5 pb-4">
        <Show when={chat().pending.length > 0}>
          <div class="flex max-h-[58vh] flex-col gap-2 overflow-y-auto">
            <For each={chat().pending}>
              {(req) => <RequestCard runnerId={props.runner.id} request={req} roots={props.project.folders} />}
            </For>
          </div>
        </Show>
        <Composer
          runnerId={props.runner.id}
          roots={props.project.folders}
          blocked={chat().pending.length > 0}
        />
      </div>
    </div>
  );
}

function Thinking(props: { text: string; streaming: boolean }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div>
      <button
        class="flex items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[12.5px] text-faint transition hover:bg-fill-1 hover:text-dim"
        onClick={() => setOpen(!open())}
        aria-expanded={open()}
      >
        <ChevronRight size={12} classList={{ "rotate-90": open() }} class="transition" />
        {props.streaming ? "Raciocinando" : "Raciocínio"}
      </button>
      <Show when={open()}>
        <p class="mb-1.5 ml-[22px] whitespace-pre-wrap border-l border-line pl-3 text-[12.5px] leading-relaxed text-dim">
          {props.text}
        </p>
      </Show>
    </div>
  );
}

function Blank(props: { project: ProjectUI }) {
  return (
    <div class="flex flex-col gap-1 pb-2 pt-[18vh]">
      <p class="font-heading text-[22px] text-ink">
        {isMasterProject(props.project) ? "O que você precisa?" : `O que vamos fazer em ${props.project.name}?`}
      </p>
      <p class="text-[13px] text-dim">
        {isMasterProject(props.project)
          ? "Daqui saem projetos, agentes e terminais. Escreva o que quer ou use uma sugestão acima."
          : "O agente ganha um nome sozinho depois da primeira mensagem."}
      </p>
    </div>
  );
}
