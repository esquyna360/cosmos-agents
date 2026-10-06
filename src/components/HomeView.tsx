import { projectLabel } from "../lib/projectLabel";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { ArrowUp, CornerDownRight, Ellipsis, GitBranch, SlidersHorizontal, Waypoints } from "lucide-solid";

import {
  focusProject,
  focusRunner,
  isStale,
  masterRunner,
  projectsStore,
  workFolder,
  type ProjectUI,
  type RunnerUI,
} from "../stores/projects";
import { statsOf } from "../stores/chat";
import { fmtCost, fmtTokens, vitalsOf, watchVitals } from "../stores/vitals";
import { launchAgent } from "../stores/launch";
import { openCreator } from "../stores/creator";
import { gitOf } from "../stores/git";
import { isMasterProject } from "../stores/projects";
import { branchOf } from "../stores/git";
import { relativeTime } from "../lib/time";
import { runnerSend, type Suggestion } from "../lib/hub";
import { AUTO, ensureModels, modelLabel, TIER_HINT, type ModelChoice } from "../stores/models";
import { useRoutePreview } from "../stores/routePreview";
import { go } from "../stores/nav";
import ModelPicker from "../ui/ModelPicker";
import { shortPath } from "../lib/toolDisplay";
import { needsYou, stateOf, TONE_TEXT } from "../ui/StatusGlyph";
import { ProjectIcon, RunnerIcon } from "../ui/EntityIcon";
import { openMenu } from "../ui/Menu";
import { projectMenu, runnerMenu } from "./menus";

type Kind = "all" | "agent" | "shell";

const COLS = "grid-cols-[minmax(180px,1.6fr)_130px_minmax(140px,1.1fr)_104px_96px_64px_70px_28px]";

/** Home: say what you need done, and see everything that already exists. */
export default function HomeView() {
  const [kind, setKind] = createSignal<Kind>("all");
  const [onlyMine, setOnlyMine] = createSignal(false);
  const [stale, setStale] = createSignal(false);
  const [projectId, setProjectId] = createSignal<string | null>(null);
  ensureModels();
  onCleanup(watchVitals());

  const keep = (r: RunnerUI) =>
    r.id !== masterRunner()?.id &&
    (kind() === "all" || r.kind === kind()) &&
    (!onlyMine() || needsYou(r)) &&
    (stale() || !isStale(r));

  const groups = createMemo(() =>
    projectsStore.list
      .filter((p) => !projectId() || p.id === projectId())
      .map((p) => ({ p, rows: p.runners.filter(keep) }))
      .filter((g) => g.rows.length > 0),
  );
  const hidden = createMemo(
    () => projectsStore.list.flatMap((p) => p.runners).filter((r) => isStale(r)).length,
  );
  const withRunners = () => projectsStore.list.filter((p) => p.runners.some((r) => r.id !== masterRunner()?.id));

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <QuickAgent />
      <div class="cx-home-filters shrink-0 border-b border-line px-6 py-2">
      <div class="mx-auto flex max-w-[1080px] flex-wrap items-center gap-1">
        <For each={[["all", "Tudo"], ["agent", "Agentes"], ["shell", "Terminais"]] as [Kind, string][]}>
          {([id, label]) => (
            <button class="cx-pill" data-on={kind() === id} onClick={() => setKind(id)}>
              {label}
            </button>
          )}
        </For>
        <span class="mx-1.5 h-4 w-px bg-line-strong" />
        <button class="cx-pill" data-on={onlyMine()} onClick={() => setOnlyMine(!onlyMine())}>
          Só o que precisa de mim
        </button>
        <Show when={hidden() > 0}>
          <button class="cx-pill" data-on={stale()} onClick={() => setStale(!stale())}>
            Parados há dias ({hidden()})
          </button>
        </Show>
        <span class="mx-1.5 h-4 w-px bg-line-strong" />
        <For each={withRunners()}>
          {(p) => (
            <button
              class="cx-pill"
              data-on={projectId() === p.id}
              onClick={() => setProjectId(projectId() === p.id ? null : p.id)}
            >
              {projectLabel(p)}
            </button>
          )}
        </For>
      </div>
      </div>

      <div class="cx-home-list min-h-0 flex-1 overflow-auto px-6 pb-10">
        <div class="cx-home-table mx-auto min-w-[900px] max-w-[1080px]">
          <div
            class={`cx-home-row sticky top-0 z-10 grid ${COLS} items-center gap-3 border-b border-line bg-void px-2 py-2 text-[11.5px] text-faint`}
          >
            <span>Nome</span>
            <span>Estado</span>
            <span>Onde</span>
            <span>Modelo</span>
            <span>Contexto</span>
            <span class="text-right">Custo</span>
            <span class="text-right">Última</span>
            <span />
          </div>
          <Show
            when={groups().length > 0}
            fallback={<p class="px-2 py-10 text-[13px] text-dim">Nada bate com esses filtros.</p>}
          >
            <For each={groups()}>
              {(g) => (
                <>
                  <div
                    class="mt-4 flex items-baseline gap-2 px-2 pb-1"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openMenu(e, projectMenu(g.p));
                    }}
                  >
                    <button
                      class="font-heading flex items-center gap-1.5 text-[14.5px] text-ink hover:text-accent"
                      onClick={() => focusProject(g.p.id)}
                    >
                      <ProjectIcon size={14} class="text-faint" />
                      {projectLabel(g.p)}
                    </button>
                    <span class="truncate font-mono text-[11px] text-faint">
                      {shortPath(workFolder(g.p), [])}
                    </span>
                  </div>
                  <For each={g.rows}>{(r) => <Row project={g.p} runner={r} />}</For>
                </>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}

