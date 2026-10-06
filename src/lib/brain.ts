import { invoke } from "@tauri-apps/api/core";

export type Source = "memory" | "claude" | "guideline" | "devlog" | "project" | "note";

export interface Note {
  id: string;
  path: string;
  name: string;
  title: string;
  source: Source;
  group: string;
  description: string;
  tags: string[];
  modified: number;
  words: number;
  links: string[];
  dangling: string[];
  backlinks: number;
}

export interface BrainIndex {
  notes: Note[];
  tags: [string, number][];
}

export interface Mention {
  id: string;
  title: string;
  source: Source;
  context: string;
}

export interface Opened {
  note: Note;
  content: string;
  backlinks: Mention[];
  outgoing: Mention[];
  /** Each link as written in the note, mapped to the note it points at. */
  resolved: Record<string, string>;
}

export interface Hit {
  id: string;
  name: string;
  title: string;
  source: Source;
  group: string;
  snippet: string;
  score: number;
}

export const SOURCES: { id: Source; label: string; one: string; color: string }[] = [
  { id: "memory", label: "Memórias", one: "Memória", color: "#e6935e" },
  { id: "claude", label: "CLAUDE.md", one: "CLAUDE.md", color: "#e9c46a" },
  { id: "guideline", label: "Diretrizes", one: "Diretriz", color: "#8fb3cf" },
  { id: "devlog", label: "Dev logs", one: "Dev log", color: "#a9bb8a" },
  { id: "note", label: "Notas", one: "Nota", color: "#d3a0c4" },
  { id: "project", label: "Projetos", one: "Projeto", color: "#8ccfc0" },
];

const BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

export function sourceColor(source: string): string {
  return BY_ID.get(source as Source)?.color ?? "#b9ae9d";
}

export function sourceLabel(source: string): string {
  return BY_ID.get(source as Source)?.one ?? source;
}

export function brainIndex(): Promise<BrainIndex> {
  return invoke("brain_index");
}

export function brainOpen(note: string): Promise<Opened> {
  return invoke("brain_open", { note });
}

export function brainSearch(query: string, limit = 60): Promise<Hit[]> {
  return invoke("brain_search", { query, limit });
}

export function brainSave(note: string, content: string): Promise<Note> {
  return invoke("brain_save", { note, content });
}

export function brainCreate(title: string, body: string, tags: string[], description = ""): Promise<Note> {
  return invoke("brain_create", { title, body, tags, description });
}
