import { For, Show } from "solid-js";

import { isChat, masterProject, masterRunner, projectsStore, isMasterProject } from "../stores/projects";
import { send } from "../stores/chat";
import { ptyWrite } from "../lib/ipc";
import { SessionBody } from "./SessionView";

const SUGGESTIONS = [
  "O que está rodando agora e o que precisa de mim?",
  "Crie um agente em worktree própria para uma tarefa que vou descrever",
  "Pare tudo que está ocioso há mais de um dia",
  "Resuma o que cada agente fez hoje",
];

/** The general agent, with a room of its own. Underneath it is an ordinary
 *  Claude session that knows the `cosmos` CLI. */
export default function HubView() {
  const count = () => projectsStore.list.filter((p) => !isMasterProject(p)).length;

  function ask(text: string) {
    const r = masterRunner();
    if (!r) return;
    if (isChat(r)) send(r.id, text);
    else if (r.live) ptyWrite(r.id, `${text}\r`).catch(console.error);
  }

  return (
    <Show
      when={masterProject() && masterRunner()}
      fallback={<p class="p-8 text-[13px] text-dim">O Hub ainda está subindo.</p>}
    >
      <div class="flex min-h-0 flex-1 flex-col">
        <header class="flex shrink-0 flex-col gap-2.5 border-b border-line px-6 py-3.5">
          <div class="flex items-baseline gap-3">
            <h1 class="font-heading text-[22px] leading-none text-ink">Hub</h1>
            <p class="text-[12.5px] text-dim">
              Peça em português. Ele cria projetos, sobe e para agentes e responde sobre{" "}
              {count() === 1 ? "o seu projeto" : `os seus ${count()} projetos`}.
            </p>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <For each={SUGGESTIONS}>
              {(s) => (
                <button class="cx-chip-add bg-fill-2 text-dim hover:text-ink" onClick={() => ask(s)}>
                  {s}
                </button>
              )}
            </For>
          </div>
        </header>
        <SessionBody project={masterProject()!} runner={masterRunner()!} />
      </div>
    </Show>
  );
}
