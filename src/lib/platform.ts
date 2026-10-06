/** True when this is the web app in a browser, not the desktop window.
 *  Read once, before anything stands in for the desktop's internals. */
export const isWeb =
  !("__TAURI_INTERNALS__" in window) &&
  (!import.meta.env.DEV || new URLSearchParams(location.search).has("web"));

if (isWeb) document.documentElement.dataset.web = "true";
