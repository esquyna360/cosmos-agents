import {
  Bot,
  FilePen,
  FilePlus2,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  MessageCircleQuestion,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-solid";

type Input = Record<string, unknown>;

export interface ToolDisplay {
  icon: typeof Wrench;
  /** What it does, as a verb: "Editar", "Rodar". */
  verb: string;
  /** What it does it to: a path, a command, a query. */
  target: string;
  /** Set when `target` is a file path, so the row can open it. */
  path?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

/** Path as the user thinks of it: relative to one of the project's folders. */
export function shortPath(path: string, roots: string[]): string {
  for (const root of roots) {
    const base = root.replace(/\/+$/, "");
    if (path === base) return ".";
    if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  }
  return path.replace(/^\/Users\/[^/]+\//, "~/");
}

export function describeTool(name: string, input: Input, roots: string[]): ToolDisplay {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  switch (name) {
    case "Read":
      return { icon: FileText, verb: "Ler", target: shortPath(file, roots), path: file };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { icon: FilePen, verb: "Editar", target: shortPath(file, roots), path: file };
    case "Write":
      return { icon: FilePlus2, verb: "Escrever", target: shortPath(file, roots), path: file };
    case "Bash":
      return {
        icon: SquareTerminal,
        verb: "Rodar",
        target: str(input.description) || firstLine(str(input.command)),
      };
    case "BashOutput":
      return { icon: SquareTerminal, verb: "Ler saída", target: str(input.bash_id) };
    case "KillShell":
      return { icon: SquareTerminal, verb: "Encerrar", target: str(input.shell_id) };
    case "Grep":
      return {
        icon: Search,
        verb: "Buscar",
        target: [str(input.pattern), str(input.glob) || shortPath(str(input.path), roots)]
          .filter(Boolean)
          .join(" em "),
      };
    case "Glob":
      return { icon: FolderSearch, verb: "Listar", target: str(input.pattern) };
    case "WebFetch":
      return { icon: Globe, verb: "Abrir", target: str(input.url) };
    case "WebSearch":
      return { icon: Globe, verb: "Pesquisar", target: str(input.query) };
    case "Task":
    case "Agent":
      return {
        icon: Bot,
        verb: "Delegar",
        target: str(input.description) || firstLine(str(input.prompt)),
      };
    case "TodoWrite":
      return { icon: ListTodo, verb: "Atualizar", target: "lista de tarefas" };
    case "AskUserQuestion":
      return { icon: MessageCircleQuestion, verb: "Perguntar", target: "" };
    case "ExitPlanMode":
      return { icon: ListTodo, verb: "Propor", target: "plano" };
  }
  if (name.startsWith("mcp__")) {
    const [, server, ...tool] = name.split("__");
    return { icon: Plug, verb: tool.join("__") || name, target: server ?? "" };
  }
  const guess = Object.values(input).find((v) => typeof v === "string") as string | undefined;
  return { icon: Wrench, verb: name, target: firstLine(guess ?? "") };
}

/** One line for the sidebar while the tool runs. */
export function activityLine(name: string, input: Input, roots: string[]): string {
  const d = describeTool(name, input, roots);
  return d.target ? `${d.verb} ${d.target}` : d.verb;
}
