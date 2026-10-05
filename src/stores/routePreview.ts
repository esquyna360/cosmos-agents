import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

import { routeSuggest, type Suggestion } from "../lib/hub";

const MIN_CHARS = 6;
const DEBOUNCE_MS = 220;

/** The router's answer for a task while it is still being typed. */
export function useRoutePreview(task: Accessor<string>): Accessor<Suggestion | null> {
  const [preview, setPreview] = createSignal<Suggestion | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  createEffect(() => {
    const text = task().trim();
    clearTimeout(timer);
    if (text.length < MIN_CHARS) {
      seq++;
      setPreview(null);
      return;
    }
    const mine = ++seq;
    timer = setTimeout(() => {
      routeSuggest(text)
        .then((s) => mine === seq && s && setPreview(s))
        .catch(() => mine === seq && setPreview(null));
    }, DEBOUNCE_MS);
  });
  onCleanup(() => clearTimeout(timer));

  return preview;
}
