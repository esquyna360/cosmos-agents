// Shared bits between the dashboard and the terminal page. No build step —
// the Rust binary serves these files verbatim.

export async function fetchState() {
  const res = await fetch("/api/state", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res.json();
}

export function post(path, body) {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

const COLORS = {
  idle: "#8b93a1",
  streaming: "#6ec1ff",
  tool_running: "#6ec1ff",
  awaiting_input: "#f59e0b",
  error: "#ef4444",
  running: "#4ade80",
  exited: "#4b5563",
};

// Same shape language as the desktop sidebar: a ring rests, an arc works, a
// triangle is asking for you, a cross failed. Shape carries the meaning so it
// survives a glance at arm's length.
export function statusDot(status, live) {
  const s = live ? status || "idle" : "exited";
  const c = COLORS[s] || COLORS.idle;
  const op = live ? 1 : 0.35;
  const head = `<svg width="12" height="12" viewBox="0 0 11 11" style="opacity:${op};flex:0 0 auto">`;
  if (s === "awaiting_input") {
    return `${head}<polygon points="5.5,1 10,10 1,10" fill="${c}"/></svg>`;
  }
  if (s === "error") {
    return `${head}<path d="M2 2 L9 9 M9 2 L2 9" stroke="${c}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  }
  if (s === "streaming" || s === "tool_running") {
    return `${head}<circle cx="5.5" cy="5.5" r="4.3" fill="none" stroke="${c}" stroke-width="1.4" opacity="0.18"/><circle cx="5.5" cy="5.5" r="4.3" fill="none" stroke="${c}" stroke-width="1.6" stroke-linecap="round" pathLength="100" stroke-dasharray="65 100"><animateTransform attributeName="transform" type="rotate" from="0 5.5 5.5" to="360 5.5 5.5" dur="1.1s" repeatCount="indefinite"/></circle></svg>`;
  }
  if (s === "running") {
    return `${head}<circle cx="5.5" cy="5.5" r="3.6" fill="${c}"/></svg>`;
  }
  return `${head}<circle cx="5.5" cy="5.5" r="4.3" fill="none" stroke="${c}" stroke-width="1.4" opacity="0.7"/></svg>`;
}

export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}
