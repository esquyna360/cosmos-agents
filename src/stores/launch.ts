import { newAgent, type RunnerUI } from "./projects";
import { openChat, send } from "./chat";
import { isClaudeRunner } from "../lib/projects";

/** Creates an agent and hands it its task as the first message. */
export async function launchAgent(opts: {
  projectId: string;
  task?: string;
  name?: string;
  worktree?: boolean;
  program?: string;
  args?: string[];
}): Promise<RunnerUI | null> {
  const runner = await newAgent(opts);
  const text = opts.task?.trim();
  if (runner && text && isClaudeRunner(runner) && runner.mode === "chat") {
    await openChat(runner.id);
    send(runner.id, text);
  }
  return runner;
}
