// The adapter (docs/HOST.md "The seam", "Commands › app"): the one bridge adapter there is,
// answering every host command in the browser over the folder the person picked. `create()` answers `{ invoke, subscribe, platform, assetUrl, win, close }`.
//
// One table: the fs commands (src/host/fs.ts, when a vault is open), the local ones
// (src/host/local.ts) and the app's own below. A vault command with no vault is `no_vault`; a
// name in none of them is `unknown_command`. Everything a handler throws leaves as a HostError
// (`fromDom`), so no DOMException reaches the facade.
//
// The tab's vault is decided once, at boot: `?vault=<id>` on the URL (what openVaultWindow opens,
// `none` for a tab with no vault), else the tab's own (sessionStorage), else the last one opened.
// It opens only when Chrome still grants it (`queryPermission`) and no other tab holds it (the Web
// Lock); otherwise `rootInfo` answers nulls and the shell's chooser (shell/vault.js) shows the
// recent vaults, whose click is the gesture `openVault` needs to ask for permission.

/// <reference path="./web.d.ts" />
/// <reference path="../core/globals.d.ts" />
import { createFs } from './fs.ts';
import { createLocal } from './local.ts';
import { ABS, extOf, fail, fromDom, HostError, isExcluded } from './rules.ts';
import * as vh from './vault-handle.ts';
import { startWatch } from './watch.ts';

export type Adapter = import('../core/types.ts').Adapter;
export type Local = import('./local.ts').Local;
export type Fs = ReturnType<typeof createFs>;
export type OpenRequest = { path: string, outside: boolean, kind: 'file' | 'dir', line?: number };
/** The adapter, plus `_state()` for the tests and the integrator. */
export type WebAdapter = Adapter & { platform: string, assetUrl: (path: string) => string, close: () => void,
  _state: () => { vault: { id: string, name: string, source: string } | null, fs: Fs | null, local: Local,
  watching: boolean, inflight: number } };

/** The fs module's commands: with no vault open, each is `no_vault`. */
export const FS_COMMANDS = ['tree', 'list', 'stat', 'exists', 'search', 'readText', 'readFile', 'saveFile', 'createNew',
  'createNewBinary', 'copyFile', 'importOutside', 'appendLine', 'replaceLine', 'writeText', 'appendText', 'writeBinary',
  'readBinary', 'mkdir', 'rename', 'copyPath', 'trash', 'trashWhere', 'trashList', 'trashRestore', 'versionKeep',
  'versionList', 'versionRead', 'versionRestore', 'getState', 'setState'];
/** The local module's commands: always there (a vault scope with no vault is local's `no_vault`). */
export const LOCAL_COMMANDS = ['draftWrite', 'draftList', 'draftRead', 'draftDrop', 'localGet', 'localSet', 'log'];
/** The commands that write: one in flight when the tab is closed makes Chrome ask "Leave site?". */
const WRITES = new Set(['saveFile', 'createNew', 'createNewBinary', 'copyFile', 'importOutside', 'appendLine', 'replaceLine',
  'writeText', 'appendText', 'writeBinary', 'mkdir', 'rename', 'copyPath', 'trash', 'trashRestore', 'versionKeep',
  'versionRestore', 'setState', 'draftWrite', 'draftDrop', 'localSet']);

/** Executables and scripts: never opened, whatever asks (dev/bridge-plugin.mjs `EXECUTABLE`). */
const EXECUTABLE = new Set(['exe', 'bat', 'cmd', 'com', 'msi', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'scr',
  'pif', 'reg', 'lnk', 'url', 'sh', 'command', 'app', 'jar', 'py', 'pyw', 'rb', 'pl', 'html', 'htm', 'svg', 'xhtml', 'mjs']);

