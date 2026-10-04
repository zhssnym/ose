// Bridge facade. The one host is the Rust host in src-tauri, reached through ./tauri.ts. The
// adapter implements `invoke(name, args) -> Promise` and `subscribe(fn({event, data}))`, and
// adds `win`, `platform` and `assetUrl` for what is not a host command.
//
// Every method below is one host command, typed in ./commands.ts. A name the host does not have
// is `[unknown_command]`, a hard error: nothing here guesses what an older host might have
// answered.

/// <reference path="../globals.d.ts" />
import { bus } from '../registry.ts';
import { HostError, hostError } from './errors.ts';
import { guessPlatform, vaultUrl } from './tauri-urls.ts';

export { HostError, hostError };

export type Adapter = import('../types.ts').Adapter;
export type AdapterWindow = import('../types.ts').AdapterWindow;
export type ReadFile = import('./commands.ts').ReadFile;
export type SaveOutcome = import('./commands.ts').SaveOutcome;
export type Created = import('./commands.ts').Created;
export type OutsideFile = import('./commands.ts').OutsideFile;
export type OpenRequest = import('./commands.ts').OpenRequest;
export type RootInfo = import('./commands.ts').RootInfo;
export type VaultInfo = import('./commands.ts').VaultInfo;
export type RecentVault = import('./commands.ts').RecentVault;
export type OpenVault = import('./commands.ts').OpenVault;
export type WindowOpened = import('./commands.ts').WindowOpened;
export type PlatformInfo = import('./commands.ts').PlatformInfo;
export type Entry = import('./commands.ts').Entry;
export type Stat = import('./commands.ts').Stat;
export type SearchResult = import('./commands.ts').SearchResult;
export type Trashed = import('./commands.ts').Trashed;
export type TrashPlace = import('./commands.ts').TrashPlace;
export type TrashItem = import('./commands.ts').TrashItem;
export type Restored = import('./commands.ts').Restored;
export type Copied = import('./commands.ts').Copied;
export type Hashed = import('./commands.ts').Hashed;
export type ReplaceOutcome = import('./commands.ts').ReplaceOutcome;
export type DraftAt = import('./commands.ts').DraftAt;
export type DraftInfo = import('./commands.ts').DraftInfo;
export type Draft = import('./commands.ts').Draft;
export type Dropped = import('./commands.ts').Dropped;
export type Kept = import('./commands.ts').Kept;
export type VersionInfo = import('./commands.ts').VersionInfo;
export type RestoredVersion = import('./commands.ts').RestoredVersion;


/** The platform the adapter reported, read by `bridge.platform`. */
const platform = { os: 'windows' };

/** event -> handlers */
const listeners: Map<string, Set<(data: any) => unknown>> = new Map();
function on(event: string, fn: (data: any) => unknown): () => void {
  let set = listeners.get(event);
  if (!set) { set = new Set<any>(); listeners.set(event, set); }
  set.add(fn);
  return () => { listeners.get(event)?.delete(fn); };
}
/**
 * Fan an event out and hand every handler's return value back to the adapter. The values
 * matter for `window {closing:true}` only, where a handler that resolves `false` means the page
 * cannot be left yet (the editor does that when the save needs an answer from the user). A
 * handler that throws is logged and counts as done; leaving must never hang on a bug.
 */
function dispatch({ event, data }: { event: string; data: any; }): unknown[] {
  const results: unknown[] = [];
  const set = listeners.get(event);
  if (set) {
    for (const fn of [...set]) {
      try { results.push(fn(data)); } catch (e) { console.error(`[bridge:${event}]`, e); }
    }
  }
  if (event === 'fs') bus.emit('fs', data);
  return results;
}

let adapter: Adapter | null = null;
const ready: Promise<Adapter> = (async () => {
  const mod = await import('./tauri.ts');
  const a = (await mod.create() as Adapter);
  adapter = a;
  a.subscribe(dispatch);
  if (a.platform) platform.os = a.platform;
  return a;
})();
// Outside the app (the unit tests) there is no host: every call says so when it awaits this;
// the start itself is not an unhandled error.
ready.catch(() => {});

