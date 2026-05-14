import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import {
  memoriesDelete,
  memoriesList,
  memoriesUpsert,
  type MemoryCard,
  type MemoryKind,
} from "../lib/memory";

interface MemoryState {
  /// Cards keyed by projectId.
  byProject: Record<string, MemoryCard[]>;
}

const [state, setState] = createStore<MemoryState>({ byProject: {} });
const [loadingFor, setLoadingFor] = createSignal<Set<string>>(new Set());

export const memoryStore = state;

export function cardsFor(projectId: string): MemoryCard[] {
  return state.byProject[projectId] ?? [];
}

export async function loadMemories(projectId: string): Promise<void> {
  if (loadingFor().has(projectId)) return;
  setLoadingFor((s) => new Set(s).add(projectId));
  try {
    const cards = await memoriesList(projectId);
    setState("byProject", projectId, cards);
  } catch (e) {
    console.error("[memory] load failed", e);
  } finally {
    setLoadingFor((s) => {
      const next = new Set(s);
      next.delete(projectId);
      return next;
    });
  }
}

export async function createCard(
  projectId: string,
  init?: Partial<MemoryCard>,
): Promise<MemoryCard> {
  const stub: MemoryCard = {
    id: "",
    title: init?.title ?? "untitled",
    body: init?.body ?? "",
    kind: (init?.kind ?? "note") as MemoryKind,
    tags: init?.tags ?? [],
    pinned: init?.pinned ?? false,
    createdAt: 0,
    updatedAt: 0,
  };
  const saved = await memoriesUpsert(projectId, stub);
  setState("byProject", projectId, (cur) => sortCards([saved, ...(cur ?? [])]));
  return saved;
}

export async function updateCard(
  projectId: string,
  card: MemoryCard,
): Promise<MemoryCard> {
  const saved = await memoriesUpsert(projectId, card);
  setState("byProject", projectId, (cur) =>
    sortCards(
      (cur ?? []).map((c) => (c.id === saved.id ? saved : c)),
    ),
  );
  return saved;
}

export async function removeCard(
  projectId: string,
  cardId: string,
): Promise<void> {
  await memoriesDelete(projectId, cardId);
  setState("byProject", projectId, (cur) =>
    (cur ?? []).filter((c) => c.id !== cardId),
  );
}

function sortCards(cards: MemoryCard[]): MemoryCard[] {
  return [...cards].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}
