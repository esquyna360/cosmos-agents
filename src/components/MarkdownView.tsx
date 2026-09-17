import { createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { marked } from "marked";

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
  // Agent output quotes web pages and file contents, so it is sanitized
  // before it reaches innerHTML.
  const html = createMemo(() =>
    DOMPurify.sanitize(marked.parse(props.source ?? "") as string),
  );
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:\/\//.test(href)) invoke("open_external", { url: href }).catch(console.error);
  };
  return (
    <div
      class={`cosmos-prose text-[13px] leading-relaxed text-ink ${props.class ?? ""}`}
      onClick={onClick}
      // eslint-disable-next-line solid/no-innerhtml
      innerHTML={html()}
    />
  );
}
