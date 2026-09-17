import { createMemo, createSignal, For, Show } from "solid-js";
import { ChevronRight } from "lucide-solid";

import type { ChatItem } from "../../stores/chat";
import { describeTool } from "../../lib/toolDisplay";
import { openFileInEditor } from "../../stores/projects";

type Tool = Extract<ChatItem, { kind: "tool" }>;

interface Props {
  tool: Tool;
  roots: string[];
  /** Steps a delegated agent took under this call. */
  steps: Tool[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

interface Hunk {
  before: string;
  after: string;
}

function hunksOf(tool: Tool): Hunk[] {
  const i = tool.input;
  if (tool.name === "Write") return [{ before: "", after: str(i.content) }];
  if (tool.name === "Edit") return [{ before: str(i.old_string), after: str(i.new_string) }];
  if (tool.name === "MultiEdit" && Array.isArray(i.edits))
    return (i.edits as Record<string, unknown>[]).map((e) => ({
      before: str(e.old_string),
      after: str(e.new_string),
    }));
  return [];
}

function clip(text: string, max = 6000): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} caracteres a mais)` : text;
}

export function DiffBlock(props: { hunks: Hunk[] }) {
  return (
    <div class="overflow-hidden rounded-md border border-line font-mono text-[11.5px] leading-[1.55]">
      <For each={props.hunks}>
        {(h, idx) => (
          <div classList={{ "border-t border-line": idx() > 0 }}>
            <Show when={h.before}>
              <pre class="overflow-x-auto whitespace-pre bg-alert-soft px-2.5 py-1.5 text-ink">
                {clip(h.before)
                  .split("\n")
                  .map((l) => `− ${l}`)
                  .join("\n")}
              </pre>
            </Show>
            <Show when={h.after}>
              <pre class="overflow-x-auto whitespace-pre bg-add-soft px-2.5 py-1.5 text-ink">
                {clip(h.after)
                  .split("\n")
                  .map((l) => `+ ${l}`)
                  .join("\n")}
              </pre>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

export function ToolDetail(props: { tool: Tool }) {
  const hunks = createMemo(() => hunksOf(props.tool));
  const command = () => (props.tool.name === "Bash" ? str(props.tool.input.command) : "");
  const rawInput = createMemo(() => {
    if (hunks().length > 0 || command()) return "";
    const keys = Object.keys(props.tool.input);
    return keys.length ? JSON.stringify(props.tool.input, null, 2) : "";
  });
  return (
    <div class="flex flex-col gap-1.5">
      <Show when={hunks().length > 0}>
        <DiffBlock hunks={hunks()} />
      </Show>
      <Show when={command()}>
        <pre class="overflow-x-auto whitespace-pre-wrap rounded-md border border-line bg-sunken px-2.5 py-1.5 font-mono text-[11.5px] text-ink">
          <span class="select-none text-faint">$ </span>
          {command()}
        </pre>
      </Show>
      <Show when={rawInput()}>
        <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-sunken px-2.5 py-1.5 font-mono text-[11.5px] text-dim">
          {clip(rawInput(), 3000)}
        </pre>
      </Show>
      <Show when={props.tool.result.trim()}>
        <pre
          class="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-sunken px-2.5 py-1.5 font-mono text-[11.5px]"
          classList={{
            "text-dim": props.tool.state !== "error",
            "text-alert": props.tool.state === "error",
          }}
        >
          {clip(props.tool.result)}
        </pre>
      </Show>
    </div>
  );
}

export default function ToolRow(props: Props) {
  const [open, setOpen] = createSignal(false);
  const d = createMemo(() => describeTool(props.tool.name, props.tool.input, props.roots));
  const Icon = () => {
    const I = d().icon;
    return <I size={13} />;
  };
  return (
    <div class="min-w-0">
      <button
        class="group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-[3px] text-left text-[12.5px] transition hover:bg-fill-1"
        onClick={() => setOpen(!open())}
        aria-expanded={open()}
      >
        <span
          class="shrink-0"
          classList={{
            "text-faint": props.tool.state === "ok",
            "text-accent": props.tool.state === "running",
            "text-alert": props.tool.state === "error",
          }}
        >
          <Icon />
        </span>
        <span class="shrink-0 text-dim">{d().verb}</span>
        <span
          class="min-w-0 truncate font-mono text-[12px] text-ink"
          classList={{ "hover:underline": !!d().path }}
          onClick={(e) => {
            const path = d().path;
            if (!path || !e.metaKey) return;
            e.stopPropagation();
            openFileInEditor(path);
          }}
          title={d().path ? "⌘+clique abre no editor" : undefined}
        >
          {d().target}
        </span>
        <Show when={props.steps.length > 0}>
          <span class="shrink-0 text-[11.5px] text-faint">
            {props.steps.length} {props.steps.length === 1 ? "passo" : "passos"}
          </span>
        </Show>
        <Show when={props.tool.state === "running"}>
          <span class="cx-spin ml-auto h-3 w-3 shrink-0 rounded-full border-[1.5px] border-accent border-t-transparent" />
        </Show>
        <Show when={props.tool.state === "error"}>
          <span class="ml-auto shrink-0 text-[11.5px] text-alert">falhou</span>
        </Show>
        <ChevronRight
          size={12}
          class="shrink-0 text-faint opacity-0 transition group-hover:opacity-100"
          classList={{
            "rotate-90 opacity-100": open(),
            "ml-auto": props.tool.state === "ok",
          }}
        />
      </button>
      <Show when={open()}>
        <div class="mb-1.5 ml-[26px] mt-1 flex flex-col gap-1.5">
          <Show when={props.steps.length > 0}>
            <div class="border-l border-line pl-1.5">
              <For each={props.steps}>
                {(child) => <ToolRow tool={child} roots={props.roots} steps={[]} />}
              </For>
            </div>
          </Show>
          <ToolDetail tool={props.tool} />
        </div>
      </Show>
    </div>
  );
}
