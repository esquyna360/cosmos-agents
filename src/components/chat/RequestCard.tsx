import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";
import { Check } from "lucide-solid";

import { answer, type PendingRequest } from "../../stores/chat";
import { describeTool } from "../../lib/toolDisplay";
import MarkdownView from "../MarkdownView";
import { ToolDetail } from "./ToolRow";

interface Props {
  runnerId: string;
  request: PendingRequest;
  roots: string[];
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export default function RequestCard(props: Props) {
  return (
    <div class="rounded-cx-lg border border-busy bg-busy-soft p-3 shadow-cx">
      <Switch fallback={<Permission {...props} />}>
        <Match when={props.request.toolName === "AskUserQuestion"}>
          <Questions {...props} />
        </Match>
        <Match when={props.request.toolName === "ExitPlanMode"}>
          <Plan {...props} />
        </Match>
      </Switch>
    </div>
  );
}

function Permission(props: Props) {
  const [reason, setReason] = createSignal("");
  const d = createMemo(() => describeTool(props.request.toolName, props.request.input, props.roots));
  const allow = () => answer(props.runnerId, props.request.requestId, { allow: true, input: props.request.input });
  const deny = () =>
    answer(props.runnerId, props.request.requestId, {
      allow: false,
      message: reason().trim() || "O usuário negou esta ação.",
    });
  return (
    <div class="flex flex-col gap-2.5">
      <p class="text-[13px] text-ink">
        Claude quer <span class="lowercase">{d().verb}</span>{" "}
        <span class="break-all font-mono text-[12px]">{d().target}</span>
      </p>
      <ToolDetail
        tool={{
          kind: "tool",
          id: props.request.toolUseId,
          name: props.request.toolName,
          input: props.request.input,
          state: "ok",
          result: "",
          parent: null,
        }}
      />
      <div class="flex flex-wrap items-center gap-2">
        <button
          class="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink transition hover:opacity-90"
          onClick={allow}
        >
          Permitir
        </button>
        <button
          class="rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] text-ink transition hover:bg-fill-2"
          onClick={deny}
        >
          Negar
        </button>
        <input
          class="min-w-[180px] flex-1 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-faint"
          placeholder="Negar e dizer o que fazer em vez disso"
          value={reason()}
          onInput={(e) => setReason(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && reason().trim()) deny();
          }}
        />
      </div>
    </div>
  );
}

function Plan(props: Props) {
  const plan = () => String(props.request.input.plan ?? "");
  return (
    <div class="flex flex-col gap-2.5">
      <p class="text-[13px] font-medium text-ink">Plano proposto</p>
      <div class="max-h-[40vh] overflow-y-auto rounded-md border border-line bg-raised px-3 py-2">
        <MarkdownView source={plan()} />
      </div>
      <div class="flex gap-2">
        <button
          class="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink transition hover:opacity-90"
          onClick={() =>
            answer(props.runnerId, props.request.requestId, { allow: true, input: props.request.input })
          }
        >
          Aprovar e executar
        </button>
        <button
          class="rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] text-ink transition hover:bg-fill-2"
          onClick={() =>
            answer(props.runnerId, props.request.requestId, {
              allow: false,
              message: "O usuário quer continuar planejando. Pergunte o que ajustar.",
            })
          }
        >
          Continuar planejando
        </button>
      </div>
    </div>
  );
}

function Questions(props: Props) {
  const questions = createMemo<Question[]>(() =>
    Array.isArray(props.request.input.questions) ? (props.request.input.questions as Question[]) : [],
  );
  const [picked, setPicked] = createStore<Record<number, string[]>>({});
  const [other, setOther] = createStore<Record<number, string>>({});

  const answerFor = (i: number): string => {
    const typed = (other[i] ?? "").trim();
    return [...(picked[i] ?? []), ...(typed ? [typed] : [])].join(", ");
  };
  const complete = () => questions().every((_, i) => answerFor(i));

  function toggle(i: number, label: string, multi: boolean) {
    const cur = picked[i] ?? [];
    if (multi) setPicked(i, cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]);
    else {
      setPicked(i, [label]);
      setOther(i, "");
      if (questions().length === 1) submit();
    }
  }

  function submit() {
    if (!complete()) return;
    const answers: Record<string, string> = {};
    questions().forEach((q, i) => (answers[q.question] = answerFor(i)));
    answer(props.runnerId, props.request.requestId, {
      allow: true,
      input: { ...props.request.input, answers },
    });
  }

  // Digits pick an option when there is a single single-choice question —
  // the common case, and the one worth not reaching for the mouse.
  const onKey = (e: KeyboardEvent) => {
    const el = document.activeElement;
    const typing = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !!el.value;
    const qs = questions();
    if (typing || qs.length !== 1 || qs[0].multiSelect || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = parseInt(e.key, 10);
    if (!n || n > qs[0].options.length) return;
    e.preventDefault();
    toggle(0, qs[0].options[n - 1].label, false);
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  return (
    <div class="flex flex-col gap-3.5">
      <For each={questions()}>
        {(q, i) => (
          <div class="flex flex-col gap-1.5">
            <p class="text-[13px] font-medium text-ink">{q.question}</p>
            <Show when={q.multiSelect}>
              <p class="text-[11.5px] text-dim">Pode marcar mais de uma.</p>
            </Show>
            <div class="flex flex-col gap-1">
              <For each={q.options}>
                {(opt, n) => {
                  const on = () => (picked[i()] ?? []).includes(opt.label);
                  return (
                    <button
                      class="flex items-start gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition"
                      classList={{
                        "border-accent bg-accent-soft": on(),
                        "border-line bg-raised hover:border-line-strong": !on(),
                      }}
                      onClick={() => toggle(i(), opt.label, !!q.multiSelect)}
                    >
                      <span class="cx-kbd mt-px shrink-0">
                        <Show when={on()} fallback={n() + 1}>
                          <Check size={10} />
                        </Show>
                      </span>
                      <span class="min-w-0">
                        <span class="block text-[12.5px] text-ink">{opt.label}</span>
                        <Show when={opt.description}>
                          <span class="block text-[11.5px] leading-snug text-dim">{opt.description}</span>
                        </Show>
                      </span>
                    </button>
                  );
                }}
              </For>
              <input
                data-question-other
                class="rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-faint"
                placeholder="Outra resposta"
                value={other[i()] ?? ""}
                onInput={(e) => {
                  setOther(i(), e.currentTarget.value);
                  if (!q.multiSelect && e.currentTarget.value) setPicked(i(), []);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            </div>
          </div>
        )}
      </For>
      <div class="flex items-center gap-2">
        <button
          class="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink transition hover:opacity-90 disabled:opacity-40"
          disabled={!complete()}
          onClick={submit}
        >
          Responder
        </button>
        <button
          class="rounded-md px-2.5 py-1.5 text-[12.5px] text-dim transition hover:bg-fill-2 hover:text-ink"
          onClick={() =>
            answer(props.runnerId, props.request.requestId, {
              allow: false,
              message: "O usuário preferiu não responder agora.",
            })
          }
        >
          Pular
        </button>
      </div>
    </div>
  );
}
