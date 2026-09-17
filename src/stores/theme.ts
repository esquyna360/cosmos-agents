import { createSignal } from "solid-js";

/**
 * Theme selection.
 *
 * A theme is nothing but a `data-theme` value on <html>; every colour in the
 * app resolves through the CSS variables that attribute selects (styles.css).
 * That keeps switching instant and total — including surfaces we don't own,
 * like xterm.js and CodeMirror, which read the same variables back out
 * through `readTerminalPalette()`.
 */

export type ThemeId =
  | "night"
  | "day"
  | "midnight"
  | "graphite"
  | "obsidian"
  | "ember"
  | "dawn"
  | "paper";

export interface ThemeSpec {
  id: ThemeId;
  label: string;
  hint: string;
  mode: "dark" | "light";
  /** Two swatches for the picker: page ground and accent. */
  swatch: [string, string];
}

export const THEMES: ThemeSpec[] = [
  {
    id: "night",
    label: "Noite",
    hint: "escuro neutro, o padrão",
    mode: "dark",
    swatch: ["#111214", "#909cff"],
  },
  {
    id: "day",
    label: "Dia",
    hint: "claro neutro",
    mode: "light",
    swatch: ["#f3f3f1", "#4450d4"],
  },
  {
    id: "midnight",
    label: "Midnight",
    hint: "azul profundo, o padrão",
    mode: "dark",
    swatch: ["#0a0b10", "#7aa2ff"],
  },
  {
    id: "graphite",
    label: "Graphite",
    hint: "cinza neutro, acento teal",
    mode: "dark",
    swatch: ["#101112", "#5eead4"],
  },
  {
    id: "obsidian",
    label: "Obsidian",
    hint: "preto puro, bom em OLED",
    mode: "dark",
    swatch: ["#000000", "#c4a2ff"],
  },
  {
    id: "ember",
    label: "Ember",
    hint: "escuro quente, acento âmbar",
    mode: "dark",
    swatch: ["#14100e", "#f0a868"],
  },
  {
    id: "dawn",
    label: "Dawn",
    hint: "claro quente, alto contraste",
    mode: "light",
    swatch: ["#fbeadd", "#c2410c"],
  },
  {
    id: "paper",
    label: "Paper",
    hint: "claro neutro, acento azul",
    mode: "light",
    swatch: ["#eef1f5", "#2563eb"],
  },
];

export type ThemePref = ThemeId | "system";

const KEY = "cosmos.theme.v2";

function read(): ThemePref {
  const v = localStorage.getItem(KEY);
  if (v === "system") return "system";
  return THEMES.some((t) => t.id === v) ? (v as ThemeId) : "system";
}

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function resolve(pref: ThemePref): ThemeId {
  if (pref !== "system") return pref;
  return systemDark.matches ? "night" : "day";
}

const [themePref, setThemePrefRaw] = createSignal<ThemePref>(read());
const [theme, setThemeRaw] = createSignal<ThemeId>(resolve(read()));
/** Bumped on every theme change so consumers outside the CSS cascade
 *  (xterm, CodeMirror) can re-read the palette. */
const [themeTick, setThemeTick] = createSignal(0);

export { theme, themePref, themeTick };

export function themeSpec(id: ThemeId = theme()): ThemeSpec {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

function paint(id: ThemeId): void {
  document.documentElement.setAttribute("data-theme", id);
  setThemeRaw(id);
  setThemeTick((n) => n + 1);
}

export function applyTheme(pref: ThemePref): void {
  setThemePrefRaw(pref);
  paint(resolve(pref));
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* private mode — the theme just won't survive a restart */
  }
}

/** ⌘⇧T flips between light and dark, whatever palette is active. */
export function cycleTheme(): void {
  applyTheme(themeSpec().mode === "dark" ? "day" : "night");
}

/** Call once at boot, before first paint, so there is no flash of the default. */
export function initTheme(): void {
  document.documentElement.setAttribute("data-theme", theme());
  systemDark.addEventListener("change", () => {
    if (themePref() === "system") paint(resolve("system"));
  });
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

/** The active theme's palette, shaped for xterm.js's `ITheme`. */
export function readTerminalPalette() {
  const bg = cssVar("--term-bg", "#111214");
  const fg = cssVar("--term-fg", "#e8ecf4");
  const dim = cssVar("--text-faint", "#5f6879");
  const accent = cssVar("--accent", "#7aa2ff");
  const soft = cssVar("--accent-soft", "rgba(122,162,255,0.16)");

  const base = {
    black: cssVar("--term-black", bg),
    red: cssVar("--term-red", "#fb7185"),
    green: cssVar("--term-green", "#34d399"),
    yellow: cssVar("--term-yellow", "#fbbf24"),
    blue: cssVar("--term-blue", "#7aa2ff"),
    magenta: cssVar("--term-magenta", "#c4a2ff"),
    cyan: cssVar("--term-cyan", "#5eead4"),
    white: cssVar("--term-white", "#d3d9e4"),
  };

  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: soft,
    ...base,
    brightBlack: dim,
    brightRed: base.red,
    brightGreen: base.green,
    brightYellow: base.yellow,
    brightBlue: base.blue,
    brightMagenta: base.magenta,
    brightCyan: base.cyan,
    brightWhite: fg,
  };
}
