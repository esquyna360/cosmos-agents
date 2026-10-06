/**
 * The desktop frontend, running in a plain browser.
 *
 * Every view talks to the backend through Tauri's `invoke`, `listen` and
 * `Channel`. Here those three are given another transport: commands go out as
 * HTTP to the Cosmos web server, which hands them to the same handlers the
 * window uses; events come in over one WebSocket; a terminal's bytes ride a
 * socket of their own. Nothing above this file knows the difference.
 */

type Callback = (value: unknown) => void;

interface PtyLink {
  socket: WebSocket;
  ready: Promise<void>;
}

const callbacks = new Map<number, Callback>();
const listeners = new Map<number, { event: string; handler: number }>();
const terminals = new Map<string, PtyLink>();
let nextId = 1;
let events: WebSocket | null = null;
let retry = 0;
let ended = false;

function wsUrl(path: string): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}

function dispatch(event: string, payload: unknown): void {
  for (const [id, l] of listeners) {
    if (l.event === event) callbacks.get(l.handler)?.({ event, payload, id });
  }
}

/** The session is gone (revoked, expired): back to the pairing screen. */
function sessionEnded(): void {
  if (ended) return;
  ended = true;
  location.reload();
}

function connectEvents(): void {
  const socket = new WebSocket(wsUrl("/ws/events"));
  events = socket;
  let opened = false;
  socket.onopen = () => {
    opened = true;
    // Whatever happened while the line was down is read again.
    if (retry > 0) resync();
    retry = 0;
  };
  socket.onmessage = (m) => {
    try {
      const { event, payload } = JSON.parse(String(m.data));
      if (event === "cosmos:revoked") sessionEnded();
      else if (event === "cosmos:resync") resync();
      else dispatch(event, payload);
    } catch {
      /* not ours */
    }
  };
  socket.onclose = () => {
    if (ended) return;
    events = null;
    retry++;
    const wait = Math.min(8000, 400 * 2 ** Math.min(retry, 5));
    window.setTimeout(async () => {
      // A socket that never opened may mean the session ended meanwhile.
      if (!opened && !(await sessionAlive())) return sessionEnded();
      connectEvents();
    }, wait);
  };
}

function resync(): void {
  dispatch("projects-changed", { reason: "web.resync" });
  dispatch("runners-changed", { reason: "web.resync" });
  dispatch("brain-changed", null);
}

async function sessionAlive(): Promise<boolean> {
  try {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    return res.ok ? Boolean((await res.json()).paired) : true;
  } catch {
    // Offline is not the same as signed out.
    return true;
  }
}

function attachTerminal(id: string, output: { onmessage?: Callback }): Promise<void> {
  terminals.get(id)?.socket.close();
  const socket = new WebSocket(wsUrl(`/ws/pty/${encodeURIComponent(id)}`));
  socket.binaryType = "arraybuffer";
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    socket.onmessage = (m) => {
      if (typeof m.data === "string") {
        try {
          const msg = JSON.parse(m.data);
          if (msg.t === "meta" && !settled) {
            settled = true;
            resolve();
          } else if (msg.t === "dead" && !settled) {
            settled = true;
            reject(`no runner \`${id}\``);
          }
        } catch {
          /* ignore */
        }
        return;
      }
      output.onmessage?.(new Uint8Array(m.data as ArrayBuffer));
    };
    socket.onerror = () => {
      if (!settled) {
        settled = true;
        reject("terminal socket failed");
      }
    };
    socket.onclose = () => {
      if (terminals.get(id)?.socket === socket) terminals.delete(id);
      if (!settled) {
        settled = true;
        reject(`no runner \`${id}\``);
      }
    };
  });
  terminals.set(id, { socket, ready });
  return ready;
}

function toTerminal(id: string, message: string | Uint8Array): boolean {
  const link = terminals.get(id);
  if (!link || link.socket.readyState !== WebSocket.OPEN) return false;
  link.socket.send(message);
  return true;
}

const encoder = new TextEncoder();

/** Commands answered here, without a trip to the server. */
function local(cmd: string, args: Record<string, unknown>): { value: unknown } | null {
  switch (cmd) {
    case "plugin:event|listen": {
      const id = nextId++;
      listeners.set(id, { event: String(args.event), handler: Number(args.handler) });
      return { value: id };
    }
    case "plugin:event|unlisten":
      listeners.delete(Number(args.eventId));
      return { value: null };
    case "plugin:event|emit":
    case "plugin:event|emit_to":
      dispatch(String(args.event), args.payload);
      return { value: null };
    case "pty_attach":
      return { value: attachTerminal(String(args.id), args.output as { onmessage?: Callback }) };
    case "pty_detach":
      terminals.get(String(args.id))?.socket.close();
      terminals.delete(String(args.id));
      return { value: null };
    case "pty_write":
      // Keystrokes share the terminal's socket so they arrive in order.
      return toTerminal(String(args.id), encoder.encode(String(args.data))) ? { value: null } : null;
    case "pty_resize":
      return toTerminal(String(args.id), JSON.stringify({ t: "r", c: args.cols, r: args.rows })) ? { value: null } : null;
    case "open_external":
      window.open(String(args.url), "_blank", "noopener,noreferrer");
      return { value: null };
    case "open_path":
    case "debug_log":
      return { value: null };
    case "plugin:notification|is_permission_granted":
      return { value: false };
    case "plugin:notification|request_permission":
      return { value: "denied" };
    case "plugin:dialog|open": {
      const typed = window.prompt("Caminho da pasta no computador onde o Cosmos está rodando", "~/code/");
      return { value: typed?.trim() || null };
    }
    default:
      // Updater, process, window chrome: the desk's business.
      return cmd.startsWith("plugin:") || cmd.startsWith("web_") ? { value: null } : null;
  }
}

async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const here = local(cmd, args);
  if (here) return here.value;
  const res = await fetch(`/api/invoke/${encodeURIComponent(cmd)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-cosmos": "1" },
    body: JSON.stringify(args),
  });
  if (res.status === 401) {
    sessionEnded();
    throw "sessão encerrada";
  }
  const kind = res.headers.get("content-type") ?? "";
  if (kind.includes("octet-stream")) {
    if (!res.ok) throw res.statusText;
    return new Uint8Array(await res.arrayBuffer());
  }
  const text = await res.text();
  let value: unknown = text;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    /* plain text error */
  }
  if (!res.ok) throw value ?? res.statusText;
  return value;
}

export async function signOut(): Promise<void> {
  ended = true;
  await fetch("/api/logout", { method: "POST", credentials: "same-origin", headers: { "x-cosmos": "1" } }).catch(() => {});
  location.reload();
}

export function installWebBridge(): void {
  const w = window as unknown as Record<string, unknown>;
  w.__COSMOS_WEB__ = true;
  document.documentElement.dataset.web = "true";
  w.__TAURI_INTERNALS__ = {
    transformCallback(cb: Callback, once = false) {
      const id = nextId++;
      callbacks.set(id, (value) => {
        if (once) callbacks.delete(id);
        cb(value);
      });
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    invoke,
    convertFileSrc: (path: string) => path,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    plugins: {},
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(_event: string, id: number) {
      listeners.delete(id);
    },
  };
  connectEvents();
  // A phone that slept comes back with dead sockets and stale lists.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && events?.readyState === WebSocket.OPEN) resync();
  });
}
