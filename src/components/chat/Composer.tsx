import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { ArrowUp, ChevronDown, ImagePlus, Square, X } from "lucide-solid";

import {
  chatOf,
  send,
  setModel,
  setPermissionMode,
  stop,
  type PermissionMode,
} from "../../stores/chat";
import type { OutgoingImage } from "../../lib/claudeProtocol";
import { fsWalk } from "../../lib/fs";
import { shortPath } from "../../lib/toolDisplay";
import { openMenu } from "../../ui/Menu";

interface Props {
  runnerId: string;
  roots: string[];
  /** A request card is up; typing still works, but Enter should not race it. */
  blocked: boolean;
}

const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "bypassPermissions", label: "Sem perguntar", hint: "Executa tudo direto" },
  { id: "acceptEdits", label: "Aceitar edições", hint: "Pergunta antes de rodar comandos" },
  { id: "default", label: "Perguntar", hint: "Pergunta antes de editar ou rodar" },
  { id: "plan", label: "Planejar", hint: "Só lê e propõe um plano" },
];

const FALLBACK_MODELS = [
  { value: "", displayName: "Padrão", description: "O modelo configurado no Claude Code" },
  { value: "opus", displayName: "Opus", description: "" },
  { value: "sonnet", displayName: "Sonnet", description: "" },
  { value: "haiku", displayName: "Haiku", description: "" },
];

const drafts = new Map<string, string>();
const fileLists = new Map<string, Promise<string[]>>();

function filesOf(roots: string[]): Promise<string[]> {
  const key = roots.join("|");
  let cached = fileLists.get(key);
  if (!cached) {
    cached = Promise.all(roots.map((r) => fsWalk(r).catch(() => [] as string[]))).then((l) => l.flat());
    fileLists.set(key, cached);
    // Files come and go while agents work; a minute is stale enough.
    setTimeout(() => fileLists.delete(key), 60_000);
  }
  return cached;
}

interface Suggestion {
  label: string;
  detail: string;
  insert: string;
}

