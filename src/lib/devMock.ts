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

const now = Math.floor(Date.now() / 1000);

const PROJECTS = [
  {
    id: "p-metamorfosis",
    name: "Metamorfosis",
    slug: "metamorfosis",
    folders: ["/Users/bruno/code/metamorfosis-root/repos/metamorfosis_flutter"],
    memory: "Flutter + Firebase. Release pela Codemagic.",
    cwd: "/Users/bruno/code/metamorfosis-root/repos/metamorfosis_flutter",
    created_at: now - 86_400 * 40,
  },
  {
    id: "p-cosmos",
    name: "Cosmos",
    slug: "cosmos",
    folders: ["/Users/bruno/code/cosmos-agents", "/Users/bruno/code/.dev-logs"],
    memory: "",
    cwd: "/Users/bruno/code/cosmos-agents",
    created_at: now - 86_400 * 12,
  },
  {
    id: "p-iquit",
    name: "iQuit",
    slug: "iquit",
    folders: ["/Users/bruno/code/iquit"],
    memory: "",
    cwd: "/Users/bruno/code/iquit",
    created_at: now - 86_400 * 90,
  },
];

const RUNNERS = (
  [
    ["r1", "p-metamorfosis", "agent", "Corrigir build iOS na Codemagic", "claude"],
    ["r2", "p-metamorfosis", "shell", "fastlane", "zsh"],
    ["r3", "p-cosmos", "agent", "Fila de mensagens do chat", "claude"],
    ["r4", "p-cosmos", "agent", "Release 0.4 com auto-update", "claude"],
    ["r5", "p-cosmos", "shell", "vite", "zsh"],
    ["r6", "p-iquit", "agent", "Textos do onboarding", "claude"],
    ["r7", "p-iquit", "agent", "Nova sessão", "claude"],
  ] as const
).map(([id, projectId, kind, name, program], i) => ({
  id,
  project_id: projectId,
  kind,
  name,
  program,
  args: kind === "agent" ? ["-c", "exec claude --dangerously-skip-permissions"] : [],
  env: {},
  with_status_fsm: kind === "agent",
  created_at: now - 3600 * (i + 1),
  last_active: now - 60 * i * i * 7,
  session_id: kind === "agent" ? `sess-${id}` : "",
  mode: kind === "agent" && id !== "r1" ? "chat" : "tty",
  name_auto: id === "r7",
}));

const STATUSES: Record<string, string> = {
  r1: "tool_running",
  r2: "running",
  r3: "idle",
  r4: "awaiting_input",
  r5: "running",
};

const ROOT = "/Users/bruno/code/cosmos-agents";
const j = (v: unknown) => JSON.stringify(v);
const asst = (id: string, content: unknown[]) =>
  j({ type: "assistant", uuid: id, message: { id, model: "claude-opus-5", content, usage: { input_tokens: 4200, cache_read_input_tokens: 61000 } } });
const user = (id: string, content: unknown) => j({ type: "user", uuid: id, message: { role: "user", content } });

const HISTORY: Record<string, string[]> = {
  r3: [
    user("u1", "As mensagens que mando enquanto o agente trabalha somem. Descobre por que e arruma."),
    asst("a1", [{ type: "thinking", thinking: "Preciso ver como o store trata envio com turno em andamento." }]),
    asst("a2", [{ type: "text", text: "Vou olhar como o store do chat trata um envio quando já existe um turno rodando." }]),
    asst("a3", [{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "busy", path: `${ROOT}/src/stores` } }]),
    user("u2", [{ type: "tool_result", tool_use_id: "t1", content: "src/stores/chat.ts:504: const waiting = state.busy;" }]),
    asst("a4", [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: `${ROOT}/src/stores/chat.ts` } }]),
    user("u3", [{ type: "tool_result", tool_use_id: "t2", content: "export function send(...) { ... }" }]),
    asst("a5", [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: `${ROOT}/src/stores/chat.ts`, old_string: "  if (state.busy) return;", new_string: "  if (state.busy) {\n    queue.push(message);\n    return;\n  }" } }]),
    user("u4", [{ type: "tool_result", tool_use_id: "t3", content: "The file has been updated." }]),
    asst("a6", [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "pnpm tsc --noEmit", description: "Checar tipos" } }]),
    user("u5", [{ type: "tool_result", tool_use_id: "t4", content: "" }]),
    asst("a7", [{ type: "text", text: "Achei. `send` retornava cedo quando `busy` era verdadeiro, então a mensagem nunca saía do cliente.\n\nAgora ela entra numa fila e é despachada quando o turno termina:\n\n- aparece na conversa marcada como **Na fila**, com um botão para desistir\n- `Parar` interrompe o turno e limpa a fila\n\nOs tipos passam. Não rodei o app; vale testar mandando duas mensagens seguidas." }]),
  ],
  r6: [
    user("u1", "Reescreve os três textos do onboarding em um tom mais direto."),
    asst("a1", [{ type: "text", text: "Feito. Os três ficaram com uma frase só cada, sem exclamação. Quer que eu aplique também na versão em espanhol?" }]),
  ],
};

