/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { isWeb } from "./lib/platform";
import "./styles.css";

const root = document.getElementById("root") as HTMLElement;

async function boot() {
  let paired = true;
  let version: string | undefined;

  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    // Design iteration happens in a browser tab; the desktop build never sees this.
    const { installDevMock } = await import("./lib/devMock");
    installDevMock();
    if (new URLSearchParams(location.search).has("pair")) paired = false;
  } else if (isWeb) {
    const session = await fetch("/api/session", { credentials: "same-origin" })
      .then((r) => r.json())
      .catch(() => ({ paired: false }));
    paired = Boolean(session.paired);
    version = session.version;
    if (paired) {
      const { installWebBridge } = await import("./web/bridge");
      installWebBridge();
    }
  }

  if (paired) {
    render(() => <App />, root);
    return;
  }
  const [{ default: Pair }, { initTheme }] = await Promise.all([import("./web/Pair"), import("./stores/theme")]);
  initTheme();
  render(() => <Pair version={version} />, root);
}

void boot();
