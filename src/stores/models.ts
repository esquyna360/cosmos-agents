import { createSignal } from "solid-js";

import { modelsList, type Provider, type Tier } from "../lib/hub";

/** What the person picked: a concrete model, or let the router choose. */
export interface ModelChoice {
  provider: string;
  model: string;
}

export const AUTO: ModelChoice = { provider: "", model: "" };

export const TIER_HINT: Record<Tier, string> = {
  deep: "arquitetura e decisão",
  work: "execução",
  cheap: "tarefa barata",
};

const FALLBACK: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    base_url: "",
    key_file: "",
    available: true,
    models: [
      { id: "opus", label: "Opus", tier: "deep" },
      { id: "sonnet", label: "Sonnet", tier: "work" },
      { id: "haiku", label: "Haiku", tier: "cheap" },
    ],
  },
];

const [providers, setProviders] = createSignal<Provider[]>(FALLBACK);
let asked = false;

export function ensureModels(): void {
  if (asked) return;
  asked = true;
  modelsList()
    .then((list) => Array.isArray(list) && list.length > 0 && setProviders(list))
    .catch(() => {
      asked = false;
    });
}

export const providersList = providers;

/** "Sonnet", "DeepSeek Flash", or "" when the runner is on the CLI default. */
export function modelLabel(r: { provider: string; model: string }): string {
  if (!r.model) return "";
  const p = providers().find((p) => p.id === (r.provider || "anthropic"));
  return p?.models.find((m) => m.id === r.model)?.label ?? r.model;
}

export function tierOf(r: { provider: string; model: string }): Tier | null {
  const p = providers().find((p) => p.id === (r.provider || "anthropic"));
  return p?.models.find((m) => m.id === r.model)?.tier ?? null;
}