const SNAPSHOT: Record<string, string[]> = {
  r4: [
    asst("b1", [{ type: "text", text: "A versão está em 0.4.0 no `tauri.conf.json` e no `Cargo.toml`. Falta publicar a tag para o updater enxergar." }]),
    asst("b2", [{ type: "tool_use", id: "p1", name: "Bash", input: { command: "git tag v0.4.0 && git push origin v0.4.0", description: "Publicar a tag v0.4.0" } }]),
    j({ type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "p1", input: { command: "git tag v0.4.0 && git push origin v0.4.0", description: "Publicar a tag v0.4.0" } } }),
  ],
};

const listeners: { event: string; handler: number }[] = [];

function emit(event: string, payload: unknown): void {
  const cbs = (window as unknown as { __TAURI_MOCK_CBS__: Record<number, (v: unknown) => void> }).__TAURI_MOCK_CBS__;
  for (const l of listeners) if (l.event === event) cbs[l.handler]?.({ event, payload, id: 0 });
}

/** A canned turn, so the streaming states can be looked at in a browser. */
function fakeTurn(runnerId: string): void {
  let seq = 1000 + Math.floor(Math.random() * 1e6);
  const line = (v: unknown) => emit("agent-line", { runnerId, seq: seq++, line: j(v) });
  const status = (s: string) => emit("runner-status", { projectId: "p-cosmos", runnerId, status: s });
  const words = "Certo. Isto é uma resposta simulada: no app de verdade, é o Claude Code que responde aqui, com as mesmas ferramentas do terminal.".split(" ");
  status("streaming");
  setTimeout(() => {
    line({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: `m${seq}` } } });
    line({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    words.forEach((w, i) =>
      setTimeout(
        () => line({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${w} ` } } }),
        i * 45,
      ),
    );
    setTimeout(() => {
      line({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.42, num_turns: 3, usage: { output_tokens: 180 } });
      status("idle");
    }, words.length * 45 + 200);
  }, 900);
}

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
  "plugin:event|listen": (args) => {
    listeners.push({ event: String(args.event), handler: Number(args.handler) });
    if (args.event === "runner-status") {
      setTimeout(() => {
        for (const [runnerId, status] of Object.entries(STATUSES)) {
          const projectId = RUNNERS.find((r) => r.id === runnerId)?.project_id;
          emit("runner-status", { projectId, runnerId, status });
        }
      }, 300);
    }
    return listeners.length;
  },
  agent_history: (args) => HISTORY[String(args.id)] ?? [],
  agent_snapshot: (args) => (SNAPSHOT[String(args.id)] ?? []).map((line, i) => ({ runnerId: args.id, seq: i + 1, line })),
  agent_send: (args) => {
    if (String(args.line).includes('"type":"user"')) fakeTurn(String(args.id));
    if (String(args.line).includes('"control_response"'))
      emit("runner-status", { projectId: "p-cosmos", runnerId: args.id, status: "idle" });
    return null;
  },
  session_title_get: () => ({ custom: null, ai: null }),
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
  git_diff: () =>
    [
      "diff --git a/src/stores/chat.ts b/src/stores/chat.ts",
      "--- a/src/stores/chat.ts",
      "+++ b/src/stores/chat.ts",
      "@@ -504,3 +504,6 @@ export function send(",
      "-  if (state.busy) return;",
      "+  if (state.busy) {",
      "+    queue.push(message);",
      "+    return;",
      "+  }",
    ].join("\n"),
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
