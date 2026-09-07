import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * CodeMirror dressed in the active Cosmos theme.
 *
 * CodeMirror resolves its colours once, when the extension is built, so this
 * reads the CSS variables at build time and the editor is rebuilt on a theme
 * change (Editor.tsx watches `themeTick`). Everything comes from the same
 * `--term-*` palette the terminal uses, so a file and the shell that produced
 * it are never two different colour schemes side by side.
 */

function v(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return raw || fallback;
}

export function cosmosEditorTheme(): Extension {
  const bg = v("--void", "#0a0b10");
  const fg = v("--text", "#e8ecf4");
  const dim = v("--text-dim", "#98a1b4");
  const faint = v("--text-faint", "#5f6879");
  const accent = v("--accent", "#7aa2ff");
  const soft = v("--accent-soft", "rgba(122,162,255,0.16)");
  const line = v("--line", "rgba(255,255,255,0.08)");
  const fill1 = v("--fill-1", "rgba(255,255,255,0.035)");
  const fill2 = v("--fill-2", "rgba(255,255,255,0.07)");
  const float = v("--float", "#191d29");
  const dark = v("color-scheme", "dark") !== "light";

  const red = v("--term-red", "#fb7185");
  const green = v("--term-green", "#34d399");
  const yellow = v("--term-yellow", "#fbbf24");
  const blue = v("--term-blue", "#7aa2ff");
  const magenta = v("--term-magenta", "#c4a2ff");
  const cyan = v("--term-cyan", "#5eead4");

  const highlight = HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment], color: faint, fontStyle: "italic" },
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: magenta },
    { tag: [t.operatorKeyword, t.modifier, t.self, t.null], color: magenta },
    { tag: [t.string, t.special(t.string), t.regexp], color: green },
    { tag: [t.number, t.bool, t.literal], color: yellow },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: blue },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: fg },
    { tag: [t.propertyName, t.attributeName], color: cyan },
    { tag: [t.typeName, t.className, t.namespace], color: cyan },
    { tag: [t.tagName], color: red },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: dim },
    { tag: [t.variableName], color: fg },
    { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: yellow },
    { tag: [t.heading], color: accent, fontWeight: "600" },
    { tag: [t.link, t.url], color: accent, textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "700" },
    { tag: [t.meta, t.processingInstruction], color: dim },
    { tag: [t.invalid], color: v("--alert", "#fb7185") },
    { tag: [t.inserted], color: green },
    { tag: [t.deleted], color: red },
  ]);

  const theme = EditorView.theme(
    {
      "&": {
        height: "100%",
        fontSize: "13px",
        color: fg,
        backgroundColor: "transparent",
      },
      ".cm-scroller": {
        fontFamily: '"Fira Code", ui-monospace, monospace',
        lineHeight: "1.55",
      },
      ".cm-content": { padding: "10px 0", caretColor: accent },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: accent, borderLeftWidth: "2px" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: soft },
      ".cm-selectionMatch": { backgroundColor: fill2 },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: faint,
        border: "none",
        borderRight: `1px solid ${line}`,
      },
      ".cm-activeLineGutter": { backgroundColor: fill1, color: dim },
      ".cm-activeLine": { backgroundColor: fill1 },
      ".cm-foldGutter .cm-gutterElement": { padding: "0 3px", opacity: "0.55" },
      ".cm-foldPlaceholder": {
        backgroundColor: fill2,
        border: "none",
        color: dim,
        padding: "0 6px",
        borderRadius: "4px",
      },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: fill2,
        outline: `1px solid ${accent}`,
        color: "inherit",
      },
      ".cm-nonmatchingBracket": { outline: `1px solid ${red}` },
      ".cm-indentation-marker": { background: line },
      ".cm-indentation-marker.active": { background: v("--line-strong", line) },

      ".cm-panels": {
        backgroundColor: float,
        color: fg,
        borderTop: `1px solid ${line}`,
        borderBottom: `1px solid ${line}`,
      },
      ".cm-panel.cm-search": { padding: "6px 8px", fontFamily: "inherit" },
      ".cm-panel.cm-search label": { fontSize: "11px", color: dim },
      ".cm-textfield": {
        backgroundColor: fill1,
        border: `1px solid ${line}`,
        borderRadius: "6px",
        color: fg,
        padding: "3px 7px",
        fontSize: "12px",
      },
      ".cm-textfield:focus": { outline: "none", borderColor: accent },
      ".cm-button": {
        backgroundColor: fill2,
        backgroundImage: "none",
        border: `1px solid ${line}`,
        borderRadius: "6px",
        color: fg,
        padding: "3px 9px",
        fontSize: "11.5px",
      },
      ".cm-button:hover": { backgroundColor: fill1 },

      ".cm-tooltip": {
        backgroundColor: float,
        border: `1px solid ${line}`,
        borderRadius: "8px",
        boxShadow: v("--shadow-2", "0 18px 48px -18px rgba(0,0,0,0.85)"),
        overflow: "hidden",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": {
        fontFamily: '"Fira Code", ui-monospace, monospace',
        fontSize: "12px",
        maxHeight: "16em",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 8px" },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: soft,
        color: fg,
      },
      ".cm-completionIcon": { color: dim },
      ".cm-completionMatchedText": {
        color: accent,
        textDecoration: "none",
        fontWeight: "600",
      },

      ".cm-searchMatch": { backgroundColor: fill2, outline: `1px solid ${line}` },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: soft,
        outline: `1px solid ${accent}`,
      },
      ".cm-scroller::-webkit-scrollbar": { width: "10px", height: "10px" },
      ".cm-scroller::-webkit-scrollbar-thumb": {
        backgroundColor: fill2,
        borderRadius: "6px",
        border: `2px solid ${bg}`,
      },
    },
    { dark },
  );

  return [theme, syntaxHighlighting(highlight)];
}
