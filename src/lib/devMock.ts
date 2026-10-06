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
    id: "p-geral",
    name: "geral",
    slug: "geral",
    folders: ["/Users/bruno/code"],
    memory: "",
    cwd: "/Users/bruno/.cosmos/projects/geral",
    created_at: now - 86_400 * 120,
  },
  {
    id: "p-metamorfosis",
    name: "Metamorfosis",
    slug: "metamorfosis",
    folders: ["/Users/bruno/code/apps/metamorfosis/repos/metamorfosis_flutter"],
    memory: "Flutter + Firebase. Release pela Codemagic.",
    cwd: "/Users/bruno/code/apps/metamorfosis/repos/metamorfosis_flutter",
    created_at: now - 86_400 * 40,
  },
  {
    id: "p-cosmos",
    name: "Cosmos",
    slug: "cosmos",
    folders: ["/Users/bruno/code/tools/cosmos-agents", "/Users/bruno/code/.dev-logs"],
    memory: "",
    cwd: "/Users/bruno/code/tools/cosmos-agents",
    created_at: now - 86_400 * 12,
  },
  {
    id: "p-iquit",
    name: "iQuit",
    slug: "iquit",
    folders: ["/Users/bruno/code/apps/iquit/iquit"],
    memory: "",
    cwd: "/Users/bruno/code/apps/iquit/iquit",
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
    ["r8", "p-iquit", "agent", "Migrar analytics", "claude"],
    ["r9", "p-iquit", "shell", "flutter run", "zsh"],
    ["r0", "p-geral", "agent", "geral", "claude"],
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
  last_active: id === "r8" || id === "r9" ? now - 86_400 * 9 : now - 60 * i * i * 7,
  cwd: id === "r3" ? "/Users/bruno/.cosmos/worktrees/cosmos/fila-de-mensagens" : "",
  branch: id === "r3" ? "cosmos/fila-de-mensagens" : "",
  task:
    {
      r1: "O build iOS quebra no pod install depois do upgrade do Firebase.",
      r3: "As mensagens que mando enquanto o agente trabalha somem. Descobre por que e arruma.",
      r4: "Publicar a 0.4 e conferir que o updater enxerga a versão nova.",
      r6: "Reescreve os três textos do onboarding em um tom mais direto.",
    }[id as string] ?? "",
  session_id: kind === "agent" ? `sess-${id}` : "",
  mode: kind === "agent" && id !== "r1" ? "chat" : "tty",
  name_auto: id === "r7",
  model: ({ r1: "opus", r3: "sonnet", r4: "sonnet", r6: "deepseek-flash", r8: "haiku" } as Record<string, string>)[id] ?? "",
  provider: id === "r6" ? "deepseek" : "",
  parent_id: id === "r3" || id === "r6" ? "r0" : "",
}));

// `?stress=40` fills the board, to check the canvas with dozens of cards.
const STRESS = Number(new URLSearchParams(location.search).get("stress") ?? 0);
for (let i = 0; i < STRESS; i++) {
  const pi = Math.floor(i / 6);
  if (i % 6 === 0)
    PROJECTS.push({
      id: `p-x${pi}`,
      name: `Projeto ${pi + 1}`,
      slug: `projeto-${pi + 1}`,
      folders: [`/Users/bruno/code/apps/projeto-${pi + 1}`],
      memory: "",
      cwd: `/Users/bruno/code/apps/projeto-${pi + 1}`,
      created_at: now - 86_400,
    });
  (RUNNERS as unknown[]).push({
    ...RUNNERS[0],
    id: `x${i}`,
    project_id: `p-x${pi}`,
    name: `Tarefa ${i + 1} do projeto ${pi + 1}`,
    task: "Uma tarefa de teste para encher o quadro.",
    session_id: `sess-x${i}`,
    last_active: now - 30 * i,
    model: ["opus", "sonnet", "haiku"][i % 3],
    provider: "",
    parent_id: i % 4 === 0 ? "r0" : i % 7 === 0 ? `x${i - 1}` : "",
  });
}

const STATUSES: Record<string, string> = {
  r1: "tool_running",
  r2: "running",
  r3: "idle",
  r4: "awaiting_input",
  r5: "running",
};

