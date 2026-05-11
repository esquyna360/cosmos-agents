import { createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";

import { fsReadDir, type DirEntry } from "../lib/fs";

interface NodeState {
  entries: DirEntry[] | null;
  loading: boolean;
  open: boolean;
}

interface Props {
  root: string;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
}

export default function FileTree(props: Props) {
  return (
    <div class="flex flex-col overflow-y-auto px-1 py-1 text-[13px] leading-6 text-white/80">
      <Directory
        path={props.root}
        depth={0}
        initialOpen
        onOpenFile={props.onOpenFile}
        selectedPath={props.selectedPath}
      />
    </div>
  );
}

interface DirProps {
  path: string;
  depth: number;
  initialOpen?: boolean;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
}

function Directory(props: DirProps) {
  const [state, setState] = createStore<NodeState>({
    entries: null,
    loading: false,
    open: !!props.initialOpen,
  });

  async function ensureLoaded() {
    if (state.entries !== null || state.loading) return;
    setState("loading", true);
    try {
      const list = await fsReadDir(props.path);
      setState({ entries: list, loading: false });
    } catch (e) {
      console.error(e);
      setState({ entries: [], loading: false });
    }
  }

  if (props.initialOpen) {
    ensureLoaded();
  }

  function toggle() {
    setState("open", !state.open);
    if (state.open) ensureLoaded();
  }

  return (
    <Show
      when={props.depth > 0}
      fallback={
        <Show when={state.entries}>
          <For each={state.entries!}>
            {(e) => (
              <Entry
                entry={e}
                depth={0}
                onOpenFile={props.onOpenFile}
                selectedPath={props.selectedPath}
              />
            )}
          </For>
        </Show>
      }
    >
      <button
        class="flex w-full items-center gap-1 truncate text-left hover:text-white"
        style={{ "padding-left": `${props.depth * 12}px` }}
        onClick={toggle}
      >
        <span class="inline-block w-3 text-white/40">{state.open ? "▾" : "▸"}</span>
        <span class="truncate">{basename(props.path)}</span>
      </button>
      <Show when={state.open && state.entries}>
        <For each={state.entries!}>
          {(e) => (
            <Entry
              entry={e}
              depth={props.depth + 1}
              onOpenFile={props.onOpenFile}
              selectedPath={props.selectedPath}
            />
          )}
        </For>
      </Show>
    </Show>
  );
}

interface EntryProps {
  entry: DirEntry;
  depth: number;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
}

function Entry(props: EntryProps) {
  const [open, setOpen] = createSignal(false);

  if (props.entry.isDir) {
    return (
      <NestedDir
        path={props.entry.path}
        name={props.entry.name}
        depth={props.depth}
        open={open()}
        setOpen={setOpen}
        onOpenFile={props.onOpenFile}
        selectedPath={props.selectedPath}
      />
    );
  }

  const isSelected = () => props.selectedPath === props.entry.path;
  return (
    <button
      class="flex w-full items-center gap-1 truncate text-left text-white/70 hover:text-white"
      classList={{ "bg-white/10 text-white": isSelected() }}
      style={{ "padding-left": `${props.depth * 12 + 14}px` }}
      onClick={() => props.onOpenFile(props.entry.path)}
    >
      <span class="truncate">{props.entry.name}</span>
    </button>
  );
}

interface NestedDirProps {
  path: string;
  name: string;
  depth: number;
  open: boolean;
  setOpen: (v: boolean) => void;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
}

function NestedDir(props: NestedDirProps) {
  const [entries, setEntries] = createSignal<DirEntry[] | null>(null);

  async function ensureLoaded() {
    if (entries() !== null) return;
    try {
      setEntries(await fsReadDir(props.path));
    } catch (e) {
      console.error(e);
      setEntries([]);
    }
  }

  function toggle() {
    const next = !props.open;
    props.setOpen(next);
    if (next) ensureLoaded();
  }

  return (
    <>
      <button
        class="flex w-full items-center gap-1 truncate text-left text-white/80 hover:text-white"
        style={{ "padding-left": `${props.depth * 12}px` }}
        onClick={toggle}
      >
        <span class="inline-block w-3 text-white/40">{props.open ? "▾" : "▸"}</span>
        <span class="truncate">{props.name}</span>
      </button>
      <Show when={props.open && entries()}>
        <For each={entries()!}>
          {(e) => (
            <Entry
              entry={e}
              depth={props.depth + 1}
              onOpenFile={props.onOpenFile}
              selectedPath={props.selectedPath}
            />
          )}
        </For>
      </Show>
    </>
  );
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
