import { createMemo } from "solid-js";
import { marked } from "marked";

// `marked` config: GitHub-flavored line breaks, no mangle (we don't want
// emails obfuscated), no headerIds (we don't generate anchor IDs).
//
// XSS note: Bruno is the author of his own memory cards, so this is mostly
// safe. If memory ever ingests untrusted content (pasted from the web, e.g.),
// add `DOMPurify.sanitize(html)` before passing to innerHTML.
marked.setOptions({
  breaks: true,
  gfm: true,
});

interface Props {
  /** Markdown source. */
  source: string;
  /** Optional extra classes appended to the root. */
  class?: string;
}

export default function MarkdownView(props: Props) {
  const html = createMemo(() => marked.parse(props.source ?? "") as string);
  return (
    <div
      class={`cosmos-prose text-[13px] leading-relaxed text-white/85 ${props.class ?? ""}`}
      // eslint-disable-next-line solid/no-innerhtml
      innerHTML={html()}
    />
  );
}
