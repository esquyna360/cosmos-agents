# Cosmos

Native Mac app to orchestrate N parallel AI coding agents — Tauri 2 + SolidJS + Rust.

> Replaces the "Ghostty tab as cognitive memory" pattern (tab 3 = Metamorfosis,
> tab 7 = Cosmos, …) with a real orchestration layer. Cosmos does NOT replace
> Claude Code / Codex / etc — it spawns them in PTYs, watches their byte
> streams, and gives you status + memory + side-by-side editor + diff.

## Features

- **Projects** with 1..6 working folders. Each project lives at
  `~/.cosmos/projects/<slug>/`. Sticky slug = filesystem handle that doesn't
  move on rename. Names are unique (case-insensitive).
- **Runners** as tabs inside the project main pane:
  - `agent` — runs an AI CLI under a PTY with a heuristic FSM that infers
    `idle / streaming / tool_running / awaiting_input` from the byte stream.
  - `shell` — interactive zsh. Or a one-click `+ shell` dropdown of detected
    `package.json` scripts (pnpm/yarn/bun/npm picked from lockfile).
- **CLI presets** with `$PATH` detection — Claude Code and Codex out of the
  box, "not installed" shown when the binary isn't on PATH. Picker when
  spawning a new agent or creating a project.
- **Memory tab** — kind-typed cards (note / decision / snippet / todo) as
  individual `.md` files in `~/.cosmos/projects/<slug>/memories/`. HTML-comment
  frontmatter so they're portable in any MD reader. Pinned cards auto-flow
  into the multi-folder `.claude/CLAUDE.md` so Claude reads them every turn.
- **Editor + Diff** view modes (CodeMirror 6 + `git diff`), state persisted
  per project so view switches don't lose the open tab. The editor carries
  the parts of VS Code that matter without extensions: search/replace
  (`⌘F`), autocompletion, code folding, indent guides, multi-cursor,
  bracket matching, breadcrumbs, a Ln/Col status bar and ~25 languages.
- **Pane grid** — the main area is a grid of 1..4 panes: single, side by
  side, stacked, quadrants, or main + 2. Each slot holds any runner of the
  focused project and the assignment is remembered per project. A PTY is
  attached in exactly one slot, so the grid de-dupes and back-fills as
  runners come and go.
- **Revivable sessions** — every agent runner owns a Claude session UUID.
  First boot pins it with `--session-id`; later boots `--resume` it when the
  transcript exists under `~/.claude/projects/`. Stopping a runner or
  sleeping a project kills the PTY and keeps the row, so clicking it again
  picks the conversation back up.
- **Themes** — six palettes (Midnight, Graphite, Obsidian, Ember, Dawn,
  Paper) driven entirely by CSS variables, so a swap is one attribute on
  `<html>`. The terminal and the code editor read the same variables, so
  nothing is left behind on the old palette. `⌘⇧T` cycles.
- **Browser pane** — an iframe preview with a URL bar, back/forward/reload
  and chips for whichever localhost ports are actually listening (probed with
  an opaque `no-cors` fetch). Anything that refuses framing opens in the
  system browser instead.
- **Self-update** — checks GitHub Releases at launch and every 6 h on macOS
  and Windows. Auto-install only fires when no runner is live, because
  relaunching kills every PTY; otherwise it waits behind a banner.
- **Settings sheet** (`⌘,`) — theme picker, keymap reference, and the remote
  switches: web UI, Cloudflare tunnel (toggles live, no restart), Telegram
  notifications.
- **Drag to reorder** projects and runners in the sidebar; double-click any
  name to rename in place. Order is persisted in a `position` column.
- Sidebar resizable; markdown rendering via `marked`.

## Keymap

| | |
|---|---|
| `⌘T` | new project |
| `⌘⇧N` | new agent runner in current project |
| `⌘W` | stop the focused runner (keeps it — click to resume) |
| `⌘⇧W` | stop every runner of the project |
| `⌘1–9` | focus N-th project |
| `⌘⌥1–5` | pane layout: single / side by side / stacked / quadrants / main + 2 |
| `⌃1–4` | focus N-th pane |
| `⌘\` | toggle split (single ↔ side by side) |
| `⌘B` | show/hide the project sidebar |
| `⌘E` | cycle view (runners → editor → diff → memory → browser) |
| `⌘P` / `⌘⇧F` | file palette / grep |
| `⌘I` | toggle composer |
| `⌘D` | workflow overview |
| `⌘,` | settings |
| `⌘⇧T` | next theme |
| `⌘F` | find/replace inside the editor |
| `⌘S` | save now (files autosave anyway) |

## Stack

- **Tauri 2** shell, ~30 MB binary, WebKit on macOS
- **SolidJS** + TypeScript + Tailwind + Vite frontend
- **Rust** backend: `rusqlite` for state, `portable-pty` for PTYs, custom
  heuristic FSM (`status_fsm.rs`) for inferring agent state from byte streams
- **xterm.js** with WebGL renderer for terminal display
- **CodeMirror 6** for both the file editor and memory body editor
- **marked** for markdown rendering

## Storage

- SQLite at `~/Library/Application Support/.../cosmos.sqlite` —
  projects + runners (id, slug, kind, program, args, `session_id`, etc).
  Schema version lives in `PRAGMA user_version`; migrations run on open.
- Each project: `~/.cosmos/projects/<slug>/` (always materialized for memory
  storage; for multi-folder projects also contains `.claude/CLAUDE.md`).
- Memory cards: `<project-dir>/memories/<title-slug>-<id>.md` with
  `<!-- cosmos-meta {...} -->` first line.

## Install

Builds live on **GitHub Releases**, one per tag:
<https://github.com/esquyna360/cosmos-agents/releases>

| platform | artifact |
|---|---|
| macOS Apple Silicon | `Cosmos_<ver>_aarch64.dmg` |
| macOS Intel | `Cosmos_<ver>_x64.dmg` |
| Windows | `Cosmos_<ver>_x64-setup.exe` |

The app self-updates from `latest.json` on the same release, so after the
first install you only need the dmg/exe again for a clean machine.

Cutting a release: `scripts/release.sh minor` bumps the three version files,
tags, pushes, waits for the Action, and drops the fresh macOS build into
`/Applications`.

## Running locally

Requires Rust toolchain + Node 20+ + pnpm + macOS.

```bash
pnpm install
pnpm tauri dev
```

Design work happens faster in a browser tab: `pnpm dev` alone serves the UI at
<http://localhost:1420> with `src/lib/devMock.ts` standing in for the Rust
backend (fake projects, runners and a file tree). It only loads when
`__TAURI_INTERNALS__` is absent and is tree-shaken out of production builds.

The release build (`pnpm tauri build`) produces a `.app` under
`src-tauri/target/release/bundle/macos/`.

## Status

Personal project. Works for me. macOS is the primary target; Windows builds
and runs (package-script runners go through PowerShell there). Linux is close
— small zsh-path tweaks needed.

## License

No license declared — all rights reserved by the author.
