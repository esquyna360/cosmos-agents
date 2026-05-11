import { createSignal } from "solid-js";

import { ptyWrite } from "../lib/ipc";
import { fsSaveTempImage } from "../lib/fs";

interface Props {
  id: string;
  agentName: string;
}

const MAX_ROWS = 12;
const MIN_ROWS = 3;
const LINE_HEIGHT_PX = 20;
const PADDING_Y_PX = 16;

export default function InputBar(props: Props) {
  const [value, setValue] = createSignal("");
  const [sending, setSending] = createSignal(false);
  let ref!: HTMLTextAreaElement;

  function autosize() {
    ref.style.height = "auto";
    const min = MIN_ROWS * LINE_HEIGHT_PX + PADDING_Y_PX;
    const max = MAX_ROWS * LINE_HEIGHT_PX + PADDING_Y_PX;
    ref.style.height = Math.max(min, Math.min(ref.scrollHeight, max)) + "px";
    ref.style.overflowY = ref.scrollHeight > max ? "auto" : "hidden";
  }

  async function submit() {
    const v = value();
    if (!v || sending()) return;
    setSending(true);
    try {
      await ptyWrite(props.id, v + "\r");
      setValue("");
      queueMicrotask(autosize);
    } catch (e) {
      console.error("[inputbar] submit failed", e);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  function insertAtCursor(text: string) {
    const start = ref.selectionStart ?? value().length;
    const end = ref.selectionEnd ?? value().length;
    const current = value();
    const next = current.slice(0, start) + text + current.slice(end);
    setValue(next);
    queueMicrotask(() => {
      ref.focus();
      ref.selectionStart = ref.selectionEnd = start + text.length;
      autosize();
    });
  }

  /**
   * Browser textareas drop image clipboard items by default. Intercept the
   * paste, write the bytes to a temp file in Rust, and insert the resulting
   * path with the `@` prefix that Claude resolves as a file reference.
   */
  async function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ext = item.type.split("/")[1] || "png";
      try {
        const path = await fsSaveTempImage(bytes, ext);
        insertAtCursor(`@${path} `);
      } catch (err) {
        console.error("[inputbar] image paste failed", err);
      }
    }
  }

  return (
    <div class="shrink-0 border-t-2 border-white/10 bg-[#13161c] px-3 py-2.5">
      <div class="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/40">
        <span>compose for {props.agentName}</span>
        <span class="text-white/30">↵ newline · ⌘↵ send</span>
      </div>
      <div class="flex items-end gap-2 rounded-md border border-white/10 bg-[#0b0d10] px-3 py-2 focus-within:border-white/25">
        <textarea
          ref={ref}
          rows={MIN_ROWS}
          value={value()}
          placeholder="paste or type a prompt, then ⌘↵…"
          class="min-h-[60px] w-full resize-none bg-transparent text-[13px] leading-5 text-white/90 outline-none placeholder:text-white/30"
          style={{ "font-family": '"Fira Code", ui-monospace, monospace' }}
          onInput={(e) => {
            setValue(e.currentTarget.value);
            autosize();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button
          onClick={submit}
          disabled={!value() || sending()}
          class="shrink-0 self-end rounded-md bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white/90 hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-30"
          title="Send (⌘↵)"
        >
          send ⌘↵
        </button>
      </div>
    </div>
  );
}
