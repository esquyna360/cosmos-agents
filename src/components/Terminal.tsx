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
        background: "#0b0d10",
        foreground: "#e6e6e6",
        cursor: "#e6e6e6",
        selectionBackground: "#3a3f4b",
      },
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
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

    try {
      await ptyAttach(id, onChunk);
      await ptyResize(id, term.cols, term.rows).catch(() => {});
    } catch {
      // Runner has no live PTY (likely restored from SQLite). Spawn one
      // in-place using the runner's persisted program/args — NOT a hardcoded
      // claude command. This is the subtle revive bug we explicitly guard
      // against: a kind='shell' runner restored after restart must come back
      // as a shell, not Claude.
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

    const dataDisp = term.onData((data) => {
      ptyWrite(id, data).catch(console.error);
    });
    const resizeDisp = term.onResize(({ cols, rows }) => {
      ptyResize(id, cols, rows).catch(console.error);
    });

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

  return <div ref={host} class="min-h-0 min-w-0 flex-1 p-2" />;
}
