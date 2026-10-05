import { newAgent, type RunnerUI } from "./projects";
import { openChat, send } from "./chat";
import { isClaudeRunner } from "../lib/projects";
import { routeSuggest } from "../lib/hub";

/** Creates an agent and hands it its task as the first message. */
export async function launchAgent(opts: {
  projectId: string;
  task?: string;
  name?: string;
  worktree?: boolean;
  program?: string;
  args?: string[];
  /// Empty model = let the router pick one for the task.
  model?: string;
  provider?: string;
}): Promise<RunnerUI | null> {
  let { model, provider } = opts;
  if (!model && opts.task?.trim() && (!opts.args || isClaudeRunner({ kind: "agent", args: opts.args }))) {
    try {
      const pick = (await routeSuggest(opts.task)).model;
      model = pick.model;
      provider = pick.provider;
    } catch {
      /* the CLI default is a fine fallback */
    }
  }
  const runner = await newAgent({ ...opts, model, provider });
  const text = opts.task?.trim();
  if (runner && text && isClaudeRunner(runner) && runner.mode === "chat") {
    await openChat(runner.id);
    send(runner.id, text);
  }
  return runner;
}
