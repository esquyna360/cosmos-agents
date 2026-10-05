import { onMount, Show } from "solid-js";
import { ChevronDown, Sparkles } from "lucide-solid";

import { AUTO, ensureModels, modelLabel, providersList, TIER_HINT, type ModelChoice } from "../stores/models";
import { openMenu, type MenuItem } from "./Menu";

interface Props {
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  /** What the router would pick for the task being typed, shown under Auto. */
  auto?: string;
  compact?: boolean;
}

/** One pill that opens every model the agent can run on. */
export default function ModelPicker(props: Props) {
  onMount(ensureModels);
  const isAuto = () => !props.value.model;

  function items(): MenuItem[] {
    const out: MenuItem[] = [
      {
        label: "Automático",
        hint: props.auto || "pela tarefa",
        icon: Sparkles,
        checked: isAuto(),
        onSelect: () => props.onChange(AUTO),
      },
    ];
    for (const p of providersList()) {
      p.models.forEach((m, i) => {
        const provider = p.id === "anthropic" ? "" : p.id;
        out.push({
          label: m.label,
          hint: p.available ? TIER_HINT[m.tier] : "sem key",
          disabled: !p.available,
          separatorBefore: i === 0,
          checked: props.value.model === m.id && props.value.provider === provider,
          onSelect: () => props.onChange({ provider, model: m.id }),
        });
      });
    }
    return out;
  }

  return (
    <button
      type="button"
      class="cx-pill cx-pill-line"
      classList={{ "!h-[26px]": props.compact }}
      title="Modelo do agente"
      onClick={(e) => openMenu(e.currentTarget, items())}
    >
      <Show when={isAuto()} fallback={modelLabel(props.value)}>
        <Sparkles size={12} />
        {props.auto ? `Auto · ${props.auto}` : "Modelo automático"}
      </Show>
      <ChevronDown size={11} class="opacity-60" />
    </button>
  );
}
