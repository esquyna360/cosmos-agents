import { onCleanup, onMount } from "solid-js";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";

import { ptyAttach, ptyDetach, ptyResize, ptySpawn, ptyWrite } from "../lib/ipc";
import { markRunnerLive } from "../stores/projects";
import type { RunnerUI } from "../stores/projects";

interface Props {
  runner: RunnerUI;
  projectId: string;
  cwd: string;
}

export default function Terminal(props: Props) {
  let host!: HTMLDivElement;
  const id = props.runner.id;
  const cwd = props.cwd;
  const projectId = props.projectId;
  // Snapshot the spawn config at mount time — if the runner is renamed the
  // PTY shouldn't care. If the user changes program/args later (rare; not
  // exposed in UI yet) we'd need a re-spawn anyway, which is a separate flow.
  const program = props.runner.program;
  const args = [...props.runner.args];
  const kind = props.runner.kind;

  onMount(async () => {
    const term = new XTerm({
      fontFamily: '"Fira Code", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#0a0c11",
        foreground: "#e9ecf1",
        cursor: "#7aa2ff",
        cursorAccent: "#0a0c11",
        selectionBackground: "rgba(122, 162, 255, 0.28)",
        black: "#0a0c11",
        red: "#fb7185",
        green: "#34d399",
        yellow: "#fbbf24",
        blue: "#7aa2ff",
        magenta: "#c4a2ff",
        cyan: "#5eead4",
        white: "#d5dae3",
        brightBlack: "#626b7b",
        brightRed: "#fda4af",
        brightGreen: "#6ee7b7",
        brightYellow: "#fcd34d",
        brightBlue: "#a3c0ff",
        brightMagenta: "#ddc9ff",
        brightCyan: "#99f6e4",
        brightWhite: "#f4f6f9",
      },
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 20_000,
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);

    term.open(host);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (e) {
      console.warn("WebGL renderer unavailable:", e);
    }

    fit.fit();

    // xterm.js sends \r for both Enter and Shift+Enter, so Claude treats both
    // as submit. Intercept Shift+Enter and write a literal newline instead —
    // most Ink-based CLIs (Claude included) read \r as submit and \n as
    // inline newline. If a future Claude build stops accepting \n, swap to
    // "\x1b\r" (Alt+Enter).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
        ptyWrite(id, "\n").catch(console.error);
        return false;
      }
      return true;
    });

    const decoder = new TextDecoder("utf-8");
    const onChunk = (chunk: Uint8Array) =>
      term.write(decoder.decode(chunk, { stream: true }));

    // Wire up onData BEFORE attaching. Attach replays the PTY's buffered
    // output, which for a freshly-spawned agent includes Claude's startup
    // cursor-position query (DSR `ESC[6n`). xterm auto-answers that query, but
    // its answer only reaches Claude through this onData handler — if it isn't
    // registered yet, the answer is dropped and Claude blocks forever waiting
    // for it, drawing nothing but a cursor. This bites hardest on Windows
    // ConPTY, where the query reliably lands in the initial buffer snapshot
    // (replayed synchronously on attach) rather than arriving live afterward.
    const dataDisp = term.onData((data) => {
      ptyWrite(id, data).catch(console.error);
    });
    const resizeDisp = term.onResize(({ cols, rows }) => {
      ptyResize(id, cols, rows).catch(console.error);
    });

    try {
      await ptyAttach(id, onChunk);
      await ptyResize(id, term.cols, term.rows).catch(() => {});
    } catch {
      // Runner has no live PTY (restored from SQLite after a restart, or
      // stopped from the UI). Spawn one in-place using the runner's persisted
      // program/args — NOT a hardcoded claude command, so a kind='shell'
      // runner comes back as a shell. The backend folds `--resume <session>`
      // into the command when a transcript for this runner already exists, so
      // an agent picks its conversation up where it left off.
      try {
        await ptySpawn({
          id,
          cwd,
          program,
          args,
          cols: term.cols,
          rows: term.rows,
          projectId,
          kind,
        });
        await ptyAttach(id, onChunk);
        markRunnerLive(id, true);
      } catch (e) {
        console.error("revive failed", e);
      }
    }

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(host);

    term.focus();

    onCleanup(() => {
      ro.disconnect();
      dataDisp.dispose();
      resizeDisp.dispose();
      term.dispose();
      ptyDetach(id).catch(() => {});
    });
  });

  return <div ref={host} class="min-h-0 min-w-0 flex-1 px-2.5 py-1.5" />;
}
