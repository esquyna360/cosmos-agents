/**
 * Browser stand-in for the Tauri backend.
 *
 * Cosmos is a desktop app, but a plain Chrome tab pointed at the vite dev
 * server is the only way to iterate on the visual design with a screenshot in
 * hand. This installs a fake `__TAURI_INTERNALS__` so every `invoke` resolves
 * with plausible data instead of throwing. It is stripped from production
 * builds: the caller guards on `import.meta.env.DEV`, which Rollup folds to
 * `false` and drops.
 */

const now = Date.now();

const PROJECTS = [
  {
    id: "p-metamorfosis",
    name: "Metamorfosis",
    slug: "metamorfosis",
    folders: ["/Users/bruno/code/metamorfosis-root/repos/metamorfosis_flutter"],
    memory: "Flutter + Firebase. Release pela Codemagic.",
    cwd: "/Users/bruno/code/metamorfosis-root/repos/metamorfosis_flutter",
    created_at: now - 86_400_000 * 40,
  },
  {
    id: "p-cosmos",
    name: "Cosmos",
    slug: "cosmos",
    folders: ["/Users/bruno/code/cosmos-agents", "/Users/bruno/code/.dev-logs"],
    memory: "",
    cwd: "/Users/bruno/code/cosmos-agents",
    created_at: now - 86_400_000 * 12,
  },
  {
    id: "p-iquit",
    name: "iQuit",
    slug: "iquit",
    folders: ["/Users/bruno/code/iquit"],
    memory: "",
    cwd: "/Users/bruno/code/iquit",
    created_at: now - 86_400_000 * 90,
  },
];

const RUNNERS = (
  [
    ["r1", "p-metamorfosis", "agent", "Build iOS", "claude"],
    ["r2", "p-metamorfosis", "shell", "fastlane", "zsh"],
    ["r3", "p-cosmos", "agent", "UX overhaul", "claude"],
    ["r4", "p-cosmos", "agent", "Release", "claude"],
    ["r5", "p-cosmos", "shell", "vite", "zsh"],
    ["r6", "p-iquit", "agent", "Onboarding copy", "claude"],
  ] as const
).map(([id, projectId, kind, name, program], i) => ({
  id,
  project_id: projectId,
  kind,
  name,
  program,
  args: kind === "agent" ? ["--dangerously-skip-permissions"] : [],
  env: {},
  with_status_fsm: kind === "agent",
  created_at: now - 3_600_000 * (i + 1),
  last_active: now - 60_000 * i,
  session_id: kind === "agent" ? `sess-${id}` : "",
}));

const STATUSES: Record<string, string> = {
  r1: "tool_running",
  r2: "running",
  r3: "streaming",
  r4: "awaiting_input",
  r5: "running",
  r6: "idle",
};

const E = "\x1b[";
const BANNER = [
  `${E}38;5;110m>${E}0m pnpm dev`,
  "",
  `  ${E}32mVITE v6.0.7${E}0m  ready in ${E}1m412 ms${E}0m`,
  "",
  `  ${E}32m->${E}0m  Local:   ${E}36mhttp://localhost:1420/${E}0m`,
  `  ${E}32m->${E}0m  Network: use ${E}1m--host${E}0m to expose`,
  "",
  `${E}38;5;110m>${E}0m ${E}38;5;180mcargo${E}0m check`,
  `    ${E}32;1mChecking${E}0m agent-dashboard v0.2.0`,
  `    ${E}32;1mFinished${E}0m \`dev\` profile in 2.59s`,
  "",
].join("\r\n");

const TREE: Record<string, string[]> = {
  "/Users/bruno/code/metamorfosis-root/repos/metamorfosis_flutter": [
    "lib",
    "test",
    "pubspec.yaml",
    "README.md",
  ],
  "/Users/bruno/code/metamorfosis-root/repos/metamorfosis_flutter/lib": [
    "main.dart",
    "app_router.ts",
    "theme.css",
  ],
  "/Users/bruno/code/cosmos-agents": ["src", "src-tauri", "package.json"],
  "/Users/bruno/code/cosmos-agents/src": ["App.tsx", "index.tsx", "styles.css"],
};