/**
 * One host command: `adapter.invoke(name, args)`, every refusal a HostError.
 * The answer is `unknown` on purpose: each method below names its type from the bindings, so
 * a field the host does not send is a type error, not a silent `undefined`.
 */
const call = async (cmd: string, ...args: unknown[]): Promise<unknown> => {
  // An option left out is absent, not null: the adapter reads `forgetVault()` apart from
  // `forgetVault(null)`.
  while (args.length && args[args.length - 1] === undefined) args.pop();
  const a = await ready;
  try {
    return await a.invoke(cmd, args);
  } catch (e) {
    throw hostError(cmd, e);
  }
};

/**
 * The commands whose answer is always a value (docs/HOST.md). A `null` from `saveFile` read as
 * a successful write is exactly the failure that must never happen, so for these no answer is
 * an error. With typed commands the host cannot answer null to them; this stays as the belt.
 */
const valued = async (cmd: string, ...args: unknown[]): Promise<unknown> => {
  const r = await call(cmd, ...args);
  if (r === null || r === undefined) throw new HostError(`the host does not answer ${cmd}`, 'unknown_command', cmd);
  return r;
};

/**
 * The vault epoch (docs/HOST.md "Identity: vaults, roots, epochs, tabs"): the host counts every vault a window adopts, and a
 * mutating call that carries an older count than the window's is refused with `[stale_vault]`
 * instead of landing in the vault that replaced it. The core sets it from `rootInfo` at boot;
 * every mutating call below adds it to its options struct, so no caller can forget it. Unknown
 * (no vault yet) means nothing is added.
 */
let epoch: number | null = null;
/** Set by the core from `rootInfo`. */
export function setEpoch(n: unknown) { epoch = typeof n === 'number' && Number.isFinite(n) ? n : null; }
/** The current epoch, or null. */
export function currentEpoch() { return epoch; }
/**
 * `opts` with the epoch added, unless the caller named one.
 */
const withEpoch = (opts?: unknown): Record<string, any> => {
  const o: Record<string, any> = opts && typeof opts === 'object' ? { ...opts } : {};
  if (epoch !== null && o.epoch === undefined) o.epoch = epoch;
  return o;
};

// Window control is the adapter's own (Tauri's window API, ./tauri.ts). None of it is a host
// command: what the adapter does not have does nothing and answers null.
const winCall = async (name: keyof AdapterWindow, ...args: unknown[]): Promise<unknown> => {
  const a = await ready;
  const own = a.win && a.win[name];
  return typeof own === 'function' ? (own as (...x: unknown[]) => unknown)(...args) : null;
};

// Synchronous, and used in <img src> possibly before `ready` resolves; the adapter's own
// version takes over as soon as there is one.
const staticAssetUrl = (path: string) => vaultUrl(path, guessPlatform());

/**
 * A typed answer: the value `call` resolved, named as ./commands.ts declares it. A cast, not a
 * check: the host and the core ship together (M47), in one build.
 */
const as = <T>(p: Promise<unknown>): Promise<T> => (p as Promise<T>);

