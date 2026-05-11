import { createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";

import { fsReadDir, type DirEntry } from "../lib/fs";
import { folderIcon, iconForFile } from "../lib/fileIcons";

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

const ICON_SIZE = 14;

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

  if (props.initialOpen) ensureLoaded();

  return (
    <Show when={props.depth > 0} fallback={<EntryList entries={state.entries} depth={0} onOpenFile={props.onOpenFile} selectedPath={props.selectedPath} />}>
      <RowButton
        depth={props.depth}
        onClick={() => {
          setState("open", !state.open);
          if (state.open) ensureLoaded();
        }}
      >
        <FolderGlyph open={state.open} />
        <span class="truncate">{basename(props.path)}</span>
      </RowButton>
      <Show when={state.open}>
        <EntryList
          entries={state.entries}
          depth={props.depth + 1}
          onOpenFile={props.onOpenFile}
          selectedPath={props.selectedPath}
        />
      </Show>
    </Show>
  );
}

function EntryList(props: {
  entries: DirEntry[] | null;
  depth: number;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
}) {
  return (
    <Show when={props.entries}>
      <For each={props.entries!}>
        {(e) => (
          <Entry
            entry={e}
            depth={props.depth}
            onOpenFile={props.onOpenFile}
            selectedPath={props.selectedPath}
          />
        )}
      </For>
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
  const { Icon, color } = iconForFile(props.entry.name);
  return (
    <RowButton
      depth={props.depth}
      selected={isSelected()}
      onClick={() => props.onOpenFile(props.entry.path)}
    >
      <Icon size={ICON_SIZE} class="shrink-0" style={{ color }} />
      <span class="truncate">{props.entry.name}</span>
    </RowButton>
  );
}

function NestedDir(props: {
  path: string;
  name: string;
  depth: number;
  open: boolean;
  setOpen: (v: boolean) => void;
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
}) {
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

  return (
    <>
      <RowButton
        depth={props.depth}
        onClick={() => {
          const next = !props.open;
          props.setOpen(next);
          if (next) ensureLoaded();
        }}
      >
        <FolderGlyph open={props.open} />
        <span class="truncate">{props.name}</span>
      </RowButton>
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

function FolderGlyph(props: { open: boolean }) {
  const { Icon, color } = folderIcon(props.open);
  return <Icon size={ICON_SIZE} class="shrink-0" style={{ color }} />;
}

function RowButton(props: {
  depth: number;
  selected?: boolean;
  onClick: () => void;
  children: any;
}) {
  return (
    <button
      class="flex w-full items-center gap-1.5 truncate rounded px-1 text-left text-white/75 hover:bg-white/5 hover:text-white"
      classList={{ "bg-white/10 text-white": props.selected }}
      style={{ "padding-left": `${props.depth * 12 + 4}px` }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
