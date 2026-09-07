import { createSignal } from "solid-js";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { appVersion } from "../lib/remote";
import { projectsStore } from "./projects";

/**
 * Update supervision.
 *
 * Cosmos checks for itself: once shortly after launch and then on a timer, on
 * every platform the updater plugin covers (macOS arm64/x86_64 and Windows all
 * read the same signed `latest.json`).
 *
 * Installing is the part that needs a guard. Applying an update relaunches the
 * app, and a relaunch kills every PTY — which means every running agent. So
 * `autoInstall` only fires when nothing is live; with agents working, the
 * update is downloaded-ready and waits behind a banner for the user to pick
 * the moment. That's the whole reason the two settings are separate.
 */

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

const CHECK_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8_000;

const KEY_AUTO_CHECK = "cosmos.update.autoCheck.v1";
const KEY_AUTO_INSTALL = "cosmos.update.autoInstall.v1";
const KEY_SKIPPED = "cosmos.update.skipped.v1";

function readBool(key: string, fallback: boolean): boolean {
  const v = localStorage.getItem(key);
  return v === "1" ? true : v === "0" ? false : fallback;
}
function writeBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const [phase, setPhase] = createSignal<UpdatePhase>("idle");
const [available, setAvailable] = createSignal<Update | null>(null);
const [progress, setProgress] = createSignal(0);
const [total, setTotal] = createSignal(0);
const [error, setError] = createSignal<string | null>(null);
const [lastChecked, setLastChecked] = createSignal<number | null>(null);
const [currentVersion, setCurrentVersion] = createSignal("");
const [autoCheck, setAutoCheckRaw] = createSignal(readBool(KEY_AUTO_CHECK, true));
const [autoInstall, setAutoInstallRaw] = createSignal(
  readBool(KEY_AUTO_INSTALL, false),
);
const [dismissed, setDismissed] = createSignal(false);

export {
  phase,
  available,
  progress,
  total,
  error,
  lastChecked,
  currentVersion,
  autoCheck,
  autoInstall,
  dismissed,
  setDismissed,
};

export function setAutoCheck(v: boolean): void {
  setAutoCheckRaw(v);
  writeBool(KEY_AUTO_CHECK, v);
}

export function setAutoInstall(v: boolean): void {
  setAutoInstallRaw(v);
  writeBool(KEY_AUTO_INSTALL, v);
}

function liveRunnerCount(): number {
  return projectsStore.list.reduce(
    (n, p) => n + p.runners.filter((r) => r.live).length,
    0,
  );
}

function skipped(): string | null {
  try {
    return localStorage.getItem(KEY_SKIPPED);
  } catch {
    return null;
  }
}

/** Hides this exact version until a newer one ships. */
export function skipVersion(): void {
  const v = available()?.version;
  if (!v) return;
  try {
    localStorage.setItem(KEY_SKIPPED, v);
  } catch {
    /* ignore */
  }
  setDismissed(true);
}

export async function checkNow(manual = false): Promise<void> {
  if (phase() === "checking" || phase() === "downloading" || phase() === "installing") {
    return;
  }
  setPhase("checking");
  setError(null);
  try {
    const u = await check();
    setLastChecked(Date.now());
    if (!u) {
      setAvailable(null);
      setPhase("idle");
      return;
    }
    setAvailable(u);
    // A manual check overrides a previous "skip this version".
    if (!manual && skipped() === u.version) {
      setPhase("idle");
      return;
    }
    setDismissed(false);
    setPhase("available");
    if (autoInstall() && liveRunnerCount() === 0) {
      await install();
    }
  } catch (e) {
    setLastChecked(Date.now());
    // Offline, no release yet, signature mismatch — none of it is worth
    // interrupting the user over unless they asked for the check.
    if (manual) {
      setError(String(e));
      setPhase("error");
    } else {
      setPhase("idle");
    }
  }
}

/** Downloads, installs and relaunches. The relaunch ends every live runner. */
export async function install(): Promise<void> {
  const u = available();
  if (!u) return;
  setPhase("downloading");
  setError(null);
  setProgress(0);
  setTotal(0);
  try {
    await u.downloadAndInstall((evt) => {
      if (evt.event === "Started") setTotal(evt.data.contentLength ?? 0);
      else if (evt.event === "Progress") setProgress((p) => p + evt.data.chunkLength);
    });
    setPhase("installing");
    await relaunch();
  } catch (e) {
    setError(String(e));
    setPhase("error");
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startUpdateWatch(): void {
  appVersion().then(setCurrentVersion).catch(() => {});
  const tick = () => {
    if (autoCheck()) checkNow().catch(() => {});
  };
  setTimeout(tick, FIRST_CHECK_DELAY_MS);
  if (timer) clearInterval(timer);
  timer = setInterval(tick, CHECK_MS);
}
