import { createEffect, createSignal, Show, type JSX } from "solid-js";

interface Props {
  value: string;
  /** When true, mount in edit mode immediately and select the contents. */
  autoEdit?: boolean;
  /** Called after the user accepts (Enter or blur). Empty string clears any override. */
  onCommit: (next: string) => void;
  /** Called when the user explicitly cancels (Escape). */
  onCancel?: () => void;
  /** Render the display text. */
  children: (value: string) => JSX.Element;
  inputClass?: string;
}

/**
 * Tiny inline-edit primitive. Double-click the display to edit, Enter accepts,
 * Escape cancels, blur accepts (matches every Mac native rename UI).
 */
export default function InlineEdit(props: Props) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(props.value);
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (props.autoEdit) {
      setDraft(props.value);
      setEditing(true);
    }
  });

  createEffect(() => {
    if (editing() && inputRef) {
      inputRef.focus();
      inputRef.select();
    }
  });

  function commit() {
    const v = draft().trim();
    setEditing(false);
    if (v !== props.value) props.onCommit(v);
  }

  function cancel() {
    setEditing(false);
    setDraft(props.value);
    props.onCancel?.();
  }

  return (
    <Show
      when={editing()}
      fallback={
        <span
          onDblClick={(e) => {
            e.stopPropagation();
            setDraft(props.value);
            setEditing(true);
          }}
        >
          {props.children(props.value)}
        </span>
      }
    >
      <input
        ref={(el) => (inputRef = el)}
        class={
          props.inputClass ??
          "w-full min-w-0 rounded border border-white/15 bg-black/30 px-1 py-0 text-sm text-white outline-none focus:border-white/35"
        }
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
          // Stop ⌘N/⌘W/⌘1 from leaking to the global handler while typing.
          e.stopPropagation();
        }}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => e.stopPropagation()}
      />
    </Show>
  );
}
