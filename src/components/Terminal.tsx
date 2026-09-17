import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, X } from "lucide-solid";

import { ptyAttach, ptyDetach, ptyResize, ptySpawn, ptyWrite } from "../lib/ipc";
import { markRunnerLive } from "../stores/projects";
import { readTerminalPalette, themeTick } from "../stores/theme";
import { setTermFontSize, termFontSize } from "../stores/layout";
import type { RunnerUI } from "../stores/projects";

interface Props {
  runner: RunnerUI;
  projectId: string;
  cwd: string;
}

/** macOS text-editing chords, translated to what readline/zle and Ink-based
 *  CLIs understand. Without these a terminal in a webview feels "stuck":
 *  ⌘← does nothing and ⌘⌫ deletes one character. */
const MAC_CHORDS: Record<string, string> = {
  ArrowLeft: "\x01",
  ArrowRight: "\x05",
  Backspace: "\x15",
  Delete: "\x0b",
};

export default function Terminal(props: Props) {
  let host!: HTMLDivElement;
  let findInput: HTMLInputElement | undefined;
  const id = props.runner.id;
  const cwd = props.cwd;
  const projectId = props.projectId;
  // Snapshot the spawn config at mount time — a rename must not touch the PTY.
  const program = props.runner.program;
  const args = [...props.runner.args];
  const kind = props.runner.kind;

  const [finding, setFinding] = createSignal(false);
  const [query, setQuery] = createSignal("");
  let term: XTerm | undefined;
  let search: SearchAddon | undefined;

  function find(dir: "next" | "prev") {
    if (!search || !query()) return;
    if (dir === "next") search.findNext(query());
    else search.findPrevious(query());
  }

  function closeFind() {
    setFinding(false);
    search?.clearDecorations();
    term?.focus();
  }

  onMount(async () => {
    const t = new XTerm({
      fontFamily: '"JetBrains Mono Variable", "Fira Code", ui-monospace, monospace',
      fontSize: termFontSize(),
      lineHeight: 1.25,
      theme: readTerminalPalette(),
      cursorBlink: true,
      cursorStyle: "bar",
      allowProposedApi: true,
      scrollback: 50_000,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      scrollSensitivity: 1.4,
      fastScrollSensitivity: 8,
      smoothScrollDuration: 0,
    });
    term = t;

    const fit = new FitAddon();
    search = new SearchAddon();
    t.loadAddon(fit);
    t.loadAddon(search);
    t.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.metaKey) invoke("open_external", { url: uri }).catch(console.error);
      }),
    );

    t.open(host);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      t.loadAddon(webgl);
    } catch (e) {
      console.warn("WebGL renderer unavailable:", e);
    }

    fit.fit();

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // xterm sends \r for both Enter and Shift+Enter; Ink-based CLIs read
      // \n as "newline, don't submit".
      if (e.key === "Enter" && e.shiftKey) {
        ptyWrite(id, "\n").catch(console.error);
        return false;
      }
      if (e.metaKey && !e.altKey && !e.ctrlKey) {
        const chord = MAC_CHORDS[e.key];
        if (chord) {
          ptyWrite(id, chord).catch(console.error);
          return false;
        }
        const key = e.key.toLowerCase();
        if (key === "f") {
          setFinding(true);
          queueMicrotask(() => findInput?.select());
          return false;
        }
        if (key === "k" && !e.shiftKey) {
          // Only a plain shell owns its screen; an agent's TUI redraws itself.
          if (kind === "shell") {
            t.clear();
            return false;
          }
          return true;
        }
        if (key === "=" || key === "+") {
          setTermFontSize(termFontSize() + 1);
          return false;
        }
        if (key === "-") {
          setTermFontSize(termFontSize() - 1);
          return false;
        }
        if (key === "0") {
          setTermFontSize(13);
          return false;
        }
        if (key === "c" && t.hasSelection()) {
          navigator.clipboard.writeText(t.getSelection()).catch(() => {});
          return false;
        }
        // Everything else with ⌘ belongs to the app, not the shell.
        return false;
      }
      return true;
    });

    const decoder = new TextDecoder("utf-8");
    const onChunk = (chunk: Uint8Array) => t.write(decoder.decode(chunk, { stream: true }));

    // Wire up onData BEFORE attaching. Attach replays the PTY's buffered
    // output, which for a fresh agent includes Claude's startup cursor query
    // (DSR `ESC[6n`). xterm answers it through this handler — if it isn't
    // registered yet the answer is dropped and Claude blocks forever, drawing
    // nothing but a cursor. Bites hardest on Windows ConPTY.
    const dataDisp = t.onData((data) => {
      ptyWrite(id, data).catch(console.error);
    });
    const resizeDisp = t.onResize(({ cols, rows }) => {
      ptyResize(id, cols, rows).catch(console.error);
    });

    try {
      await ptyAttach(id, onChunk);
      await ptyResize(id, t.cols, t.rows).catch(() => {});
    } catch {
      // No live PTY (restored after a restart, or stopped). Spawn in place
      // from the persisted program/args; the backend folds `--resume` in when
      // a transcript exists, so an agent picks up where it left off.
      try {
        await ptySpawn({ id, cwd, program, args, cols: t.cols, rows: t.rows, projectId, kind });
        await ptyAttach(id, onChunk);
        markRunnerLive(id, true);
      } catch (e) {
        console.error("revive failed", e);
        t.write(`\r\n\x1b[31mNão consegui iniciar: ${String(e)}\x1b[0m\r\n`);
      }
    }

    createEffect(
      on(
        themeTick,
        () => {
          t.options.theme = readTerminalPalette();
        },
        { defer: true },
      ),
    );
    createEffect(
      on(
        termFontSize,
        (size) => {
          t.options.fontSize = size;
          fit.fit();
        },
        { defer: true },
      ),
    );

    // Fitting on every resize frame makes the PTY reflow dozens of times
    // during a drag; one fit per frame is enough.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fit.fit());
    });
    ro.observe(host);

    t.focus();

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dataDisp.dispose();
      resizeDisp.dispose();
      t.dispose();
      ptyDetach(id).catch(() => {});
    });
  });

  return (
    <div class="relative flex min-h-0 min-w-0 flex-1 bg-[var(--term-bg)]">
      <div ref={host} class="min-h-0 min-w-0 flex-1 py-2 pl-3.5 pr-1" />
      <Show when={finding()}>
        <div class="cx-glass cx-sheet absolute right-4 top-2 z-10 flex items-center gap-1 rounded-cx border border-line-strong p-1">
          <input
            ref={findInput}
            class="w-52 bg-transparent px-2 py-1 text-[12.5px] text-ink outline-none placeholder:text-faint"
            placeholder="Buscar no terminal"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              find("next");
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") find(e.shiftKey ? "prev" : "next");
              if (e.key === "Escape") closeFind();
            }}
          />
          <button class="cx-icon-btn" onClick={() => find("prev")} title="Anterior (⇧↵)">
            <ArrowUp size={13} />
          </button>
          <button class="cx-icon-btn" onClick={() => find("next")} title="Próximo (↵)">
            <ArrowDown size={13} />
          </button>
          <button class="cx-icon-btn" onClick={closeFind} title="Fechar (esc)">
            <X size={13} />
          </button>
        </div>
      </Show>
    </div>
  );
}
