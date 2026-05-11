import type { Component, JSX } from "solid-js";
import {
  Braces,
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Settings2,
} from "lucide-solid";

interface IconProps {
  size?: number;
  class?: string;
  style?: JSX.CSSProperties;
  color?: string;
  strokeWidth?: number;
}
type IconComponent = Component<IconProps>;

interface IconSpec {
  Icon: IconComponent;
  /** Tint applied via inline color style. */
  color: string;
}

const EXT_MAP: Record<string, IconSpec> = {
  ts: { Icon: FileCode2, color: "#3178c6" },
  tsx: { Icon: FileCode2, color: "#3178c6" },
  js: { Icon: FileCode2, color: "#d4b619" },
  jsx: { Icon: FileCode2, color: "#d4b619" },
  mjs: { Icon: FileCode2, color: "#d4b619" },
  cjs: { Icon: FileCode2, color: "#d4b619" },
  json: { Icon: Braces, color: "#a8a8a8" },
  jsonc: { Icon: Braces, color: "#a8a8a8" },
  rs: { Icon: FileCode2, color: "#c97a4c" },
  toml: { Icon: Settings2, color: "#a8a8a8" },
  yaml: { Icon: Settings2, color: "#a8a8a8" },
  yml: { Icon: Settings2, color: "#a8a8a8" },
  md: { Icon: FileText, color: "#9aa5b1" },
  markdown: { Icon: FileText, color: "#9aa5b1" },
  txt: { Icon: FileText, color: "#9aa5b1" },
  html: { Icon: FileCode2, color: "#e34c26" },
  htm: { Icon: FileCode2, color: "#e34c26" },
  css: { Icon: FileCode2, color: "#2965f1" },
  scss: { Icon: FileCode2, color: "#cd6799" },
  py: { Icon: FileCode2, color: "#3776ab" },
  go: { Icon: FileCode2, color: "#00add8" },
  rb: { Icon: FileCode2, color: "#cc342d" },
  dart: { Icon: FileCode2, color: "#0175c2" },
  php: { Icon: FileCode2, color: "#777bb4" },
  java: { Icon: FileCode2, color: "#e76f00" },
  kt: { Icon: FileCode2, color: "#a97bff" },
  swift: { Icon: FileCode2, color: "#fa7343" },
  sh: { Icon: FileCode2, color: "#a8a8a8" },
  bash: { Icon: FileCode2, color: "#a8a8a8" },
  zsh: { Icon: FileCode2, color: "#a8a8a8" },
  lock: { Icon: FileJson, color: "#777" },
  env: { Icon: Settings2, color: "#a8a8a8" },
  png: { Icon: Image, color: "#9aa5b1" },
  jpg: { Icon: Image, color: "#9aa5b1" },
  jpeg: { Icon: Image, color: "#9aa5b1" },
  gif: { Icon: Image, color: "#9aa5b1" },
  svg: { Icon: Image, color: "#9aa5b1" },
  webp: { Icon: Image, color: "#9aa5b1" },
};

export function iconForFile(name: string): IconSpec {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return { Icon: File, color: "#9aa5b1" };
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_MAP[ext] ?? { Icon: File, color: "#9aa5b1" };
}

export function folderIcon(open: boolean): IconSpec {
  return {
    Icon: open ? FolderOpen : Folder,
    color: "#8c95a3",
  };
}
