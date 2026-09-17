import { navLabel } from "../stores/nav";
import { shortPath } from "./toolDisplay";

const lastSegment = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || path;
};

/** What lists call a project. A project named after its whole path (the CLI
 *  does that) reads as its last folder unless the person asked for paths. */
export function projectLabel(p: { name: string; folders: string[]; cwd: string }): string {
  if (navLabel() === "path") return shortPath(p.folders[0] ?? p.cwd, []);
  return /[\\/]/.test(p.name) ? lastSegment(p.name) : p.name;
}