function Row(props: { project: ProjectUI; runner: RunnerUI }) {
  const r = () => props.runner;
  const shell = () => r().kind === "shell";
  const state = () => stateOf(r());
  const stats = () => (shell() ? null : statsOf(r().id));
  const vitals = () => (shell() ? undefined : vitalsOf(r().id));
  const pct = () => {
    const s = stats();
    return s && s.contextWindow > 0 ? Math.min(100, Math.round((s.contextTokens / s.contextWindow) * 100)) : null;
  };
  const branch = () => branchOf(props.project, r());

  return (
    <div
      role="button"
      tabIndex={0}
      class={`cx-home-row group grid ${COLS} h-[32px] cursor-default items-center gap-3 rounded-lg px-2 text-[12.5px] transition hover:bg-fill-2`}
      classList={{ "bg-busy-soft": needsYou(r()) }}
      onClick={() => focusRunner(props.project.id, r().id)}
      onKeyDown={(e) => e.key === "Enter" && focusRunner(props.project.id, r().id)}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, runnerMenu(props.project, r()));
      }}
    >
      <span class="flex min-w-0 items-center gap-2">
        <RunnerIcon runner={r()} size={14} ring="var(--void)" />
        <span class="truncate text-ink" classList={{ "font-mono text-[12px]": shell() }}>
          {r().name}
        </span>
        <Show when={r().activity}>
          <span class="truncate text-[11.5px] text-faint">{r().activity}</span>
        </Show>
      </span>
      <span class={`truncate ${TONE_TEXT[state().tone]}`}>{state().label}</span>
      <span class="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-faint">
        <Show when={branch()}>
          <GitBranch size={11} class="shrink-0" />
          <span class="truncate" classList={{ "text-dim": Boolean(r().cwd) }}>{branch()}</span>
        </Show>
        <Show when={!branch()}>
          <span class="truncate">{shortPath(workFolder(props.project, r()), [])}</span>
        </Show>
      </span>
      <span class="truncate text-[11.5px] text-dim">
        <Show when={!shell() && modelLabel(r())} fallback={<span class="text-faint">–</span>}>
          {modelLabel(r())}
        </Show>
      </span>
      <span class="flex items-center gap-1.5">
        <Show
          when={pct() !== null}
          fallback={
            <span class="tabular-nums text-faint">
              {vitals()?.contextTokens ? fmtTokens(vitals()!.contextTokens) : "–"}
            </span>
          }
        >
          <span class="h-1 flex-1 overflow-hidden rounded-full bg-fill-2">
            <span
              class="block h-full rounded-full"
              classList={{ "bg-live": pct()! < 80, "bg-busy": pct()! >= 80 }}
              style={{ width: `${pct()}%` }}
            />
          </span>
          <span class="w-[28px] text-right text-[11px] tabular-nums text-faint">{pct()}%</span>
        </Show>
      </span>
      <span class="text-right tabular-nums text-dim">
        {stats() && stats()!.costUsd > 0
          ? `$${stats()!.costUsd.toFixed(2)}`
          : fmtCost(vitals()?.costUsd ?? 0) || "–"}
      </span>
      <span class="text-right text-[11.5px] text-faint">{relativeTime(r().lastActive)}</span>
      <button
        class="cx-icon-btn !h-5 !w-5 opacity-0 group-hover:opacity-100"
        aria-label={`Ações de ${r().name}`}
        onClick={(e) => {
          e.stopPropagation();
          openMenu(e.currentTarget, runnerMenu(props.project, r()));
        }}
      >
        <Ellipsis size={13} />
      </button>
    </div>
  );
}

const TARGET_KEY = "cosmos.home.target";
const HUB = "hub";

const ACTION_LABEL: Record<Suggestion["action"], string> = {
  send: "Vai para",
  spawn: "Agente novo em",
  self: "O Hub resolve",
};

