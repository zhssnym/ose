// JSDoc typedefs shared by the core (checkJs, §8.3 of the wave-3 contract). Types only: this
// module exports nothing at run time, and importing it costs nothing. The host's own shapes
// (ReadFile, SaveOutcome, OpenRequest, …) are declared in ./bridge/commands.ts and are named
// from there; what is here is what the core itself defines.

/**
 * A page route: a file, vault path or `abs:` path (X7). `line` and `col` are 1-based, `heading`
 * a `#fragment`, `query` the find text, `selection` the caret to restore; all are spent once
 * the route has been shown.
 */
export interface PageRoute {
  type: 'page';
  path: string;
  line?: number;
  col?: number;
  heading?: string;
  query?: string;
  selection?: { from: number, to: number };
}

/** A request to show a folder in the sidebar (`path` '' is the vault root); never a history entry. */
export interface FolderRoute {
  type: 'folder';
  path: string;
}

/** A view route: a registered view by name; `arg` what it is asked to show. */
export interface ViewRoute {
  type: 'view';
  name: string;
  arg?: string;
}

export type Route = PageRoute | FolderRoute | ViewRoute;

/** One tab: its history (`stack`, `index` the entry on screen), and per route key the scroll offset. */
export interface TabRecord {
  id: string;
  stack: Route[];
  index: number;
  scroll: Map<string, number>;
}

/** A status bar field as it is set (`ose.status.set(key, field)`, docs/CORE.md). */
export interface StatusField {
  text?: unknown;
  kind?: string | null;
  onClick?: (() => void) | null;
  title?: string;
  choices?: { value: string, label?: string }[];
  value?: string | null;
  onChoose?: ((value: string) => void) | null;
}

/** A status bar field as it is kept and listed. */
export interface StatusEntry {
  text: string;
  kind: string | null;
  onClick: (() => void) | null;
  title?: string;
  choices?: { value: string, label: string }[];
  value?: string | null;
  onChoose?: ((value: string) => void) | null;
}

/**
 * One change the watcher reports (docs/HOST.md "Events"). `path` is a vault path, or the
 * `abs:` path of a file outside the vault this window opened.
 */
export interface FsChange {
  kind: string;
  path: string;
  to?: string;
  dir?: boolean;
  hidden?: boolean;
}

export interface FsEvent {
  changes: FsChange[];
  lost?: boolean;
  rescan?: boolean;
}

/** One item of an OS drop, as the shell gathers it (§5.5): `path` relative inside the drop. */
export interface ImportEntry {
  path: string;
  kind: 'dir' | 'file';
  file?: File;
}

/** Window control the adapter has: Tauri's own window API. */
export interface AdapterWindow {
  close?: () => Promise<unknown>;
  setTheme?: (theme: string) => Promise<unknown>;
  setTitle?: (text: string) => unknown;
  destroy?: () => unknown;
  minimize?: () => Promise<unknown>;
  toggleMaximize?: () => Promise<unknown>;
  isMaximized?: () => Promise<boolean>;
  onResized?: (fn: () => void) => Promise<unknown>;
  startDragging?: () => Promise<unknown>;
}

/** What every bridge adapter answers (./bridge/index.ts). */
export interface Adapter {
  invoke: (name: string, args: unknown[]) => Promise<unknown>;
  subscribe: (fn: (msg: { event: string, data: any }) => unknown) => () => void;
  platform?: string;
  assetUrl?: (path: string) => string;
  win?: AdapterWindow;
  close?: () => void;
}

/** The page host the shell registers (./pagehost.ts); every method but `open` is optional. */
export interface PageHost {
  open: (el: HTMLElement, path: string, opts: { line?: number, col?: number, query?: string, selection?: { from: number, to: number } | null }) => Promise<unknown>;
  canLeave?: (reason: string) => Promise<boolean> | boolean;
  stay?: () => void;
  close?: (opts?: { park?: boolean }) => Promise<boolean> | boolean;
  release?: (path: string) => Promise<boolean> | boolean;
  rewriteLinksIn?: (path: string, pairs: { from: string, to: string }[], opts?: { settled?: boolean }) => Promise<{ handled: boolean, changed?: number, failed?: string } | null | undefined>;
  scrollToLine?: (line: number, col?: number) => boolean;
  selection?: () => { from: number, to: number } | null;
  headingLine?: (text: string, heading: string) => number;
  beforePathChange?: (change: { kind: string, from: string, to: string | null }) => Promise<{ ok: boolean, reason?: string }>;
  afterPathChange?: (change: { kind: string, from: string, to: string | null, ok: boolean, rewritten?: Record<string, string> }) => Promise<unknown>;
  claims?: (path: string) => boolean;
  problems?: () => (string | { path: string })[];
}

export {};
