import { invoke } from "@tauri-apps/api/core";

export type MemoryKind = "note" | "decision" | "snippet" | "todo";

export interface MemoryCard {
  id: string;
  title: string;
  body: string;
  kind: MemoryKind;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

interface MemoryCardSnake {
  id: string;
  title: string;
  body: string;
  kind: string;
  tags: string[];
  pinned: boolean;
  created_at: number;
  updated_at: number;
}

function fromSnake(c: MemoryCardSnake): MemoryCard {
  return {
    id: c.id,
    title: c.title,
    body: c.body,
    kind: (c.kind === "decision" || c.kind === "snippet" || c.kind === "todo"
      ? c.kind
      : "note") as MemoryKind,
    tags: c.tags ?? [],
    pinned: c.pinned,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function toSnake(c: MemoryCard): MemoryCardSnake {
  return {
    id: c.id,
    title: c.title,
    body: c.body,
    kind: c.kind,
    tags: c.tags,
    pinned: c.pinned,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

export async function memoriesList(projectId: string): Promise<MemoryCard[]> {
  const rows = await invoke<MemoryCardSnake[]>("memories_list", { projectId });
  return rows.map(fromSnake);
}

export async function memoriesUpsert(
  projectId: string,
  card: MemoryCard,
): Promise<MemoryCard> {
  const r = await invoke<MemoryCardSnake>("memories_upsert", {
    projectId,
    card: toSnake(card),
  });
  return fromSnake(r);
}

export function memoriesDelete(projectId: string, cardId: string): Promise<void> {
  return invoke("memories_delete", { projectId, cardId });
}
