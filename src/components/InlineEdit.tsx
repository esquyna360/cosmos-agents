import { createEffect, createSignal, Show, type JSX } from "solid-js";

const [requested, setRequested] = createSignal<string | null>(null);

/** Puts the InlineEdit mounted with this `editKey` into edit mode — how a
 *  menu item or a shortcut starts a rename without a double-click. */
export function startInlineEdit(key: string): void {
  setRequested(key);
}

interface Props {
  value: string;
  editKey?: string;
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
    if (props.editKey && requested() === props.editKey) {
      setRequested(null);
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
          "w-full min-w-0 rounded border border-accent bg-raised px-1 py-0 text-[length:inherit] font-[inherit] text-ink outline-none"
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
