import { createSignal } from "solid-js";

import { clisDetect, type CliInfo } from "../lib/clis";

const [clis, setClis] = createSignal<CliInfo[]>([]);
const [loaded, setLoaded] = createSignal(false);
const [loading, setLoading] = createSignal(false);

export const clisList = clis;
export const clisLoaded = loaded;
export const clisLoading = loading;

/// Detect installed CLIs. Cached — subsequent calls return immediately unless
/// `force=true` is passed. The probe is cheap (~50ms zsh subprocess) but the
/// result rarely changes during a session.
export async function ensureClisDetected(force = false): Promise<CliInfo[]> {
  if (loaded() && !force) return clis();
  if (loading()) {
    // Multiple callers racing — wait for the in-flight detection.
    while (loading()) {
      await new Promise((r) => setTimeout(r, 30));
    }
    return clis();
  }
  setLoading(true);
  try {
    const list = await clisDetect();
    setClis(list);
    setLoaded(true);
    return list;
  } finally {
    setLoading(false);
  }
}

/// Synchronous accessor for the cached list. Returns [] if detection hasn't
/// run yet. Callers should call `ensureClisDetected()` first when they need
/// up-to-date data.
export function clisAvailable(): CliInfo[] {
  return clis().filter((c) => c.available);
}