function SAMPLE(path: string): string {
  if (path.endsWith(".yaml")) {
    return [
      "name: metamorfosis",
      "description: exemplo",
      "environment:",
      "  sdk: '>=3.4.0 <4.0.0'",
      "dependencies:",
      "  flutter:",
      "    sdk: flutter",
      "  firebase_core: ^3.6.0",
    ].join("\n");
  }
  if (path.endsWith(".md")) {
    return "# Metamorfosis\n\nApp de habitos.\n\n- Flutter\n- Firebase\n";
  }
  return [
    "import { createSignal, type Accessor } from \"solid-js\";",
    "",
    "interface Options {",
    "  /** Milissegundos entre tentativas. */",
    "  delay: number;",
    "  retries?: number;",
    "}",
    "",
    "const DEFAULTS: Options = { delay: 250, retries: 3 };",
    "",
    "export function useRetry<T>(fn: () => Promise<T>, opts?: Options) {",
    "  const { delay, retries = 3 } = { ...DEFAULTS, ...opts };",
    "  const [value, setValue] = createSignal<T | null>(null);",
    "  let attempt = 0;",
    "",
    "  async function run(): Promise<void> {",
    "    try {",
    "      setValue(() => await fn());",
    "    } catch (err) {",
    "      if (attempt++ >= retries) throw err;",
    "      setTimeout(run, delay * attempt);",
    "    }",
    "  }",
    "",
    "  run();",
    "  return value as Accessor<T | null>;",
    "}",
  ].join("\n");
}

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  projects_list: () => PROJECTS,
  runners_list: () => RUNNERS,
  pty_live_ids: () => Object.keys(STATUSES),
  app_version: () => "0.3.0",
  web_info: () => ({
    port: 7777,
    local: "http://127.0.0.1:7777/?t=dev",
    tunnel: "https://mock-tunnel.trycloudflare.com",
    link: "https://mock-tunnel.trycloudflare.com/?t=dev",
  }),
  remote_config_get: () => ({
    enabled: true,
    port: 7777,
    tunnel: true,
    telegram_notify: true,
    telegram_chat_id: "7230480470",
    telegram_token_file: "~/.private_keys/telegram_bot_token",
    tunnel_running: true,
    cloudflared_present: true,
  }),
  clis_get: () => [],
  clis_detect: () => [],
  fs_claude_md: () => "# CLAUDE.md\n\nProjeto de exemplo.",
  fs_detect_stack: () => [
    { label: "Flutter", color: "#42a5f5" },
    { label: "Firebase", color: "#ffca28" },
  ],
  fs_read_dir: (args) => {
    const path = String(args.path ?? "");
    const at = TREE[path];
    if (!at) return [];
    return at.map((name) => ({
      name,
      path: `${path}/${name}`,
      is_dir: !name.includes("."),
    }));
  },
  fs_walk: () => Object.values(TREE).flat(),
  fs_grep: () => [],
  fs_read_package_scripts: () => ({ dev: "vite", build: "vite build" }),
  fs_read_file: (args) => SAMPLE(String(args.path ?? "file.ts")),
  git_diff: () => "",
  memories_list: () => [],
  pty_attach: (args) => {
    const output = args.output as { onmessage?: (m: unknown) => void } | undefined;
    if (output?.onmessage) {
      const bytes = new TextEncoder().encode(BANNER);
      setTimeout(() => output.onmessage!(Array.from(bytes)), 60);
    }
    return null;
  },
};

export function installDevMock(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI_INTERNALS__) return;

  const callbacks: Record<number, unknown> = {};
  w.__TAURI_MOCK_CBS__ = callbacks;
  w.__TAURI_INTERNALS__ = {
    transformCallback(cb: (v: unknown) => void) {
      const id = Math.floor(Math.random() * 1e9);
      callbacks[id] = cb;
      return id;
    },
    invoke(cmd: string, args: Record<string, unknown> = {}) {
      const h = HANDLERS[cmd];
      if (h) return Promise.resolve(h(args));
      // Everything else is a side effect the mock has nothing to say about.
      return Promise.resolve(null);
    },
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    plugins: {},
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => Promise.resolve(),
  };
}