/** Say what you need. The Hub decides who does it, or you pick the project. */
function QuickAgent() {
  const projects = () => projectsStore.list.filter((p) => !isMasterProject(p));
  const [text, setText] = createSignal("");
  const [picked, setPicked] = createSignal<string>(localStorage.getItem(TARGET_KEY) ?? HUB);
  const [worktree, setWorktree] = createSignal(false);
  const [model, setModel] = createSignal<ModelChoice>(AUTO);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const preview = useRoutePreview(text);

  const project = () => projects().find((p) => p.id === picked()) ?? null;
  const toHub = () => !project() && Boolean(masterRunner());
  const canWorktree = () => (project() ? (gitOf(workFolder(project()!))?.isRepo ?? false) : false);
  const ready = () => text().trim().length > 0 && (toHub() || Boolean(project()));

  function pick(id: string) {
    setPicked(id);
    localStorage.setItem(TARGET_KEY, id);
  }

  async function submit() {
    if (busy() || !ready()) return;
    setBusy(true);
    setError(null);
    try {
      const p = project();
      if (p) {
        await launchAgent({
          projectId: p.id,
          task: text(),
          worktree: worktree() && canWorktree(),
          model: model().model || undefined,
          provider: model().provider || undefined,
        });
      } else {
        await runnerSend(masterRunner()!.id, text());
        go({ kind: "hub" });
      }
      setText("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="cx-home-ask shrink-0 px-6 pb-4 pt-6">
      <div class="mx-auto flex max-w-[1080px] flex-col gap-2.5 rounded-[20px] border border-line-strong bg-raised p-3.5 shadow-cx transition focus-within:border-accent">
        <textarea
          rows={2}
          class="w-full resize-none bg-transparent px-1.5 pt-1 text-[15px] leading-snug text-ink outline-none placeholder:text-faint"
          placeholder={
            toHub()
              ? "O que precisa ser feito? O Hub decide quem faz e em qual modelo."
              : "O que precisa ser feito? Um agente novo começa por aqui."
          }
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <Show when={toHub() && preview()}>{(s) => <RoutePreview suggestion={s()} />}</Show>
        <div class="flex flex-wrap items-center gap-1">
          <Show when={masterRunner()}>
            <button class="cx-pill cx-pill-line !h-[26px]" data-on={toHub()} onClick={() => pick(HUB)}>
              <Waypoints size={12} />
              Hub decide
            </button>
            <span class="mx-1 h-4 w-px bg-line-strong" />
          </Show>
          <For each={projects()}>
            {(p) => (
              <button class="cx-pill cx-pill-line !h-[26px]" data-on={project()?.id === p.id} onClick={() => pick(p.id)}>
                {projectLabel(p)}
              </button>
            )}
          </For>
          <Show when={projects().length === 0}>
            <button class="cx-pill cx-pill-line !h-[26px]" onClick={() => openCreator({ mode: "project" })}>
              Adicionar projeto
            </button>
          </Show>
          <div class="ml-auto flex items-center gap-1">
            <Show when={project()}>
              <ModelPicker compact value={model()} onChange={setModel} auto={preview()?.model.label} />
            </Show>
            <Show when={canWorktree()}>
              <button
                class="cx-pill !h-[26px]"
                data-on={worktree()}
                title="Cópia isolada do repositório, numa branch só dele"
                onClick={() => setWorktree(!worktree())}
              >
                <GitBranch size={12} />
                Worktree própria
              </button>
            </Show>
            <button
              class="cx-icon-btn"
              title="Mais opções: nome, outra pasta, outro CLI (⌘N)"
              aria-label="Mais opções"
              onClick={() => openCreator({ mode: "agent", projectId: project()?.id })}
            >
              <SlidersHorizontal size={14} />
            </button>
            <button class="cx-btn-primary !h-[30px]" disabled={busy() || !ready()} onClick={() => void submit()}>
              {busy() ? "Enviando…" : toHub() ? "Pedir ao Hub" : "Novo agente"}
              <ArrowUp size={13} />
            </button>
          </div>
        </div>
        <Show when={error()}>
          <p class="px-1.5 text-[12.5px] text-alert">{error()}</p>
        </Show>
      </div>
    </div>
  );
}

/** Where the router would send what is being typed. The Hub has the last word. */
function RoutePreview(props: { suggestion: Suggestion }) {
  const s = () => props.suggestion;
  const best = () => s().candidates[0];
  return (
    <div class="cx-route flex min-w-0 items-center gap-2 rounded-[12px] bg-fill-1 px-2.5 py-1.5 text-[12px]">
      <CornerDownRight size={13} class="shrink-0 text-accent" />
      <span class="shrink-0 text-dim">{ACTION_LABEL[s().action]}</span>
      <Show when={best()}>
        {(c) => (
          <>
            <span class="shrink-0 font-medium text-ink">
              {s().action === "send" ? c().runnerName : c().projectName}
            </span>
            <Show when={s().action === "send"}>
              <span class="shrink-0 text-faint">em {c().projectName}</span>
            </Show>
            <span class="truncate text-faint">· {c().reasons.join(" · ")}</span>
          </>
        )}
      </Show>
      <Show when={!best()}>
        <span class="truncate text-faint">nenhum projeto bate com o pedido</span>
      </Show>
      <Show when={s().action !== "send"}>
        <span class="ml-auto shrink-0 rounded-full bg-fill-2 px-2 py-0.5 text-[11px] text-dim" title={s().model.reason}>
          {s().model.label} · {TIER_HINT[s().model.tier]}
        </span>
      </Show>
    </div>
  );
}