/** What `openPath` opens in a tab, by extension (protocol.rs `mime_of`, the harmless part). */
export const OPENABLE = new Map([
  ['pdf', 'application/pdf'],
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'],
  ['avif', 'image/avif'], ['ico', 'image/x-icon'], ['bmp', 'image/bmp'],
  ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['webm', 'video/webm'], ['mov', 'video/quicktime'], ['ogg', 'video/ogg'],
  ['ogv', 'video/ogg'], ['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4'], ['wav', 'audio/wav'], ['flac', 'audio/flac'],
  ['opus', 'audio/ogg'], ['oga', 'audio/ogg'],
  ['txt', 'text/plain; charset=utf-8'], ['md', 'text/plain; charset=utf-8'], ['markdown', 'text/plain; charset=utf-8'],
  ['csv', 'text/plain; charset=utf-8'], ['log', 'text/plain; charset=utf-8'], ['json', 'text/plain; charset=utf-8'],
  ['jsonl', 'text/plain; charset=utf-8'], ['yaml', 'text/plain; charset=utf-8'], ['yml', 'text/plain; charset=utf-8'],
  ['toml', 'text/plain; charset=utf-8'], ['tex', 'text/plain; charset=utf-8'],
]);

const LOG_PATH = 'IndexedDB: ose-web/log';
/** How long `create()` waits for the service worker to control the page. */
const SW_WAIT = 3000;
/** How long a blob URL handed to a new tab lives. */
const BLOB_LIFE = 60_000;
/** How long a boot waits for this tab's own vault lock (a reload lets go a moment late). */
const RELOAD_WAIT = 1500;
/** After `window.close()`, how long before a tab Chrome kept open boots again. */
const CLOSE_CHECK = 500;

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const domName = (e: unknown) => (e && typeof e === 'object' && 'name' in e ? String(e.name) : '');
const G = (): any => globalThis;

/** 'windows' | 'macos' | 'linux', from the client hints or the user agent. */
export function detectOs(): 'windows' | 'macos' | 'linux' {
  const n = G().navigator;
  const hint = String((n && n.userAgentData && n.userAgentData.platform) || (n && n.userAgent) || '');
  if (/win/i.test(hint)) return 'windows';
  if (/mac|iphone|ipad/i.test(hint)) return 'macos';
  return 'linux';
}

/** The build stamp Vite defines, or null in dev. */
function buildStamp() {
  const sha = typeof __OSE_SHA__ === 'string' ? __OSE_SHA__ : '';
  if (!sha) return null;
  return { sha, short: typeof __OSE_SHORT__ === 'string' ? __OSE_SHORT__ : sha.slice(0, 7), date: typeof __OSE_DATE__ === 'string' ? __OSE_DATE__ : '' };
}

/**
 * The `vault/` URL of a vault path or an outside file, as sw.js serves it: `vault/<vaultId>/<path>`
 * or `vault/~abs/<outsideId>/<name>`, resolved against `base` (the app's folder). Exported so the
 * facade can answer the same form before the adapter is ready.
 */
