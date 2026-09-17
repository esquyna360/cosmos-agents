/**
 * Claude Code's stream-json wire format, as far as the chat needs it.
 *
 * One JSON object per line in both directions. The Rust side is a dumb pipe
 * (`agent_proc.rs`); everything that knows what a line means is here.
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: string | { type: string; text?: string }[];
      is_error?: boolean;
    }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type Inbound =
  | {
      type: "system";
      subtype: "init";
      session_id: string;
      model: string;
      permissionMode: string;
      slash_commands?: string[];
      tools?: string[];
      cwd?: string;
    }
  | { type: "system"; subtype: string; [k: string]: unknown }
  | {
      type: "assistant";
      message: { id: string; model?: string; content: ContentBlock[]; usage?: Usage };
      parent_tool_use_id: string | null;
    }
  | {
      type: "user";
      message: { content: string | ContentBlock[] };
      parent_tool_use_id: string | null;
      isReplay?: boolean;
    }
  | {
      type: "stream_event";
      event: StreamEvent;
      parent_tool_use_id: string | null;
    }
  | {
      type: "result";
      subtype: string;
      is_error: boolean;
      result?: string;
      total_cost_usd?: number;
      num_turns?: number;
      duration_ms?: number;
      usage?: Usage;
      modelUsage?: Record<string, { contextWindow?: number }>;
      /** Set when a slash command answered locally; `result` holds its output. */
      local_command?: string;
    }
  | {
      type: "control_request";
      request_id: string;
      request: {
        subtype: string;
        tool_name?: string;
        input?: Record<string, unknown>;
        tool_use_id?: string;
        permission_suggestions?: unknown[];
      };
    }
  | { type: "control_cancel_request"; request_id: string }
  | {
      type: "rate_limit_event";
      rate_limit_info: {
        unifiedWindows?: Record<string, { utilization: number; resetsAt: number }>;
      };
    }
  | {
      type: "control_response";
      response: {
        subtype: string;
        request_id: string;
        error?: string;
        response?: Record<string, unknown>;
      };
    };

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface ModelOption {
  value: string;
  displayName: string;
  description: string;
}

export interface ContextCategory {
  name: string;
  tokens: number;
  kind: "used" | "free" | "deferred" | string;
}

export type StreamEvent =
  | { type: "message_start"; message: { id: string; usage?: Usage } }
  | { type: "content_block_start"; index: number; content_block: ContentBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta" | "message_stop" };

export function parseLine(line: string): Inbound | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" && typeof v.type === "string" ? (v as Inbound) : null;
  } catch {
    return null;
  }
}

let counter = 0;
const requestId = () => `cosmos-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export interface Outgoing {
  requestId: string;
  line: string;
}

export interface OutgoingImage {
  mediaType: string;
  base64: string;
}

export function userMessage(text: string, images: OutgoingImage[], sessionId: string): string {
  const content: unknown[] = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.base64 },
  }));
  if (text) content.push({ type: "text", text });
  return JSON.stringify({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
  });
}

export function allowTool(reqId: string, updatedInput: Record<string, unknown>): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: reqId,
      response: { behavior: "allow", updatedInput },
    },
  });
}

export function denyTool(reqId: string, message: string): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: reqId,
      response: { behavior: "deny", message },
    },
  });
}

function control(request: Record<string, unknown>): Outgoing {
  const id = requestId();
  return {
    requestId: id,
    line: JSON.stringify({ type: "control_request", request_id: id, request }),
  };
}

export const interrupt = () => control({ subtype: "interrupt", cancel_queued: true });
export const setPermissionMode = (mode: string) => control({ subtype: "set_permission_mode", mode });
export const setModel = (model: string) => control({ subtype: "set_model", model });
export const renameSession = (title: string) =>
  control({ subtype: "rename_session", title, source: "host" });
export const initialize = () => control({ subtype: "initialize" });
export const contextUsage = () => control({ subtype: "get_context_usage", detail: "summary" });

export function toolResultText(block: Extract<ContentBlock, { type: "tool_result" }>): string {
  const c = block.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
    .join("\n");
}
