import { batch } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { listen } from "@tauri-apps/api/event";

import {
  agentHistory,
  agentKill,
  agentSend,
  agentSnapshot,
  agentStart,
  sessionTitleGet,
  sessionTitleSet,
  type AgentLine,
} from "../lib/agent";
import { ptyWrite } from "../lib/ipc";
import {
  allowTool,
  contextUsage,
  denyTool,
  initialize,
  interrupt,
  parseLine,
  renameSession as renameSessionLine,
  setModel as setModelLine,
  setPermissionMode as setPermissionModeLine,
  toolResultText,
  userMessage,
  type ContentBlock,
  type ContextCategory,
  type Inbound,
  type ModelOption,
  type SlashCommand,
  type OutgoingImage,
  type StreamEvent,
  type Usage,
} from "../lib/claudeProtocol";
import { activityLine } from "../lib/toolDisplay";
import { runnersTouch } from "../lib/projects";
import {
  cwdFor,
  findRunner,
  focusedRunner,
  loadProjects,
  markRunnerLive,
  onRunnerKill,
  onRunnerReset,
  patchRunner,
  renameRunner,
} from "./projects";

export type ChatItem =
  | { kind: "user"; id: string; text: string; images: string[]; queued: boolean }
  | { kind: "text"; id: string; text: string; streaming: boolean; parent: string | null }
  | { kind: "thinking"; id: string; text: string; streaming: boolean; parent: string | null }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      state: "running" | "ok" | "error";
      result: string;
      parent: string | null;
    }
  | { kind: "notice"; id: string; tone: "info" | "error"; text: string };

export interface PendingRequest {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ChatState {
  items: ChatItem[];
  pending: PendingRequest[];
  busy: boolean;
  /** Turn started at, ms. Drives the elapsed counter next to the spinner. */
  busySince: number;
  historyLoaded: boolean;
  /** What the person picked ("" = Claude's default); `model` is what runs. */
  modelChoice: string;
  model: string;
  models: ModelOption[];
  permissionMode: PermissionMode;
  commands: SlashCommand[];
  context: { categories: ContextCategory[]; total: number; max: number } | null;
  /** Plan windows ("five_hour", "seven_day") → share used, 0–1. */
  limits: Record<string, { utilization: number; resetsAt: number }>;
  contextTokens: number;
  contextWindow: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  lastSeq: number;
}

interface Queued {
  text: string;
  images: OutgoingImage[];
  itemId: string;
}

const PREFS_KEY = "cosmos.chat.prefs";

function readPrefs(): { model: string; permissionMode: PermissionMode } {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return {
      model: typeof v.model === "string" ? v.model : "",
      permissionMode: ["default", "acceptEdits", "plan", "bypassPermissions"].includes(
        v.permissionMode,
      )
        ? v.permissionMode
        : "bypassPermissions",
    };
  } catch {
    return { model: "", permissionMode: "bypassPermissions" };
  }
}

function writePrefs(p: { model: string; permissionMode: PermissionMode }): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function blank(): ChatState {
  const prefs = readPrefs();
  return {
    items: [],
    pending: [],
    busy: false,
    busySince: 0,
    historyLoaded: false,
    modelChoice: prefs.model,
    model: "",
    models: [],
    permissionMode: prefs.permissionMode,
    commands: [],
    context: null,
    limits: {},
    contextTokens: 0,
    contextWindow: 200_000,
    outputTokens: 0,
    costUsd: 0,
    turns: 0,
    lastSeq: 0,
  };
}

const [chats, setChats] = createStore<Record<string, ChatState>>({});
const queues = new Map<string, Queued[]>();
/** message id of the assistant message currently streaming, per runner+parent */
const liveMessage = new Map<string, string>();
/** control_request ids we sent and still expect an answer for */
const awaiting = new Map<string, { runnerId: string; what: "init" | "context" }>();
/** A rename made in Cosmos that Claude's transcript doesn't reflect yet. */
const pendingTitle = new Map<string, string>();
/** Runners whose process Cosmos is stopping on purpose (mode switch, stop,
 *  restart). Their exit is not news. */
