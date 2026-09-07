/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./styles.css";

// Design iteration happens in a browser tab; the desktop build never sees this.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  const { installDevMock } = await import("./lib/devMock");
  installDevMock();
}

render(() => <App />, document.getElementById("root") as HTMLElement);
