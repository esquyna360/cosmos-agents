import { invoke } from "@tauri-apps/api/core";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

export interface ScriptsInfo {
  packageManager: PackageManager;
  scripts: Array<{ name: string; command: string }>;
}

interface ScriptsInfoSnake {
  package_manager: string;
  scripts: Array<[string, string]>;
}

export async function readPackageScripts(folder: string): Promise<ScriptsInfo> {
  const r = await invoke<ScriptsInfoSnake>("fs_read_package_scripts", { folder });
  const pm = (
    ["pnpm", "yarn", "bun", "npm"].includes(r.package_manager)
      ? r.package_manager
      : "npm"
  ) as PackageManager;
  return {
    packageManager: pm,
    scripts: r.scripts.map(([name, command]) => ({ name, command })),
  };
}

/// Build the shell command that runs `<pm> run <script>`. Used by the
/// + shell dropdown when spawning a script-runner.
export function scriptInvocation(pm: PackageManager, scriptName: string): string {
  return `${pm} run ${scriptName}`;
}
