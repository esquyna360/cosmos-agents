import { createEffect, createRoot, createSignal, on } from "solid-js";

import { gitInfo, type GitInfo } from "../lib/projects";
import { projectsStore, workFolder, type ProjectUI } from "./projects";

const [infoByPath, setInfoByPath] = createSignal<Record<string, GitInfo>>({});

/** Re-reads the branch of every folder a project or runner works in. Cheap:
 *  the backend reads `.git/HEAD`, it doesn't run git. */
export async function refreshGit(): Promise<void> {
  const paths = new Set<string>();
  for (const p of projectsStore.list) {
    paths.add(workFolder(p));
    for (const r of p.runners) if (r.cwd) paths.add(r.cwd);
  }
  if (paths.size === 0) return;
  try {
    const rows = await gitInfo([...paths]);
    setInfoByPath(Object.fromEntries(rows.map((r) => [r.path, r])));
  } catch (e) {
    console.warn("[git] info failed", e);
  }
}

export function gitOf(path: string): GitInfo | null {
  return infoByPath()[path] ?? null;
}

export function branchOf(project: ProjectUI, runner?: { cwd: string; branch: string } | null): string {
  return gitOf(workFolder(project, runner))?.branch ?? runner?.branch ?? "";
}

let timer: number | undefined;

export function startGitWatch(): void {
  if (timer) return;
  createRoot(() =>
    createEffect(on(() => projectsStore.list.map((p) => p.runners.length).join(), () => void refreshGit())),
  );
  timer = window.setInterval(() => {
    if (document.hasFocus()) void refreshGit();
  }, 20_000);
}