const ROOT = "/Users/bruno/code/tools/cosmos-agents";
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
  "/Users/bruno/code/apps/metamorfosis/repos/metamorfosis_flutter": [
    "lib",
    "test",
    "pubspec.yaml",
    "README.md",
  ],
  "/Users/bruno/code/apps/metamorfosis/repos/metamorfosis_flutter/lib": [
    "main.dart",
    "app_router.ts",
    "theme.css",
  ],
  "/Users/bruno/code/tools/cosmos-agents": ["src", "src-tauri", "package.json"],
  "/Users/bruno/code/tools/cosmos-agents/src": ["App.tsx", "index.tsx", "styles.css"],
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

interface MockNote {
  id: string;
  path: string;
  name: string;
  title: string;
  source: string;
  group: string;
  description: string;
  tags: string[];
  modified: number;
  words: number;
  links: string[];
  dangling: string[];
  backlinks: number;
  content: string;
}

// A vault shaped like the real one: a memory index per project, a few
// guidelines everybody cites, and dev logs that mostly stand alone.
const VAULT: MockNote[] = (() => {
  const notes: MockNote[] = [];
  const add = (source: string, group: string, name: string, title: string, description: string, tags: string[], body: string) => {
    const dir =
      source === "memory"
        ? `~/.claude/projects/-Users-bruno-code-${group}/memory`
        : source === "guideline"
          ? `~/code/guidelines${group ? `/${group}` : ""}`
          : source === "devlog"
            ? `~/code/.dev-logs/${group}`
            : source === "claude"
              ? `~/code/${group}`
              : "~/.cosmos/brain";
    const file = source === "claude" ? "CLAUDE.md" : `${name}.md`;
    const front = source === "memory" || source === "note" ? `---\nname: ${name}\ndescription: "${description}"\n---\n\n` : "";
    notes.push({
      id: `${dir}/${file}`,
      path: `/Users/bruno${dir.slice(1)}/${file}`,
      name,
      title,
      source,
      group,
      description,
      tags,
      modified: now - ((notes.length * 7919) % (86_400 * 40)) - 300,
      words: 0,
      links: [],
      dangling: [],
      backlinks: 0,
      content: `${front}${source === "memory" ? "" : `# ${title}\n\n`}${body}\n`,
    });
  };
  add("guideline", "", "PADRAO-DE-QUALIDADE", "Padrão de qualidade", "", ["qualidade"], "Tudo que sai tem nível AAA.\n\n- Loja que vende: ver [[store-screenshots]].\n- Produto completo: feedback, meta, retenção.\n- Envio pras lojas em [[REFERENCIA]].");
  add("guideline", "", "REFERENCIA", "Referência de build e lojas", "", ["build"], "## Android\n\nAssinatura com o keystore do KeyVerse. Ver [[web-portal-upload]] para os portais.\n\n```sh\nfastlane android release\n```\n\n## iOS\n\nSobe pelo `xcrun altool`. Padrão em [[PADRAO-DE-QUALIDADE]].");
  add("guideline", "ads", "store-screenshots", "Screenshots de loja", "", ["loja", "aso"], "Promessa em cima, momento de pico embaixo. Nunca print cru.\n\nVale para todo app: [[PADRAO-DE-QUALIDADE]].");
  add("guideline", "", "AGENTES", "Agentes e escopo", "", ["agentes"], "Cada agente roda na pasta do seu escopo. O Hub decide com `cosmos route`.");
  const projects = ["ninar", "iquit", "splat-up", "cat-arcade", "one-cue", "metamorfosis", "tangle", "frog-dive"];
  const topics: [string, string, string[]][] = [
    ["paywall", "Como o paywall cobra e quando aparece", ["project", "monetizacao"]],
    ["web-portal-upload", "Upload de build no CrazyGames e Poki, passo a passo", ["reference", "upload"]],
    ["release-checklist", "O que conferir antes de mandar pra loja", ["feedback", "build"]],
    ["retencao", "Ganchos de retenção que funcionaram", ["project", "retencao"]],
    ["bugs-conhecidos", "Bugs que voltam e como resolver", ["feedback"]],
    ["aso-keywords", "Palavras-chave e posição na loja", ["reference", "aso"]],
  ];
  projects.forEach((project, pi) => {
    const mine = topics.filter((_, ti) => (pi + ti) % 4 !== 3);
    add("claude", `games/${project}`, "CLAUDE", `CLAUDE.md · ${project}`, "", [], `Projeto ${project}. Siga [[PADRAO-DE-QUALIDADE]] e [[REFERENCIA]].`);
    add(
      "memory",
      `games-${project}`,
      "MEMORY",
      `Memória · ${project}`,
      "",
      [],
      mine.map(([name, description]) => `- [${name}](${name}.md) — ${description}`).join("\n"),
    );
    mine.forEach(([name, description, tags], ti) => {
      const other = mine[(ti + 1) % mine.length][0];
      const extra = ti % 2 === 0 ? " Segue o [[PADRAO-DE-QUALIDADE]]." : ti % 3 === 0 ? " Detalhes em [[REFERENCIA]] e [[store-screenshots]]." : " Falta escrever [[plano-de-lancamento]].";
      add("memory", `games-${project}`, name, name, description, tags, `${description} no ${project}.\n\nRelacionado: [[${other}]].${extra}\n\n**Why:** aprendido em produção.\n**How to apply:** conferir antes de cada versão. #${tags[tags.length - 1]}`);
    });
    for (let d = 0; d < 5; d++) {
      const linked = d === 0;
      add("devlog", `${project}/v1.${d}`, `relatorio-${d}`, `${project}: relatório v1.${d}`, "", [], linked ? `Build enviado seguindo [[web-portal-upload]] e [[release-checklist]].` : `Capturas e medições da versão 1.${d}. Sem pendências.`);
    }
  });
  add("note", "", "decisao-preco-ninar", "Decisão: preço do Ninar", "Preço mensal e por quê", ["decisao", "monetizacao"], "Fica em R$ 19,90 por mês. Ver [[paywall]] e [[aso-keywords]].\n\n> Revisar em dezembro.");
  add("note", "", "ideias-de-jogo", "Ideias de jogo", "Lista viva de conceitos", ["ideias"], "- Capivara canhão\n- Sapo mergulhador: virou [[retencao]] de estudo\n- [[jogo-de-ritmo]]");

  const keys = new Map<string, MockNote[]>();
  for (const n of notes) {
    if (n.name === "CLAUDE" || n.name === "MEMORY") continue;
    for (const k of [n.name.toLowerCase(), n.title.toLowerCase()]) keys.set(k, [...(keys.get(k) ?? []), n]);
  }
  for (const n of notes) relink(n, notes, keys);
  return notes;
})();