export const bridge = {
  /** The one host there is: the Rust host, through ./tauri.ts. */
  kind: ('tauri' as 'tauri'),
  /** 'windows', 'macos' or 'linux', once the adapter has said; 'windows' until then. */
  get platform() { return platform.os; },
  ready,
  on,
  /** Any command by its name, positional arguments: what the methods below are made of. */
  call,

  /** -> RootInfo `{ root, name, epoch }` for this window. */
  rootInfo: (): Promise<RootInfo> => as(call('rootInfo')),
  // The vault itself (docs/HOST.md "Identity: vaults, roots, epochs, tabs"): `rootInfo` answers {root:null, name:null}
  // while no vault is open; `pickVault` opens the native folder picker and adopts the choice;
  // `vaultInfo` adds where the root came from; `forgetVault` drops the remembered root.
  vaultInfo: (): Promise<VaultInfo> => as(call('vaultInfo')),
  // `opts` {adopt}: `{adopt:false}` only chooses the folder, and the caller adopts it with
  // `openVault` once the window has let go of the old one (docs/HOST.md `pickVault`).
  pickVault: (opts: { adopt?: boolean; }): Promise<{ root: string; name: string; epoch?: number | null; } | null> => as(call('pickVault', opts)),
  // The vaults this machine has opened, newest first, at most ten (S46): `recentVaults` lists
  // them, `openVault` adopts one without a dialog, and `forgetVault(path)` drops one line.
  // `forgetVault()` with no path still means "stop remembering a root at all".
  recentVaults: (): Promise<RecentVault[]> => as(call('recentVaults')),
  /**
   * -> `{ status: 'adopted', root, name, epoch }`, or `{ status: 'focused', label }` when that
   * vault is open in another window, which the host brought forward (X6).
   */
  openVault: (path: string): Promise<OpenVault> => as(valued('openVault', path)),
  /**
   * A window for `path` (a vault folder), or a new window with no vault. The host focuses the
   * window that already has it. -> `{ label, created }`
   */
  openVaultWindow: (path?: string | null): Promise<WindowOpened> => as(valued('openVaultWindow', path)),
  forgetVault: (path: string): Promise<null> => as(call('forgetVault', path)),
  // The host's own description of itself: {os, version, exe, exeDir, root, logPath, build}.
  // The chooser names `exeDir` as its suggestion.
  platformInfo: (): Promise<PlatformInfo> => as(call('platform')),
  // Every window closes through its own save path, as the close button does.
  quit: (): Promise<null> => as(call('quit')),
  // Listings (docs/HOST.md "The hide rule"): `opts { hidden }` lists hidden entries too
  // (a dotfile, or the OS hidden attribute); what is excluded (`.ose`, `.git`, the exe, temp
  // files) is never listed. The facade passes the user's Show hidden setting when the caller
  // names none. `stat` with `{ sniff: true }` adds `text`: whether the file reads as text.
  tree: (opts?: { hidden?: boolean; }): Promise<Entry> => as(call('tree', opts)),
  list: (path: string, opts: { hidden?: boolean; }): Promise<Entry[]> => as(call('list', path, opts)),
  stat: (path: string, opts?: { sniff?: boolean; }): Promise<Stat> => as(call('stat', path, opts)),
  exists: (path: string): Promise<boolean> => as(call('exists', path)),
  readText: (path: string): Promise<string> => as(call('readText', path)),
  writeText: (path: string, text: string, opts?: any): Promise<null> => as(call('writeText', path, text, withEpoch(opts))),
  appendText: (path: string, text: string, opts?: any): Promise<null> => as(call('appendText', path, text, withEpoch(opts))),
  writeBinary: (path: string, base64: string, opts?: any): Promise<null> => as(call('writeBinary', path, base64, withEpoch(opts))),
  // The file's bytes as base64 (docs/CORE.md `ose.files.readBinary`).
  readBinary: (path: string): Promise<string> => as(call('readBinary', path)),
  mkdir: (path: string, opts?: any): Promise<null> => as(call('mkdir', path, withEpoch(opts))),
  rename: (from: string, to: string, opts?: any): Promise<null> => as(call('rename', from, to, withEpoch(opts))),
  // `mode`: 'system' (the recycle bin, the default) or 'vault' (`.trash` inside the vault),
  // from settings (S37). The same object carries the epoch. -> `{ id, where }`: `id` is what
  // `trashRestore` takes, null where the platform cannot restore.
  trash: async (path: string, opts: { mode?: string; }): Promise<{ id: string | null; where: 'system' | 'vault'; }> => {
    const r = (await valued('trash', path, withEpoch(opts)) as Trashed);
    return { id: r.id ?? null, where: r.where === 'vault' ? 'vault' : 'system' };
  },
  /**
   * -> `{ where: 'system' | 'vault' }`, where `trash` would put `path` with the current mode.
   */
  trashWhere: (path: string, opts: { mode?: string; }): Promise<TrashPlace> => as(valued('trashWhere', path, opts)),
  /** -> TrashItem[], newest first: what can be restored, inside the open vault. */
  trashList: (): Promise<TrashItem[]> => as(valued('trashList')),
  /**
   * -> `{ restored: [{id, path}], failed: [{id, error}] }`. Never overwrites (`[exists]`).
   */
  trashRestore: (ids: string[], opts?: any): Promise<Restored> => as(valued('trashRestore', ids, withEpoch(opts))),
  /**
   * A file or a whole folder, bytes, create-only, links copied as links. -> `{ path, files }`
   */
  copyPath: (from: string, to: string, opts?: any): Promise<Copied> => as(valued('copyPath', from, to, withEpoch(opts))),
  search: (query: string, opts: any = {}): Promise<SearchResult> => as(call('search', query, opts)),

  // The per-machine store (docs/HOST.md "Machine-local state", W5): `app` for this machine, `vault`
  // for this machine and the open vault. Outside the vault, never synced. `localGet` answers
  // `{}` when there is nothing; `localSet` writes the whole object (at most 1 MB).
  /** -> object */
  localGet: (scope: 'app' | 'vault'): Promise<unknown> => valued('localGet', scope),
  /** -> null. The vault scope carries the epoch. */
  localSet: (scope: 'app' | 'vault', value: unknown, opts?: any): Promise<null> => as(call('localSet', scope, value, scope === 'vault' ? withEpoch(opts) : (opts || {}))),

  // The save path (docs/HOST.md "saveFile"). The JS side never computes a hash: it carries
  // the one `readFile` answered and hands it back as `expectedHash`, and the host compares and
  // writes in one call under one lock. Every one of these answers a value.
  /**
   * -> `{ text, hash, mtime, size, encoding, bom, lossy }`. `opts.encoding` forces a decoding
   * (a WHATWG label), for "Reopen with encoding…".
   */
  readFile: (path: string, opts?: { encoding?: string; }): Promise<ReadFile> => as(valued('readFile', path, opts)),
  /**
   * `opts { expectedHash: string|null, version?: 'save'|'conflict'|'none', encoding? }`
   */
  saveFile: (path: string, text: string, opts: { expectedHash?: string | null; version?: string; encoding?: string; } = {}): Promise<SaveOutcome> => as(valued('saveFile', path, text, withEpoch(opts))),
  /**
   * Exclusive create; never overwrites. -> { path, hash }
   */
  createNew: (path: string, text: string = '', opts?: any): Promise<Created> => as(valued('createNew', path, text, withEpoch(opts))),
  /**
   * Exclusive create written with its bytes in one call: a failure leaves no empty file.
   */
  createNewBinary: (path: string, base64: string, opts?: any): Promise<Created> => as(valued('createNewBinary', path, base64, withEpoch(opts))),
  /**
   * A byte copy under the same create-only rule. -> { path, hash }
   */
  copyFile: (from: string, to: string, opts?: any): Promise<Created> => as(valued('copyFile', from, to, withEpoch(opts))),
  /**
   * A registered file outside the vault (`abs:`), copied byte for byte to a vault path,
   * create-only. -> { path, hash }
   */
  importOutside: (from: string, to: string, opts?: any): Promise<Created> => as(valued('importOutside', from, to, withEpoch(opts))),
  /**
   * One line, with the separator the file needs; no `\n` in `line`. -> { hash }
   */
  appendLine: (path: string, line: string, opts?: any): Promise<Hashed> => as(valued('appendLine', path, line, withEpoch(opts))),
  /**
   * -> { status:'replaced', hash } | { status:'conflict', actual }
   */
  replaceLine: (path: string, index: number, expected: string, next: string, opts?: any): Promise<ReplaceOutcome> => as(valued('replaceLine', path, index, expected, next, withEpoch(opts))),

  // Files outside the vault and OS opens (X7, §5.3).
  /**
   * Register a file outside the vault for this window (idempotent). A path inside this
   * window's vault answers its vault path with `inside: true`.
   * @param path native absolute, or `abs:`
   */
  outsideOpen: (path: string): Promise<OutsideFile> => as(valued('outsideOpen', path)),
  /** -> OpenRequest[]: what the OS asked this window to open, emptied. */
  takeOpens: (): Promise<OpenRequest[]> => as(valued('takeOpens')),
  /**
   * The native open-file dialog. -> a native absolute path, or null when cancelled.
   */
  pickFile: (opts: { title?: string; }): Promise<string | null> => as(call('pickFile', opts)),

  // Drafts (docs/HOST.md "Machine-local state"): the buffer a page could not write, per machine, outside
  // the vault. `draftRead` answers null when there is none, so it is the one that may.
  /** -> { at } */
  draftWrite: (path: string, draft: any, opts?: any): Promise<DraftAt> => as(valued('draftWrite', path, draft, withEpoch(opts))),
  /** -> DraftInfo[], newest first */
  draftList: (): Promise<DraftInfo[]> => as(valued('draftList')),
  /** -> Draft | null */
  draftRead: (path: string): Promise<Draft | null> => as(call('draftRead', path)),
  /** opts { ifRev? } -> { dropped } */
  draftDrop: (path: string, opts: any): Promise<Dropped> => as(valued('draftDrop', path, withEpoch(opts))),

  // Versions (docs/HOST.md "Commands"): kept by the host in the app's data folder, tiered.
  // `opts` is `{ force?, reason? }`, and carries the epoch like every other write. The host
  // names the files; nothing here builds a path into the history folder.
  /** -> { kept, id } */
  versionKeep: (path: string, text: string, opts: { force?: boolean; reason?: string; }): Promise<Kept> => as(valued('versionKeep', path, text, withEpoch(opts))),
  /** -> VersionInfo[], newest first */
  versionList: (path: string): Promise<VersionInfo[]> => as(valued('versionList', path)),
  versionRead: (path: string, id: string): Promise<string | null> => as(call('versionRead', path, id)),
  /** -> { kept, id, hash } */
  versionRestore: (path: string, id: string, opts?: any): Promise<RestoredVersion> => as(valued('versionRestore', path, id, withEpoch(opts))),
  assetUrl: (path: string) => (adapter && adapter.assetUrl ? adapter.assetUrl(path) : staticAssetUrl(path)),

  win: {
    // Through the close path, so the `closing` handlers run as for the OS button.
    close: () => winCall('close'),
    setTheme: (theme: string) => winCall('setTheme', theme),
    setTitle: (text: string) => winCall('setTitle', text),
    // The window goes, without the `closing` fan-out: `app.close-anyway` only, after the user
    // said so. Drafts are outside the window and survive it.
    destroy: () => winCall('destroy'),
    minimize: () => winCall('minimize'),
    toggleMaximize: () => winCall('toggleMaximize'),
    isMaximized: async () => !!(await winCall('isMaximized')),
    onResized: (fn: () => void) => winCall('onResized', fn),
  },

  // The window's title (S13): "<page> — <vault>". Called by the router on every route change;
  // never rejects the caller's flow.
  setTitle: (text: string) => winCall('setTitle', String(text ?? '')),

  openExternal: (url: string): Promise<null> => as(call('openExternal', url)),
  // A file in the system's default app for its type (batch 12, N10/N24); a folder opens in the
  // file manager. Vault-relative, or a registered `abs:` path; an executable is revealed
  // instead of run, so this never starts a program.
  openPath: (path: string): Promise<null> => as(call('openPath', path)),
  // The file or folder shown selected in Explorer, Finder or the file manager.
  reveal: (path: string): Promise<null> => as(call('reveal', path)),
  // Paper (src-tauri/src/print.rs). `printToPdf` writes the page as a PDF through WebView2's own
  // writer, with no header or footer; with no path the host asks where. `showPrintUI` opens the
  // system print dialog and returns at once. Both are Windows only (`unsupported` elsewhere).
  printToPdf: (path: string | null, opts: { name?: string | null, folder?: string | null } | null): Promise<{ path?: string, bytes?: number, cancelled?: boolean }> =>
    as(valued('printToPdf', path, opts)),
  showPrintUI: (): Promise<unknown> => call('showPrintUI'),
  getState: (): Promise<unknown> => call('getState'),
  // The whole state object, with the epoch: a write armed in the vault this window left (a
  // debounced save, the pagehide of the reload after an adopt) is refused, never landed in the
  // vault that replaced it.
  setState: (obj: unknown): Promise<null> => as(call('setState', obj, withEpoch())),
  // `<stamp> <level> ui: <text>` in the host's log (docs/HOST.md "Machine-local state"). Never rejects: a log
  // line that cannot be written must not become an error of its own.
  log: (text: string, level: string = 'info') => call('log', String(text ?? ''), level).catch(() => null),
};

if (typeof window !== 'undefined') window.__bridge = bridge; // debugging only
