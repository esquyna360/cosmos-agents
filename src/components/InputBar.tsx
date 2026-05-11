import { createSignal } from "solid-js";

import { ptyWrite } from "../lib/ipc";
import { fsSaveTempImage } from "../lib/fs";
import { composerExpanded, setComposerExpanded } from "../stores/layout";

interface Props {
  id: string;
  agentName: string;
}

const MIN_ROWS = 3;
const LINE_HEIGHT_PX = 20;
const PADDING_Y_PX = 16;

export default function InputBar(props: Props) {
  const [value, setValue] = createSignal("");
  const [sending, setSending] = createSignal(false);
  // Expanded state lives in the global layout store so App.tsx can hide the
  // terminal completely while the composer is in use.
  const expanded = composerExpanded;
  let ref!: HTMLTextAreaElement;

  function autosize() {
    if (expanded()) {
      // Flex-1 child of an expanded wrapper — height comes from CSS, not js.
      ref.style.height = "100%";
      ref.style.overflowY = "auto";
      return;
    }
    ref.style.height = "auto";
    const min = MIN_ROWS * LINE_HEIGHT_PX + PADDING_Y_PX;
    ref.style.height = Math.max(min, ref.scrollHeight) + "px";
    ref.style.overflowY = "hidden";
  }

  async function submit() {
    const v = value();
    if (!v || sending()) return;
    setSending(true);
    try {
      await ptyWrite(props.id, v + "\r");
      setValue("");
      queueMicrotask(autosize);
      // After submitting, give focus back to the terminal so the user sees
      // claude responding without the giant composer in the way.
      ref.blur();
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
      return;
    }
    if (e.key === "Escape") {
      // Esc collapses back to the small composer without sending.
      e.preventDefault();
      ref.blur();
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
    <div
      class="flex flex-col border-t-2 border-white/10 bg-[#13161c] px-3 py-2.5"
      classList={{
        // Without expand: stay at content size (shrink-0).
        // Expanded: claim every pixel of the parent column.
        "shrink-0": !expanded(),
        "flex-1 min-h-0": expanded(),
      }}
      onMouseDown={(e) => {
        // Click anywhere in the composer wrapper → focus textarea. Avoids
        // dead-zone clicks (e.g. on the label or padding) that wouldn't
        // otherwise trigger the textarea's focus event.
        if (e.target instanceof HTMLElement && e.target !== ref && e.target.tagName !== "BUTTON") {
          e.preventDefault();
          ref.focus();
        }
      }}
    >
      <div class="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/40">
        <span>compose for {props.agentName}</span>
        <span class="text-white/30">↵ newline · ⌘↵ send · esc shrink</span>
      </div>
      <div
        class="flex min-h-0 items-end gap-2 rounded-md border border-white/10 bg-[#0b0d10] px-3 py-2 focus-within:border-white/25"
        classList={{
          "flex-1": expanded(),
        }}
      >
        <textarea
          ref={ref}
          rows={MIN_ROWS}
          value={value()}
          placeholder="paste or type a prompt, then ⌘↵…"
          class="w-full resize-none bg-transparent text-[13px] leading-5 text-white/90 outline-none placeholder:text-white/30"
          classList={{
            "min-h-[60px]": !expanded(),
            "h-full self-stretch": expanded(),
          }}
          style={{ "font-family": '"Fira Code", ui-monospace, monospace' }}
          onInput={(e) => {
            setValue(e.currentTarget.value);
            autosize();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => {
            setComposerExpanded(true);
            queueMicrotask(autosize);
          }}
          onBlur={() => {
            setComposerExpanded(false);
            queueMicrotask(autosize);
          }}
        />
        <button
          onClick={submit}
          disabled={!value() || sending()}
          class="shrink-0 self-end rounded-md bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white/90 hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-30"
          title="Send (⌘↵)"
          // Prevent the button from stealing focus before the click resolves,
          // which would otherwise collapse the composer mid-submit.
          onMouseDown={(e) => e.preventDefault()}
        >
          send ⌘↵
        </button>
      </div>
    </div>
  );
}