function vaultKeys(): Map<string, MockNote[]> {
  const keys = new Map<string, MockNote[]>();
  for (const n of VAULT) {
    if (n.name === "CLAUDE" || n.name === "MEMORY") continue;
    for (const k of [n.name.toLowerCase(), n.title.toLowerCase()]) keys.set(k, [...(keys.get(k) ?? []), n]);
  }
  return keys;
}

function mockResolved(n: MockNote, all: MockNote[], keys: Map<string, MockNote[]>): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = n.id.slice(0, n.id.lastIndexOf("/"));
  for (const m of n.content.matchAll(/\[\[([^\]|#\n]+)[^\]\n]*\]\]/g)) {
    const found = keys.get(m[1].trim().toLowerCase()) ?? [];
    const best = found.find((o) => o !== n && o.id.startsWith(`${dir}/`)) ?? found.find((o) => o !== n);
    if (best) out[m[1].trim()] = best.id;
  }
  for (const m of n.content.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
    const to = all.find((o) => o.id === `${dir}/${m[1]}`);
    if (to) out[m[1]] = to.id;
  }
  return out;
}

function relink(n: MockNote, all: MockNote[], keys: Map<string, MockNote[]>): void {
  const resolved = mockResolved(n, all, keys);
  n.links = [...new Set(Object.values(resolved))];
  n.dangling = [...n.content.matchAll(/\[\[([^\]|#\n]+)[^\]\n]*\]\]/g)].map((m) => m[1].trim()).filter((t) => !resolved[t]);
  n.words = n.content.split(/\s+/).filter(Boolean).length;
  const tags = n.content.replace(/^---[\s\S]*?---/, "").match(/(?:^|\s)#([a-zà-ú][\w/-]+)/gi) ?? [];
  for (const t of tags) {
    const tag = t.trim().slice(1).toLowerCase();
    if (!n.tags.includes(tag)) n.tags.push(tag);
  }
}

function vaultIndex(): { notes: Omit<MockNote, "content">[]; tags: [string, number][] } {
  for (const n of VAULT) n.backlinks = 0;
  for (const n of VAULT) for (const to of n.links) VAULT.find((o) => o.id === to)!.backlinks++;
  const counts = new Map<string, number>();
  for (const n of VAULT) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return {
    notes: VAULT.map(({ content: _content, ...rest }) => rest),
    tags: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

function lineWith(n: MockNote, needle: string): string {
  return n.content.split("\n").find((l) => l.includes(needle))?.trim() ?? "";
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
  git_info: (args) =>
    (args.paths as string[]).map((path) => ({
      path,
      isRepo: !path.endsWith("/code"),
      branch: path.includes("worktrees") ? "cosmos/fila-de-mensagens" : path.endsWith("/code") ? null : "main",
      worktrees: path.endsWith("cosmos-agents") ? 1 : 0,
    })),
  projects_list: () => PROJECTS,
  runners_list: () => RUNNERS,
  pty_live_ids: () => [...Object.keys(STATUSES), ...RUNNERS.filter((r) => r.id.startsWith("x")).map((r) => r.id)],
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
  models_list: () => [
    {
      id: "anthropic", name: "Anthropic", base_url: "", key_file: "", available: true,
      models: [
        { id: "opus", label: "Opus", tier: "deep" },
        { id: "sonnet", label: "Sonnet", tier: "work" },
        { id: "haiku", label: "Haiku", tier: "cheap" },
      ],
    },
    {
      id: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com/anthropic",
      key_file: "~/.private_keys/deepseek_api_key", available: true,
      models: [
        { id: "deepseek-flash", label: "DeepSeek Flash", tier: "cheap" },
        { id: "deepseek-v4-pro", label: "DeepSeek Pro", tier: "work" },
      ],
    },
  ],
  runners_vitals: () => {
    const out: Record<string, unknown> = {};
    RUNNERS.filter((r) => r.kind === "agent").forEach((r, i) => {
      out[r.id] = {
        inputTokens: 4200 * (i + 1),
        outputTokens: 900 * (i + 1),
        cacheReadTokens: 61000 * (i + 1),
        cacheWriteTokens: 8000,
        contextTokens: 18000 + ((i * 37_000) % 160_000),
        costUsd: r.id === "r7" ? 0 : 0.18 + ((i * 1.37) % 9),
        model: r.provider ? r.model : "claude-sonnet-5-5",
        title: "",
        last: ({
          r1: "Rodando pod install com o Firebase 12 para reproduzir o erro.",
          r3: "Os tipos passam. Vale testar mandando duas mensagens seguidas.",
          r4: "Posso publicar a tag v0.4.0?",
          r0: "Mandei o build iOS para o agente do Metamorfosis.",
        } as Record<string, string>)[r.id] ?? "",
      };
    });
    return out;
  },
  pty_screens: (args) => {
    const tick = Math.floor(Date.now() / 900);
    const seen = (args.seen ?? {}) as Record<string, number>;
    return (args.ids as string[])
      .map((id, n) => {
        const working = STATUSES[id] === "tool_running" || STATUSES[id] === "streaming" || id.startsWith("x");
        const ver = working ? tick : 1;
        const bar = "█".repeat((tick + n) % 24).padEnd(24, "░");
        return {
          id,
          ver,
          cols: 120,
          lines: [
            [{ t: "⏺ ", c: "2" }, { t: "Read", b: true }, { t: "(src/stores/chat.ts)" }],
            [{ t: "  ⎿  Read 828 lines", d: true }],
            [{ t: "⏺ ", c: "2" }, { t: "Bash", b: true }, { t: "(pnpm exec tsc --noEmit)" }],
            [{ t: `  ⎿  ${bar} ${working ? ((tick + n) % 24) * 4 : 100}%`, d: true }],
            [],
            [{ t: working ? "✻ Verificando os tipos… " : "⏺ Os tipos passam. ", c: working ? "#e6935e" : undefined }, { t: working ? `(${(tick % 90) + 3}s · esc to interrupt)` : "", d: true }],
            [],
            [{ t: "╭──────────────────────────────────────────────────────────────────────────╮", d: true }],
            [{ t: "│ ", d: true }, { t: "> " }, { t: "                                                                        │", d: true }],
            [{ t: "╰──────────────────────────────────────────────────────────────────────────╯", d: true }],
          ],
        };
      })
      .filter((s) => seen[s.id] !== s.ver);
  },
  route_suggest: (args) => {
    const task = String(args.task ?? "").toLowerCase();
    const deep = /arquitet|decis|plano|investig/.test(task);
    const cheap = /traduz|resum|renome|format/.test(task);
    const model = deep
      ? { provider: "", model: "opus", label: "Opus", tier: "deep", reason: 'pede raciocínio ("arquitetura")' }
      : cheap
        ? { provider: "deepseek", model: "deepseek-flash", label: "DeepSeek Flash", tier: "cheap", reason: "tarefa mecânica, vai no mais barato" }
        : { provider: "", model: "sonnet", label: "Sonnet", tier: "work", reason: "execução" };
    if (/onboarding|iquit/.test(task))
      return {
        action: "send", summary: "", command: "", model,
        candidates: [{ project: "iquit", projectName: "iQuit", runnerId: "r6", runnerName: "Textos do onboarding", status: "idle", live: false, score: 11, reasons: ["a tarefa cita `iquit`", "já trabalhou com: onboarding", "está parado (acorda com o contexto que tinha)"] }],
      };
    if (/cosmos|metamorfosis/.test(task)) {
      const cosmos = task.includes("cosmos");
      return {
        action: "spawn", summary: "", command: "", model,
        candidates: [{ project: cosmos ? "cosmos" : "metamorfosis", projectName: cosmos ? "Cosmos" : "Metamorfosis", runnerId: "", runnerName: "", status: "", live: false, score: 8, reasons: [`a tarefa cita \`${cosmos ? "cosmos" : "metamorfosis"}\``, "agente novo, contexto limpo"] }],
      };
    }
    return { action: "self", summary: "", command: "", model, candidates: [] };
  },
  runner_send: () => ({ sent: "r0", via: "tty", woke: false }),
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
  brain_index: () => vaultIndex(),
  brain_open: (args) => {
    const key = String(args.note);
    const note = VAULT.find((n) => n.id === key) ?? VAULT.find((n) => n.name === key);
    if (!note) throw new Error(`nenhuma nota chamada \`${key}\``);
    vaultIndex();
    const resolved = mockResolved(note, VAULT, vaultKeys());
    const { content, ...meta } = note;
    return {
      note: meta,
      content,
      resolved,
      backlinks: VAULT.filter((n) => n.links.includes(note.id)).map((n) => ({
        id: n.id,
        title: n.title,
        source: n.source,
        context: lineWith(n, note.name) || lineWith(n, note.title),
      })),
      outgoing: Object.entries(resolved).map(([written, id]) => {
        const to = VAULT.find((n) => n.id === id)!;
        return { id, title: to.title, source: to.source, context: lineWith(note, written) };
      }),
    };
  },
  brain_search: (args) => {
    const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
    const terms = words.filter((w) => !w.includes(":"));
    const tag = words.find((w) => w.startsWith("tag:"))?.slice(4);
    const source = words.find((w) => w.startsWith("fonte:"))?.slice(6);
    return VAULT.filter((n) => (!tag || n.tags.includes(tag)) && (!source || n.source === source))
      .map((n) => {
        const hay = `${n.title} ${n.name} ${n.description} ${n.content}`.toLowerCase();
        const score = terms.every((t) => hay.includes(t)) ? terms.reduce((sum, t) => sum + (n.title.toLowerCase().includes(t) ? 12 : 1), 0) : -1;
        return { n, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(args.limit) || 60)
      .map(({ n, score }) => ({
        id: n.id,
        name: n.name,
        title: n.title,
        source: n.source,
        group: n.group,
        snippet: n.description || lineWith(n, terms[0] ?? "") || n.content.replace(/^---[\s\S]*?---\s*/, "").split("\n").find((l) => l && !l.startsWith("#")) || "",
        score,
      }));
  },
  brain_save: (args) => {
    const note = VAULT.find((n) => n.id === args.note)!;
    note.content = String(args.content);
    note.modified = Math.floor(Date.now() / 1000);
    relink(note, VAULT, vaultKeys());
    const { content: _content, ...meta } = note;
    return meta;
  },
  brain_create: (args) => {
    const title = String(args.title);
    const name = title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (VAULT.some((n) => n.source === "note" && n.name === name)) throw new Error(`já existe a nota \`${name}\``);
    const note: MockNote = {
      id: `~/.cosmos/brain/${name}.md`,
      path: `/Users/bruno/.cosmos/brain/${name}.md`,
      name,
      title,
      source: "note",
      group: "",
      description: "",
      tags: (args.tags as string[]) ?? [],
      modified: Math.floor(Date.now() / 1000),
      words: 0,
      links: [],
      dangling: [],
      backlinks: 0,
      content: `---\nname: ${name}\n---\n\n# ${title}\n\n`,
    };
    VAULT.push(note);
    for (const n of VAULT) relink(n, VAULT, vaultKeys());
    const { content: _content, ...meta } = note;
    return meta;
  },
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
      if (h) {
        try {
          return Promise.resolve(h(args));
        } catch (e) {
          return Promise.reject(e instanceof Error ? e.message : e);
        }
      }
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