export default function Composer(props: Props) {
  let area: HTMLTextAreaElement | undefined;
  const chat = () => chatOf(props.runnerId);
  const [text, setText] = createSignal(drafts.get(props.runnerId) ?? "");
  const [images, setImages] = createSignal<OutgoingImage[]>([]);
  const [files, setFiles] = createSignal<string[]>([]);
  const [caret, setCaret] = createSignal(0);
  const [index, setIndex] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);
  const [elapsed, setElapsed] = createSignal(0);

  createEffect(
    on(
      () => props.runnerId,
      (id) => {
        setText(drafts.get(id) ?? "");
        setImages([]);
        queueMicrotask(() => {
          resize();
          area?.focus();
        });
      },
    ),
  );

  createEffect(() => {
    if (!chat().busy) return setElapsed(0);
    const tick = () => setElapsed(Math.floor((Date.now() - chat().busySince) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    onCleanup(() => clearInterval(t));
  });

  function resize() {
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, Math.round(window.innerHeight * 0.35))}px`;
  }

  /** The `@partial` or leading `/partial` the caret is sitting in. */
  const token = createMemo<{ kind: "file" | "command"; query: string; start: number } | null>(() => {
    const before = text().slice(0, caret());
    const cmd = /^\/([\w:-]*)$/.exec(before);
    if (cmd) return { kind: "command", query: cmd[1].toLowerCase(), start: 0 };
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at) return { kind: "file", query: at[2].toLowerCase(), start: before.length - at[2].length - 1 };
    return null;
  });

  createEffect(() => {
    if (token()?.kind === "file" && files().length === 0) filesOf(props.roots).then(setFiles);
  });
  createEffect(on(token, () => (setIndex(0), setDismissed(false))));

  const suggestions = createMemo<Suggestion[]>(() => {
    const t = token();
    if (!t || dismissed()) return [];
    if (t.kind === "command") {
      return chat()
        .commands.filter((c) => c.name.toLowerCase().includes(t.query))
        .sort((a, b) => Number(b.name.startsWith(t.query)) - Number(a.name.startsWith(t.query)))
        .slice(0, 8)
        .map((c) => ({
          label: `/${c.name}`,
          detail: [c.argumentHint, c.description].filter(Boolean).join("  "),
          insert: `/${c.name} `,
        }));
    }
    const scored: { path: string; score: number }[] = [];
    for (const path of files()) {
      const rel = shortPath(path, props.roots).toLowerCase();
      const at = rel.lastIndexOf(t.query);
      if (at < 0) continue;
      const inName = at > rel.lastIndexOf("/");
      scored.push({ path, score: (inName ? 0 : 1000) + rel.length });
      if (scored.length > 4000) break;
    }
    return scored
      .sort((a, b) => a.score - b.score)
      .slice(0, 8)
      .map(({ path }) => {
        const rel = shortPath(path, props.roots);
        const slash = rel.lastIndexOf("/");
        return {
          label: rel.slice(slash + 1),
          detail: slash > 0 ? rel.slice(0, slash) : "",
          insert: `@${path} `,
        };
      });
  });

  function accept(s: Suggestion) {
    const t = token();
    if (!t) return;
    const next = text().slice(0, t.start) + s.insert + text().slice(caret());
    const pos = t.start + s.insert.length;
    update(next);
    queueMicrotask(() => {
      area?.setSelectionRange(pos, pos);
      setCaret(pos);
      area?.focus();
    });
  }

  function update(v: string) {
    setText(v);
    drafts.set(props.runnerId, v);
    queueMicrotask(resize);
  }

  function submit() {
    if (!text().trim() && images().length === 0) return;
    send(props.runnerId, text(), images());
    update("");
    setImages([]);
  }

  function onKeyDown(e: KeyboardEvent) {
    const list = suggestions();
    if (list.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setIndex((index() + step + list.length) % list.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(list[index()]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!props.blocked) submit();
      return;
    }
    if (e.key === "Escape" && chat().busy) {
      e.preventDefault();
      stop(props.runnerId);
    }
  }

  async function addImage(file: File) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    setImages([...images(), { mediaType: file.type || "image/png", base64: btoa(bin) }]);
  }

  function onPaste(e: ClipboardEvent) {
    const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    e.preventDefault();
    imgs.forEach((f) => void addImage(f));
  }

  const modeLabel = () => MODES.find((m) => m.id === chat().permissionMode)?.label ?? "Perguntar";
  const modelOptions = () => (chat().models.length ? chat().models : FALLBACK_MODELS);
  const modelLabel = () => {
    const choice = chat().modelChoice || "default";
    const picked = modelOptions().find((m) => (m.value || "default") === choice);
    if (picked && choice !== "default") return picked.displayName;
    return chat().model ? prettyModel(chat().model) : "Modelo padrão";
  };

  let picker: HTMLInputElement | undefined;

  return (
    <div class="relative">
      <Show when={suggestions().length > 0}>
        <div class="absolute bottom-full left-0 right-0 z-20 mb-1.5 overflow-hidden rounded-cx-lg border border-line-strong bg-float py-1 shadow-cx-lg">
          <For each={suggestions()}>
            {(s, i) => (
              <button
                class="flex w-full min-w-0 items-baseline gap-2.5 px-3 py-1.5 text-left"
                classList={{ "bg-fill-2": i() === index() }}
                onMouseEnter={() => setIndex(i())}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(s);
                }}
              >
                <span class="shrink-0 font-mono text-[12px] text-ink">{s.label}</span>
                <span class="min-w-0 truncate text-[11.5px] text-faint">{s.detail}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="rounded-cx-lg border border-line-strong bg-raised shadow-cx transition focus-within:border-accent">
        <Show when={images().length > 0}>
          <div class="flex flex-wrap gap-2 px-3 pt-3">
            <For each={images()}>
              {(img, i) => (
                <div class="group relative">
                  <img
                    src={`data:${img.mediaType};base64,${img.base64}`}
                    alt="Imagem anexada"
                    class="h-14 w-14 rounded-md border border-line object-cover"
                  />
                  <button
                    class="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-float text-dim opacity-0 shadow-cx transition group-hover:opacity-100"
                    onClick={() => setImages(images().filter((_, n) => n !== i()))}
                    aria-label="Remover imagem"
                  >
                    <X size={10} />
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

        <textarea
          ref={area}
          rows={1}
          class="block max-h-[35vh] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-faint"
          placeholder={chat().busy ? "Envie outra mensagem; ela entra na fila" : "Peça algo. @ cita um arquivo, / abre os comandos"}
          value={text()}
          onInput={(e) => {
            update(e.currentTarget.value);
            setCaret(e.currentTarget.selectionStart);
          }}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />

        <div class="flex items-center gap-1 px-2 pb-2 pt-1">
          <button
            class="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-dim transition hover:bg-fill-2 hover:text-ink"
            onClick={(e) =>
              openMenu(
                e.currentTarget,
                modelOptions().map((m) => ({
                  label: m.displayName,
                  hint: (m.value || "default") === (chat().modelChoice || "default") ? "✓" : undefined,
                  onSelect: () => setModel(props.runnerId, m.value === "default" ? "" : m.value),
                })),
              )
            }
          >
            {modelLabel()}
            <ChevronDown size={11} class="text-faint" />
          </button>
          <button
            class="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] transition hover:bg-fill-2"
            classList={{
              "text-dim hover:text-ink": chat().permissionMode !== "plan",
              "text-accent": chat().permissionMode === "plan",
            }}
            onClick={(e) =>
              openMenu(
                e.currentTarget,
                MODES.map((m) => ({
                  label: m.label,
                  hint: m.id === chat().permissionMode ? "✓" : undefined,
                  onSelect: () => setPermissionMode(props.runnerId, m.id),
                })),
              )
            }
            title={MODES.find((m) => m.id === chat().permissionMode)?.hint}
          >
            {modeLabel()}
            <ChevronDown size={11} class="text-faint" />
          </button>
          <button
            class="cx-icon-btn"
            onClick={() => picker?.click()}
            title="Anexar imagem (ou cole com ⌘V)"
            aria-label="Anexar imagem"
          >
            <ImagePlus size={14} />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              Array.from(e.currentTarget.files ?? []).forEach((f) => void addImage(f));
              e.currentTarget.value = "";
            }}
          />

          <span class="ml-auto flex items-center gap-2">
            <Show when={chat().busy}>
              <span class="text-[11.5px] tabular-nums text-faint">{formatElapsed(elapsed())}</span>
              <button
                class="flex h-7 items-center gap-1.5 rounded-md border border-line-strong px-2 text-[12px] text-ink transition hover:bg-fill-2"
                onClick={() => stop(props.runnerId)}
                title="Parar (Esc)"
              >
                <Square size={9} fill="currentColor" />
                Parar
              </button>
            </Show>
            <button
              class="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-ink transition hover:opacity-90 disabled:bg-fill-2 disabled:text-faint"
              disabled={(!text().trim() && images().length === 0) || props.blocked}
              onClick={submit}
              title={chat().busy ? "Entrar na fila (Enter)" : "Enviar (Enter)"}
              aria-label="Enviar"
            >
              <ArrowUp size={15} />
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function formatElapsed(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "claude-opus-5[1m]" → "Opus 5" */
export function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-([\d-]+?)(?:-\d{8})?(\[.*\])?$/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace(/-/g, ".")}`;
}