const expectedExit = new Set<string>();
onRunnerKill((id) => {
  const r = findRunner(id)?.runner;
  if (r?.live && r.mode === "chat") expectedExit.add(id);
});

function sessionCwd(runnerId: string): string {
  const found = findRunner(runnerId);
  return found ? cwdFor(found.project, found.runner) : "";
}

/* What the Board shows for sessions this window hasn't opened yet. */
const STATS_KEY = "cosmos.chat.stats";
export interface SessionStats {
  contextTokens: number;
  contextWindow: number;
  costUsd: number;
  turns: number;
  model: string;
}

function readStats(): Record<string, SessionStats> {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY) || "{}") ?? {};
  } catch {
    return {};
  }
}

const savedStats = readStats();

function saveStats(runnerId: string, s: ChatState): void {
  savedStats[runnerId] = {
    contextTokens: s.contextTokens,
    contextWindow: s.contextWindow,
    costUsd: s.costUsd,
    turns: s.turns,
    model: s.model,
  };
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(savedStats));
  } catch {
    /* ignore */
  }
}

export function statsOf(runnerId: string): SessionStats | null {
  const live = chats[runnerId];
  if (live && (live.contextTokens > 0 || live.turns > 0)) return live;
  return savedStats[runnerId] ?? null;
}
let localId = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${localId++}`;

export function chatOf(runnerId: string): ChatState {
  if (!chats[runnerId]) setChats(runnerId, blank());
  return chats[runnerId];
}

function mutate(runnerId: string, fn: (s: ChatState) => void): void {
  chatOf(runnerId);
  setChats(runnerId, produce(fn));
}

function contextOf(u: Usage | undefined): number {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0)
  );
}

/* -------------------------------- inbound -------------------------------- */

function rootsOf(runnerId: string): string[] {
  return findRunner(runnerId)?.project.folders ?? [];
}

function applyStream(runnerId: string, ev: StreamEvent, parent: string | null): void {
  const key = `${runnerId}:${parent ?? ""}`;
  if (ev.type === "message_start") {
    liveMessage.set(key, ev.message.id);
    const ctx = contextOf(ev.message.usage);
    if (!parent && ctx > 0) setChats(runnerId, "contextTokens", ctx);
    return;
  }
  const msgId = liveMessage.get(key);
  if (!msgId) return;
  if (ev.type === "content_block_start") {
    const b = ev.content_block;
    const id = `${msgId}:${ev.index}`;
    mutate(runnerId, (s) => {
      if (b.type === "text") s.items.push({ kind: "text", id, text: b.text ?? "", streaming: true, parent });
      else if (b.type === "thinking")
        s.items.push({ kind: "thinking", id, text: b.thinking ?? "", streaming: true, parent });
    });
    return;
  }
  if (ev.type === "content_block_delta") {
    const id = `${msgId}:${ev.index}`;
    const d = ev.delta;
    if (d.type === "input_json_delta") return;
    mutate(runnerId, (s) => {
      for (let i = s.items.length - 1; i >= 0; i--) {
        const it = s.items[i];
        if (it.id !== id) continue;
        if (it.kind === "text" && d.type === "text_delta") it.text += d.text;
        if (it.kind === "thinking" && d.type === "thinking_delta") it.text += d.thinking;
        break;
      }
    });
  }
}

function applyAssistant(
  runnerId: string,
  msg: Extract<Inbound, { type: "assistant" }>,
  live: boolean,
): void {
  const parent = msg.parent_tool_use_id ?? null;
  const msgId = msg.message.id;
  mutate(runnerId, (s) => {
    for (const block of msg.message.content) {
      if (block.type === "text" || block.type === "thinking") {
        const text = block.type === "text" ? block.text : block.thinking;
        if (!text?.trim()) continue;
        const open = s.items.find(
          (it) =>
            it.kind === block.type && it.streaming && it.id.startsWith(`${msgId}:`),
        );
        if (open && (open.kind === "text" || open.kind === "thinking")) {
          open.text = text;
          open.streaming = false;
        } else {
          s.items.push({
            kind: block.type,
            id: nextId(msgId),
            text,
            streaming: false,
            parent,
          });
        }
      } else if (block.type === "tool_use") {
        if (s.items.some((it) => it.id === block.id)) continue;
        s.items.push({
          kind: "tool",
          id: block.id,
          name: block.name,
          input: block.input ?? {},
          state: live ? "running" : "ok",
          result: "",
          parent,
        });
      }
    }
    if (!parent) {
      const ctx = contextOf(msg.message.usage);
      if (ctx > 0) s.contextTokens = ctx;
      if (msg.message.model && !msg.message.model.startsWith("<")) s.model = msg.message.model;
    }
  });
  if (live && !parent) {
    const tool = [...msg.message.content].reverse().find((b) => b.type === "tool_use") as
      | Extract<ContentBlock, { type: "tool_use" }>
      | undefined;
    patchRunner(runnerId, {
      activity: tool ? activityLine(tool.name, tool.input ?? {}, rootsOf(runnerId)) : "Escrevendo",
    });
  }
}

function applyToolResults(runnerId: string, content: string | ContentBlock[]): void {
  if (typeof content === "string") return;
  mutate(runnerId, (s) => {
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const tool = s.items.find((it) => it.id === block.tool_use_id);
      if (tool?.kind !== "tool") continue;
      tool.state = block.is_error ? "error" : "ok";
      tool.result = toolResultText(block);
    }
  });
}

function finishTurn(runnerId: string, msg: Extract<Inbound, { type: "result" }>): void {
  mutate(runnerId, (s) => {
    s.busy = false;
    s.pending = [];
    for (const it of s.items) {
      if ((it.kind === "text" || it.kind === "thinking") && it.streaming) it.streaming = false;
      if (it.kind === "tool" && it.state === "running") it.state = "error";
    }
    if (typeof msg.total_cost_usd === "number") s.costUsd = msg.total_cost_usd;
    if (typeof msg.num_turns === "number") s.turns = msg.num_turns;
    s.outputTokens += msg.usage?.output_tokens ?? 0;
    const window = Object.values(msg.modelUsage ?? {})
      .map((m) => m.contextWindow ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);
    if (window > 0) s.contextWindow = window;
    if (msg.local_command && msg.result?.trim()) {
      s.items.push({
        kind: "text",
        id: nextId("local"),
        text: msg.result,
        streaming: false,
        parent: null,
      });
    } else if (msg.subtype === "error_during_execution") {
      s.items.push({ kind: "notice", id: nextId("stop"), tone: "info", text: "Interrompido." });
    } else if (msg.is_error) {
      s.items.push({
        kind: "notice",
        id: nextId("err"),
        tone: "error",
        text: msg.result || `A sessão parou: ${msg.subtype}`,
      });
    }
  });
  patchRunner(runnerId, {
    activity: "",
    lastActive: Math.floor(Date.now() / 1000),
    ...(focusedRunner()?.id === runnerId && document.hasFocus() ? {} : { unread: true }),
  });
  runnersTouch(runnerId).catch(() => {});
  saveStats(runnerId, chats[runnerId]);
  void syncTitle(runnerId);
  flushQueue(runnerId);
}

function applyControlResponse(msg: Extract<Inbound, { type: "control_response" }>): void {
  const sent = awaiting.get(msg.response.request_id);
  if (!sent) return;
  awaiting.delete(msg.response.request_id);
  const body = msg.response.response;
  if (!body) return;
  if (sent.what === "init") {
    mutate(sent.runnerId, (s) => {
      if (Array.isArray(body.commands)) {
        s.commands = (body.commands as Record<string, unknown>[]).map((c) => ({
          name: String(c.name ?? ""),
          description: String(c.description ?? ""),
          argumentHint: String(c.argumentHint ?? ""),
        }));
      }
      if (Array.isArray(body.models)) {
        s.models = (body.models as Record<string, unknown>[]).map((m) => ({
          value: String(m.value ?? ""),
          displayName: String(m.displayName ?? m.value ?? ""),
          description: String(m.description ?? ""),
        }));
      }
    });
  } else {
    setChats(sent.runnerId, "context", {
      categories: Array.isArray(body.categories) ? (body.categories as ContextCategory[]) : [],
      total: Number(body.totalTokens ?? 0),
      max: Number(body.maxTokens ?? 0),
    });
  }
}

function ingest(runnerId: string, seq: number, line: string): void {
  const state = chatOf(runnerId);
  if (seq <= state.lastSeq) return;
  const msg = parseLine(line);
  batch(() => {
    setChats(runnerId, "lastSeq", seq);
    if (!msg) return;
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          const init = msg as Extract<Inbound, { subtype: "init" }>;
          mutate(runnerId, (s) => {
            s.model = init.model || s.model;
            if (s.commands.length === 0) {
              s.commands = (init.slash_commands ?? []).map((name) => ({
                name,
                description: "",
                argumentHint: "",
              }));
            }
          });
        } else if (msg.subtype === "status" && typeof msg.permissionMode === "string") {
          setChats(runnerId, "permissionMode", msg.permissionMode as PermissionMode);
        } else if (msg.subtype === "compact_boundary") {
          mutate(runnerId, (s) => {
            s.items.push({
              kind: "notice",
              id: nextId("compact"),
              tone: "info",
              text: "Contexto compactado. O que veio antes foi resumido.",
            });
          });
        }
        break;
      case "stream_event":
        applyStream(runnerId, msg.event, msg.parent_tool_use_id ?? null);
        break;
      case "assistant":
        applyAssistant(runnerId, msg, true);
        break;
      case "user":
        applyToolResults(runnerId, msg.message.content);
        break;
      case "result":
        finishTurn(runnerId, msg);
        break;
      case "control_request":
        if (msg.request.subtype === "can_use_tool") {
          mutate(runnerId, (s) => {
            s.pending.push({
              requestId: msg.request_id,
              toolName: msg.request.tool_name ?? "",
              toolUseId: msg.request.tool_use_id ?? "",
              input: msg.request.input ?? {},
            });
          });
          if (focusedRunner()?.id !== runnerId || !document.hasFocus())
            patchRunner(runnerId, { unread: true });
        }
        break;
      case "control_cancel_request":
        mutate(runnerId, (s) => {
          s.pending = s.pending.filter((p) => p.requestId !== msg.request_id);
        });
        break;
      case "control_response":
        applyControlResponse(msg);
        break;
      case "rate_limit_event":
        setChats(runnerId, "limits", { ...(msg.rate_limit_info.unifiedWindows ?? {}) });
        break;
    }
  });
}

/* ------------------------------- lifecycle ------------------------------- */

let attached = false;

/** Subscribe once, then catch up on whatever live agents already said. */
export async function attachChatListeners(liveIds: string[]): Promise<void> {
  if (attached) return;
  attached = true;
  await listen<AgentLine>("agent-line", (e) =>
    ingest(e.payload.runnerId, e.payload.seq, e.payload.line),
  );
  await listen<{ runnerId: string; code: number | null; stderr: string }>("agent-exit", (e) => {
    const { runnerId, code, stderr } = e.payload;
    const expected = expectedExit.delete(runnerId);
    const wasBusy = chats[runnerId]?.busy;
    mutate(runnerId, (s) => {
      s.busy = false;
      s.pending = [];
      s.lastSeq = 0;
      for (const it of s.items) {
        if ((it.kind === "text" || it.kind === "thinking") && it.streaming) it.streaming = false;
        if (it.kind === "tool" && it.state === "running") it.state = "error";
      }
      if (!expected && (wasBusy || (code !== null && code !== 0))) {
        s.items.push({
          kind: "notice",
          id: nextId("exit"),
          tone: "error",
          text: stderr.trim()
            ? `O Claude encerrou (código ${code ?? "?"}).\n${stderr.trim().split("\n").slice(-6).join("\n")}`
            : `O Claude encerrou (código ${code ?? "?"}). Envie uma mensagem para retomar.`,
        });
      }
    });
    markRunnerLive(runnerId, false);
    patchRunner(runnerId, { activity: "" });
    void syncTitle(runnerId);
  });
  // Terminal sessions get titled by Claude too; a finished turn is when a
  // new title can have landed in the transcript.
  await listen<{ runnerId: string; status: string }>("runner-status", (e) => {
    if (e.payload.status !== "idle" && e.payload.status !== "exited") return;
    const id = e.payload.runnerId;
    if (findRunner(id)?.runner.mode === "tty") setTimeout(() => void syncTitle(id), 1500);
  });
  // `cosmos runner add --task` and `cosmos runner send`: the app owns the
  // protocol, so the CLI hands the text over instead of writing to stdin.
  await listen<{ runnerId: string; text: string }>("agent-task", async (e) => {
    const { runnerId, text } = e.payload;
    if (!findRunner(runnerId)) await loadProjects().catch(console.error);
    if (!findRunner(runnerId)) return;
    await openChat(runnerId);
    send(runnerId, text);
  });
  for (const id of liveIds) {
    const found = findRunner(id);
    if (found?.runner.kind !== "agent" || found.runner.mode !== "chat") continue;
    await openChat(id);
  }
}

/** Makes a session's conversation available: transcript from disk first,
 *  then whatever a still-running process has said since. Idempotent. */
export async function openChat(runnerId: string): Promise<void> {
  const state = chatOf(runnerId);
  if (!state.historyLoaded) {
    setChats(runnerId, "historyLoaded", true);
    try {
      loadHistory(runnerId, await agentHistory(runnerId, sessionCwd(runnerId)));
      void syncTitle(runnerId);
    } catch (e) {
      console.error("[chat] history failed", e);
    }
  }
  try {
    const lines = await agentSnapshot(runnerId, chats[runnerId].lastSeq);
    for (const l of lines) ingest(runnerId, l.seq, l.line);
  } catch {
    /* not running — nothing to catch up on */
  }
}

/** Transcript lines use the same message shapes as the live stream, wrapped
 *  in bookkeeping the chat doesn't need. */
function loadHistory(runnerId: string, lines: string[]): void {
  const seen = new Set<string>();
  batch(() => {
    for (const line of lines) {
      const v = parseLine(line) as (Inbound & Record<string, unknown>) | null;
      if (!v || v.isSidechain || v.isMeta) continue;
      const parent = (v as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
      if (v.type === "assistant") {
        applyAssistant(runnerId, { ...v, parent_tool_use_id: parent } as never, false);
      } else if (v.type === "user") {
        const content = (v as Extract<Inbound, { type: "user" }>).message?.content;
        if (typeof content !== "string" && content?.some((b) => b.type === "tool_result")) {
          applyToolResults(runnerId, content);
          continue;
        }
        const text =
          typeof content === "string"
            ? content
            : (content ?? [])
                .map((b) => (b.type === "text" ? b.text : ""))
                .join("\n");
        const clean = text.trim();
        // Slash-command plumbing and injected reminders are written as user
        // turns; they were never typed by anyone.
        if (
          !clean ||
          clean.startsWith("<") ||
          clean.startsWith("Caveat:") ||
          clean.startsWith("[Request interrupted")
        )
          continue;
        const uuid = String((v as { uuid?: string }).uuid ?? nextId("u"));
        if (seen.has(uuid)) continue;
        seen.add(uuid);
        const images =
          typeof content === "string"
            ? []
            : content
                .filter((b): b is Extract<ContentBlock, { type: "image" }> => b.type === "image")
                .map((b) => `data:${b.source.media_type};base64,${b.source.data}`);
        mutate(runnerId, (s) => {
          s.items.push({ kind: "user", id: uuid, text: clean, images, queued: false });
        });
      }
    }
  });
}

/* -------------------------------- outbound ------------------------------- */

async function ensureProcess(runnerId: string): Promise<void> {
  const found = findRunner(runnerId);
  if (found?.runner.live) return;
  if (!found) throw new Error("sessão não encontrada");
  const s = chatOf(runnerId);
  await agentStart(runnerId, sessionCwd(runnerId), s.modelChoice || null, s.permissionMode);
  markRunnerLive(runnerId, true);
  const init = initialize();
  awaiting.set(init.requestId, { runnerId, what: "init" });
  await agentSend(runnerId, init.line);
}

async function deliver(runnerId: string, q: Queued): Promise<void> {
  const found = findRunner(runnerId);
  mutate(runnerId, (s) => {
    const it = s.items.find((x) => x.id === q.itemId);
    if (it?.kind === "user") it.queued = false;
    s.busy = true;
    s.busySince = Date.now();
  });
  patchRunner(runnerId, { activity: "Pensando", unread: false });
  try {
    await ensureProcess(runnerId);
    await agentSend(runnerId, userMessage(q.text, q.images, found?.runner.sessionId ?? ""));
  } catch (e) {
    mutate(runnerId, (s) => {
      s.busy = false;
      s.items.push({
        kind: "notice",
        id: nextId("send"),
        tone: "error",
        text: `Não consegui enviar: ${String(e)}`,
      });
    });
  }
}

function flushQueue(runnerId: string): void {
  const next = queues.get(runnerId)?.shift();
  if (next) void deliver(runnerId, next);
}

export function send(runnerId: string, text: string, images: OutgoingImage[] = []): void {
  const clean = text.trim();
  if (!clean && images.length === 0) return;
  const state = chatOf(runnerId);
  const itemId = nextId("u");
  const waiting = state.busy;
  const isFirst = !state.items.some((it) => it.kind === "user");
  mutate(runnerId, (s) => {
    s.items.push({
      kind: "user",
      id: itemId,
      text: clean,
      images: images.map((i) => `data:${i.mediaType};base64,${i.base64}`),
      queued: waiting,
    });
  });
  const q: Queued = { text: clean, images, itemId };
  if (waiting) {
    queues.set(runnerId, [...(queues.get(runnerId) ?? []), q]);
  } else {
    void deliver(runnerId, q);
  }
  // Claude writes its title while the first turn is still running.
  if (isFirst) for (const ms of [8000, 20000]) setTimeout(() => void syncTitle(runnerId), ms);
}

export function unqueue(runnerId: string, itemId: string): void {
  queues.set(
    runnerId,
    (queues.get(runnerId) ?? []).filter((q) => q.itemId !== itemId),
  );
  mutate(runnerId, (s) => {
    s.items = s.items.filter((it) => it.id !== itemId);
  });
}

/* --------------------------------- titles -------------------------------- */

/** Pulls the session's title out of Claude's transcript. A title a person
 *  set on either side wins; Claude's own title only fills in while the
 *  session still carries a placeholder name. */
export async function syncTitle(runnerId: string): Promise<void> {
  const found = findRunner(runnerId);
  if (!found || found.runner.kind !== "agent" || !found.runner.sessionId) return;
  try {
    const wanted = pendingTitle.get(runnerId);
    if (wanted && !found.runner.live) {
      if (await sessionTitleSet(runnerId, sessionCwd(runnerId), wanted)) pendingTitle.delete(runnerId);
      return;
    }
    const title = await sessionTitleGet(runnerId, sessionCwd(runnerId));
    const cur = findRunner(runnerId)?.runner;
    if (!cur) return;
    if (wanted) {
      if (title.custom === wanted) pendingTitle.delete(runnerId);
      return;
    }
    if (title.custom && title.custom !== cur.name) await renameRunner(runnerId, title.custom, false);
    else if (!title.custom && cur.nameAuto && title.ai && title.ai !== cur.name)
      await renameRunner(runnerId, title.ai, true);
  } catch (e) {
    console.warn("[chat] title sync failed", e);
  }
}

/** Renames the session in Cosmos and in Claude, whichever way reaches it. */
export async function renameSession(runnerId: string, name: string): Promise<void> {
  const title = name.trim();
  const found = findRunner(runnerId);
  if (!title || !found) return;
  await renameRunner(runnerId, title, false);
  const { runner } = found;
  if (runner.kind !== "agent" || !runner.sessionId) return;
  pendingTitle.set(runnerId, title);
  try {
    if (!runner.live) {
      if (await sessionTitleSet(runnerId, sessionCwd(runnerId), title)) pendingTitle.delete(runnerId);
    } else if (runner.mode === "chat") {
      await agentSend(runnerId, renameSessionLine(title).line);
      pendingTitle.delete(runnerId);
    } else if (runner.status === "idle") {
      await ptyWrite(runnerId, `/rename ${title.replace(/[\r\n]+/g, " ")}\r`);
      pendingTitle.delete(runnerId);
    }
    // A busy terminal keeps the rename pending; it lands once the process
    // stops, and the next spawn passes it as `--name` anyway.
  } catch (e) {
    console.warn("[chat] rename sync failed", e);
  }
}

export function refreshContext(runnerId: string): void {
  if (!findRunner(runnerId)?.runner.live) return;
  const req = contextUsage();
  awaiting.set(req.requestId, { runnerId, what: "context" });
  agentSend(runnerId, req.line).catch(console.error);
}

export function stop(runnerId: string): void {
  queues.set(runnerId, []);
  mutate(runnerId, (s) => {
    s.items = s.items.filter((it) => !(it.kind === "user" && it.queued));
  });
  agentSend(runnerId, interrupt().line).catch(console.error);
}

export function answer(
  runnerId: string,
  requestId: string,
  decision: { allow: true; input: Record<string, unknown> } | { allow: false; message: string },
): void {
  const line = decision.allow
    ? allowTool(requestId, decision.input)
    : denyTool(requestId, decision.message);
  agentSend(runnerId, line).catch(console.error);
  mutate(runnerId, (s) => {
    s.pending = s.pending.filter((p) => p.requestId !== requestId);
  });
}

export function setPermissionMode(runnerId: string, mode: PermissionMode): void {
  chatOf(runnerId);
  setChats(runnerId, "permissionMode", mode);
  writePrefs({ model: readPrefs().model, permissionMode: mode });
  if (findRunner(runnerId)?.runner.live)
    agentSend(runnerId, setPermissionModeLine(mode).line).catch(console.error);
}

export function setModel(runnerId: string, model: string): void {
  chatOf(runnerId);
  setChats(runnerId, "modelChoice", model);
  writePrefs({ model, permissionMode: readPrefs().permissionMode });
  if (findRunner(runnerId)?.runner.live)
    agentSend(runnerId, setModelLine(model || "default").line).catch(console.error);
}

onRunnerReset((id) => dropChat(id));

/** Forget everything about a runner's conversation (thread reset, delete). */
export function dropChat(runnerId: string): void {
  queues.delete(runnerId);
  setChats(runnerId, reconcile(blank()));
}

export async function killChat(runnerId: string): Promise<void> {
  queues.delete(runnerId);
  await agentKill(runnerId).catch(() => {});
}