export function assetUrlFor(vaultId: string | null, path: string, base?: string) {
  const p = String(path ?? '');
  let rel;
  const out = vh.parseOutside(p);
  if (out) rel = `vault/~abs/${out.id}/${encodeURIComponent(out.name)}`;
  else rel = `vault/${vaultId || '_'}/${p.replace(/^\.?\//, '').split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
  if (!base) return `./${rel}`;
  try { return new URL(rel, base).href; } catch { return `./${rel}`; }
}

/** The app's folder, where sw.js and `vault/` live. */
function appBase() {
  const loc = G().location;
  if (!loc || !loc.href) return '';
  try { return new URL('./', loc.href).href; } catch { return ''; }
}

/**
 * Register sw.js and wait (at most `SW_WAIT`) for it to control the page, so the first `<img>` of
 * a vault file already goes through it. Never throws: a page without a worker still works, only
 * without offline and media.
 */
async function serviceWorker() {
  const n = G().navigator;
  const sw = n && n.serviceWorker;
  if (!sw || typeof sw.register !== 'function') return;
  const base = appBase();
  if (!/^https?:/.test(base)) return;
  try {
    await sw.register(new URL('sw.js', base).href, { scope: base, type: 'module' });
  } catch (e) {
    console.warn('[web] service worker not registered', e);
    return;
  }
  if (sw.controller) return;
  await new Promise((resolve) => {
    const t = setTimeout(resolve, SW_WAIT);
    sw.addEventListener('controllerchange', () => { clearTimeout(t); resolve(undefined); }, { once: true });
  });
}

/**
 * The adapter.
 * @param opts `serviceWorker: false` skips the worker (tests)
 */
export async function create(opts: { serviceWorker?: boolean; } = {}): Promise<WebAdapter> {
  const g = G();
  const os = detectOs();
  const base = appBase();

  const subs: Set<(msg: { event: string; data: any; }) => unknown> = new Set();
  const fanout = (msg: { event: string; data: any; }) => {
    const out: unknown[] = [];
    for (const fn of [...subs]) {
      try {
        const r = fn(msg);
        if (Array.isArray(r)) out.push(...r); else if (r !== undefined) out.push(r);
      } catch (e) { console.error('[web] subscriber threw', e); }
    }
    return out;
  };
  const emit = (event: string, data: any) => fanout({ event, data });

  // ---------------------------------------------------------------- the vault of this tab

  let vault: { id: string; name: string; handle: FileSystemDirectoryHandle; source: string; } | null = null;
  let fs: Fs | null = null;
  let local: Local = createLocal(null, { epoch: vh.epoch });
  let stopWatch: (ReturnType<typeof startWatch>) | null = null;
  let persisted = false;

  const logLine = (level: string, text: string) => { try { local.write(level, text); } catch { /* never */ } };

  function unmount() {
    if (stopWatch) { try { stopWatch(); } catch { /* gone */ } }
    stopWatch = null;
    fs = null;
    vault = null;
    local = createLocal(null, { epoch: vh.epoch });
  }

  function mount(rec: vh.VaultRecord, source: string) {
    unmount();
    vault = { id: rec.id, name: rec.handle.name || rec.name, handle: rec.handle, source };
    // local.ts drops the older of two colliding drafts only once this resolves, so with no fs
    // (the vault closed meanwhile) it rejects, and both drafts stay.
    const loc: Local = createLocal(rec.id, {
      epoch: vh.epoch,
      keepVersion: (p, b, o) => (fs ? fs.keepVersion(p, b, o) : Promise.reject(fail('no_vault', 'no vault is open in this tab'))),
    });
    local = loc;
    const theFs = createFs(rec.handle, {
      vaultId: rec.id,
      epoch: vh.epoch,
      os,
      log: (level, text) => loc.write(level, text),
      outside: vh.outside,
      onRename: (from, to) => loc.rekeyDrafts(from, to),
    });
    fs = theFs;
    try {
      stopWatch = startWatch(rec.handle, theFs, emit, { outside: vh.outside });
    } catch (e) { logLine('warn', `web: the watcher did not start: ${String(e)}`); }
    vh.setTabSource(source);
    logLine('info', `web: vault ${rec.id} (${vault.name}) open, ${source}, epoch ${vh.epoch()}`);
  }

  /** Ask Chrome once to keep this origin's storage (drafts) under pressure. */
  function persist() {
    if (persisted) return;
    persisted = true;
    try {
      const st = g.navigator && g.navigator.storage;
      if (st && typeof st.persist === 'function') void st.persist().catch(() => {});
    } catch { /* not offered */ }
  }

  /**
   * Adopt a vault in this tab: the lock, the epoch one more, remembered, mounted. Null when
   * another tab holds it.
   *   @param wait ms to wait for the lock
   */
  async function adopt(rec: vh.VaultRecord, source: string, wait: number = 0) {
    if (!(await vh.holdVault(rec.id, { wait }))) return null;
    vh.setCurrentVault(rec.id);
    const epoch = vh.bumpEpoch();
    await vh.vaults.touch(rec.id);
    await vh.setLastVault(rec.id);
    persist();
    mount(rec, source);
    return { root: vh.rootOf(rec.id), name: rec.handle.name || rec.name, epoch };
  }

  // Boot: which vault, if any, this tab opens without asking.
  await (async () => {
    let fromUrl: string | null = null;
    let opfs = false;
    try {
      const q = new URLSearchParams(g.location ? g.location.search : '');
      fromUrl = q.get('vault');
      opfs = q.get('opfs') === '1';
    } catch { /* no URL */ }
    // The test hook (tests/e2e/web.spec.js): `?opfs=1` opens the origin's private file system
    // as the vault, with no picker. Only this flag reaches it; it is the origin's own sandbox,
    // never a folder of the person's, and the handle is remembered like a picked one so a
    // reload finds it again.
    if (opfs) {
      const st = g.navigator && g.navigator.storage;
      if (!st || typeof st.getDirectory !== 'function') return;
      const id = await vh.vaults.add(await st.getDirectory());
      const rec = await vh.vaults.get(id);
      if (rec && !(await adopt(rec, 'picked', RELOAD_WAIT))) logLine('info', `web: vault ${id} (opfs) is open in another tab`);
      return;
    }
    if (fromUrl === 'none') { vh.setCurrentVault(null); return; }
    const own = vh.currentVault();
    const want = fromUrl || own || (await vh.lastVault());
    if (!want) return;
    const rec = await vh.vaults.get(want);
    if (!rec) { if (want === own) vh.setCurrentVault(null); return; }
    if (!(await vh.permission(rec.handle))) { logLine('info', `web: vault ${rec.id} needs permission again`); return; }
    if (!(await vh.holdVault(rec.id, { wait: want === own ? RELOAD_WAIT : 0 }))) {
      logLine('info', `web: vault ${rec.id} is open in another tab`);
      if (want === own) vh.setCurrentVault(null);
      return;
    }
    vh.setCurrentVault(rec.id);
    await vh.vaults.touch(rec.id);
    await vh.setLastVault(rec.id);
    mount(rec, want === own ? vh.tabSource() || 'remembered' : 'remembered');
  })().catch((e) => { console.warn('[web] boot', e); });

  // ---------------------------------------------------------------- OS opens (launchQueue)

  const opens: OpenRequest[] = [];
  let opensTaken = false;

  /** A file handle as an open request: the vault path when it is inside the vault. */
  async function requestFor(h: FileSystemFileHandle) {
    if (vault) {
      try {
        const rel = await vault.handle.resolve(h);
        if (rel && rel.length && !isExcluded(rel.join('/'))) return { path: rel.join('/'), outside: false, kind: ('file' as 'file') };
      } catch { /* not ours */ }
    }
    const path = await vh.outside.register(h);
    if (stopWatch) void stopWatch.refresh().catch(() => {});
    return { path, outside: true, kind: ('file' as 'file') };
  }

  async function launched(params: LaunchParams) {
    const reqs: OpenRequest[] = [];
    for (const h of (params && params.files) || []) {
      try {
        if (h.kind === 'directory') { await vh.vaults.add((h as FileSystemDirectoryHandle)); continue; }
        reqs.push(await requestFor((h as FileSystemFileHandle)));
      } catch (e) { logLine('warn', `web: an OS open failed: ${String(e)}`); }
    }
    if (!reqs.length) return;
    if (opensTaken) emit('open', { requests: reqs });
    else opens.push(...reqs);
  }
  /** Launches still being read: `takeOpens` waits for them. */
  const launching: Set<Promise<void>> = new Set();
  if (g.launchQueue && typeof g.launchQueue.setConsumer === 'function') {
    g.launchQueue.setConsumer((params: LaunchParams) => {
      const p = launched(params).finally(() => launching.delete(p));
      launching.add(p);
    });
  }

  // ---------------------------------------------------------------- the app's commands

  const outsideOnly = (p: unknown) => typeof p === 'string' && p.startsWith(ABS);

  /** The file handle of a vault path or a registered outside one. */
  async function fileOf(p: unknown) {
    if (outsideOnly(p)) {
      const h = await vh.outside.handle(String(p));
      if (!h) throw fail('not_registered', `not opened in this tab: ${String(p)}`);
      return h;
    }
    if (!fs) throw fail('no_vault', 'no vault is open in this tab');
    return fs.fileHandle(String(p ?? ''));
  }

  const app: Record<string, (...args: any[]) => Promise<unknown>> = {
    rootInfo: async () => (vault
      ? { root: vh.rootOf(vault.id), name: vault.name, epoch: vh.epoch() }
      : { root: null, name: null, epoch: vh.epoch() }),

    vaultInfo: async () => {
      if (!vault) return { root: null, name: null, remembered: false, source: null, epoch: vh.epoch() };
      const remembered = !!(await vh.vaults.get(vault.id));
      return { root: vh.rootOf(vault.id), name: vault.name, remembered, source: vault.source, epoch: vh.epoch() };
    },

    pickVault: async (o) => {
      if (typeof g.showDirectoryPicker !== 'function') throw fail('unsupported', 'this browser cannot open a folder; use Chrome or Edge');
      let handle: FileSystemDirectoryHandle;
      try { handle = await g.showDirectoryPicker({ id: 'ose-vault', mode: 'readwrite' }); } catch (e) {
        if (domName(e) === 'AbortError') return null;
        throw e;
      }
      const id = await vh.vaults.add(handle);
      if (isObj(o) && o.adopt === false) return { root: vh.rootOf(id), name: handle.name };
      const rec = await vh.vaults.get(id);
      if (!rec) throw fail('io', 'the folder could not be remembered');
      const r = await adopt(rec, 'picked');
      if (!r) { logLine('info', `web: pickVault: ${id} is open in another tab`); return null; }
      return r;
    },

    openVault: async (path) => {
      const id = vh.idOfRoot(path);
      const rec = id ? await vh.vaults.get(id) : null;
      if (!rec) throw fail('not_found', `not a vault this browser knows: ${String(path)}`);
      if (!(await vh.permission(rec.handle, { ask: true }))) throw fail('no_vault', `permission to ${rec.name} was not given`);
      const r = await adopt(rec, 'opened');
      if (!r) return { status: 'focused', label: 'tab' };
      return { status: 'adopted', ...r };
    },

    openVaultWindow: async (path) => {
      let url = './?vault=none';
      if (path !== undefined && path !== null) {
        const id = vh.idOfRoot(path);
        if (!id || !(await vh.vaults.get(id))) throw fail('not_found', `not a vault this browser knows: ${String(path)}`);
        url = `./?vault=${id}`;
      }
      const w = typeof g.open === 'function' ? g.open(base ? new URL(url, base).href : url, '_blank') : null;
      if (!w) throw fail('unsupported', 'the browser blocked the new tab; allow pop-ups for Ose');
      try { w.opener = null; } catch { /* cross-origin already */ }
      return { label: 'tab', created: true };
    },

    recentVaults: async () => (await vh.vaults.list()).slice(0, 10).map((v) => ({
      path: vh.rootOf(v.id), name: v.name, exists: true, current: !!vault && vault.id === v.id,
    })),

    forgetVault: async (path) => {
      if (path === undefined || path === null) { await vh.setLastVault(null); return null; }
      const id = vh.idOfRoot(path);
      if (id) await vh.vaults.forget(id);
      return null;
    },

    platform: async () => ({
      os,
      version: typeof __OSE_VERSION__ === 'string' ? __OSE_VERSION__ : 'dev',
      exe: '',
      exeDir: null,
      root: vault ? vh.rootOf(vault.id) : null,
      logPath: LOG_PATH,
      build: buildStamp(),
      dragIcon: null,
    }),


    outsideOpen: async (path) => {
      const p = String(path ?? '');
      if (!vh.parseOutside(p)) throw fail('unsupported', 'a browser tab cannot open a path; use Open file…');
      const rec = await vh.outside.get(p);
      if (!rec) throw fail('not_found', `not a file this browser knows: ${p}`);
      if (!(await vh.permission(rec.handle, { ask: true }))) throw fail('no_vault', `permission to ${rec.name} was not given`);
      if (vault) {
        try {
          const rel = await vault.handle.resolve(rec.handle);
          if (rel && rel.length && !isExcluded(rel.join('/'))) {
            return { path: rel.join('/'), inside: true, name: rec.name, exists: true, kind: 'file' };
          }
        } catch { /* elsewhere */ }
      }
      let exists = true;
      try { await rec.handle.getFile(); } catch (e) {
        if (domName(e) === 'NotFoundError' || domName(e) === 'TypeMismatchError') exists = false; else throw e;
      }
      if (stopWatch) void stopWatch.refresh().catch(() => {});
      return { path: p, inside: false, name: rec.name, exists, kind: exists ? 'file' : null };
    },

    takeOpens: async () => {
      if (launching.size) await Promise.all([...launching]);
      opensTaken = true;
      return opens.splice(0);
    },

    pickFile: async () => {
      if (typeof g.showOpenFilePicker !== 'function') throw fail('unsupported', 'this browser cannot open a file; use Chrome or Edge');
      let handles: FileSystemFileHandle[];
      try { handles = await g.showOpenFilePicker({ id: 'ose-file', multiple: false }); } catch (e) {
        if (domName(e) === 'AbortError') return null;
        throw e;
      }
      const h = handles && handles[0];
      if (!h) return null;
      const abs = await vh.outside.register(h);
      if (stopWatch) void stopWatch.refresh().catch(() => {});
      return abs;
    },

    openExternal: async (url) => {
      let u;
      try { u = new URL(String(url)); } catch { throw fail('bad_arg', `not a url: ${String(url)}`); }
      if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) throw fail('bad_arg', `refused protocol: ${u.protocol}`);
      if (typeof g.open === 'function') g.open(u.href, '_blank', 'noopener');
      return null;
    },

    openPath: async (path) => {
      const ext = extOf(String(path ?? ''));
      if (EXECUTABLE.has(ext)) throw fail('unsupported', `Ose never runs a program: ${String(path)}`);
      const type = OPENABLE.get(ext);
      if (!type) throw fail('unsupported', `a browser tab cannot open .${ext || '(no extension)'} files; download it instead`);
      const h = await fileOf(path);
      const file = await h.getFile();
      const blob = new Blob([file], { type });
      const URL_ = g.URL;
      const url = URL_.createObjectURL(blob);
      const w = typeof g.open === 'function' ? g.open(url, '_blank') : null;
      if (!w) { URL_.revokeObjectURL(url); throw fail('unsupported', 'the browser blocked the new tab; allow pop-ups for Ose'); }
      setTimeout(() => URL_.revokeObjectURL(url), BLOB_LIFE);
      return null;
    },

  };

  // ---------------------------------------------------------------- the table

  let inflight = 0;

  async function dispatch(name: string, args: unknown[]): Promise<unknown> {
    const a = Array.isArray(args) ? args : [];
    if (Object.hasOwn(app, name)) return (app as any)[name](...a);
    if (LOCAL_COMMANDS.includes(name)) return (local as any)[name](...a);
    if (FS_COMMANDS.includes(name) || (fs && fs.commands.includes(name))) {
      if (!fs) throw fail('no_vault', 'no vault is open in this tab');
      return (fs as any)[name](...a);
    }
    throw new HostError(`unknown_command: ${name}`, 'unknown_command', name);
  }

  async function invoke(name: string, args: unknown[]) {
    const writes = WRITES.has(name);
    if (writes) inflight++;
    try {
      return await dispatch(name, args);
    } catch (e) {
      const err = fromDom(e, Array.isArray(args) && typeof args[0] === 'string' ? args[0] : '');
      if (!err.cmd) err.cmd = name;
      throw err;
    } finally {
      if (writes) inflight--;
    }
  }

  // ---------------------------------------------------------------- the service worker's questions

  /**
   * The worker could not read a vault file itself (no permission in its context): it asks the
   * page that made the request, which answers the File, or a status.
   */
  async function answerWorker(ev: MessageEvent) {
    const d = ev.data;
    const port = ev.ports && ev.ports[0];
    if (!port || !isObj(d) || d.type !== 'ose-vault-read') return;
    try {
      let h: FileSystemFileHandle | null = null;
      if (d.outside) {
        const rec = await vh.outside.byId(String(d.id));
        h = rec && rec.name === d.name ? rec.handle : null;
      } else if (vault && fs && d.vault === vault.id && !isExcluded(String(d.path))) {
        try { h = await fs.fileHandle(String(d.path)); } catch { h = null; }
      }
      if (!h) { port.postMessage({ ok: false, status: 404 }); return; }
      port.postMessage({ ok: true, file: await h.getFile() });
    } catch (e) {
      port.postMessage({ ok: false, status: domName(e) === 'NotAllowedError' ? 403 : 404 });
    }
  }
  const swc = g.navigator && g.navigator.serviceWorker;
  const onMessage = (ev: MessageEvent) => { void answerWorker(ev); };
  if (swc && typeof swc.addEventListener === 'function') swc.addEventListener('message', onMessage);
  if (opts.serviceWorker !== false) await serviceWorker();

  // ---------------------------------------------------------------- closing the tab

  // A browser does not wait for anything on `beforeunload`. The core banks what it can on
  // `pagehide` (router.js) and the drafts hold every keystroke, so the one thing left to guard
  // is a write in flight: then Chrome asks "Leave site?". `closing` is not fanned out here,
  // because a person who answers "Stay" would come back to a page whose view was unmounted.
  const onBeforeUnload = (ev: BeforeUnloadEvent) => {
    if (inflight > 0) { ev.preventDefault(); ev.returnValue = ''; }
  };
  if (typeof g.addEventListener === 'function') g.addEventListener('beforeunload', onBeforeUnload);

  /**
   * `ose.window.close()`: the close path. Every
   * `closing` handler is awaited (the editor's last save, the router's state flush); one that
   * answers `false` keeps the tab, and the pages the leave gate froze are handed back. Then
   * `window.close()`, which Chrome honours for an installed app's window and a tab a script
   * opened; where it does not, the tab boots again on what was just saved, so it never stays
   * on a view the close already took down.
   */
  let closingNow = false;
  async function closeTab() {
    if (closingNow) return false;
    closingNow = true;
    try {
      const pending = emit('window', { closing: true });
      const outcome = await Promise.allSettled(pending);
      if (outcome.some((r) => r.status === 'fulfilled' && r.value === false)) {
        try { (await import('../core/leave.ts')).stayWindow(); } catch { /* nothing frozen */ }
        return false;
      }
      try { if (typeof g.close === 'function') g.close(); } catch { /* not allowed */ }
      setTimeout(() => {
        try { if (!g.closed && g.location && typeof g.location.reload === 'function') g.location.reload(); } catch { /* gone */ }
      }, CLOSE_CHECK);
      return true;
    } finally { closingNow = false; }
  }

  return {
    invoke,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    platform: os,
    assetUrl: (path) => assetUrlFor(vault ? vault.id : vh.currentVault(), path, base || undefined),
    win: {
      setTitle: (text) => { try { if (g.document) g.document.title = String(text ?? ''); } catch { /* none */ } },
      // No `closing` fan-out: `app.close-anyway`, after the person said so.
      destroy: () => { try { if (typeof g.close === 'function') g.close(); } catch { /* not allowed */ } return null; },
      close: closeTab,
    },
    close() {
      if (typeof g.removeEventListener === 'function') g.removeEventListener('beforeunload', onBeforeUnload);
      if (swc && typeof swc.removeEventListener === 'function') swc.removeEventListener('message', onMessage);
      unmount();
      vh.releaseVault();
      subs.clear();
    },
    /** Tests and the integrator: the modules this adapter runs on. */
    _state: () => ({ vault, fs, local, watching: !!stopWatch, inflight }),
  };
}
