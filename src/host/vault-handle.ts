// The vaults and the outside files of Ose Web, kept in IndexedDB, and this tab's hold on one
// vault (docs/HOST.md "Identity: vaults, roots, epochs, tabs", "Files outside the vault").
//
// ---------------------------------------------------------------- path helpers
// (Reserved for the fs module's path helpers, should it need to share any here.)

// ---------------------------------------------------------------- the app's part
//
//   vaults   `{ id, name, handle, openedAt, forgotten? }` in the store `vaults`: a folder the
//            person picked, its id 16 random hex digits made the first time, kept when the same
//            folder (`isSameEntry`) is picked again. The root the page sees is `web:<id>`. The
//            drafts of a vault are filed under its id, so an id never dies while a draft is
//            filed under it: a vault forgotten, or pruned from the recent list, with drafts left
//            stays as a record marked `forgotten` (out of the list, not openable by its root),
//            and the same folder picked again gets its id back, and with it its drafts.
//   outside  `{ id, name, handle, openedAt }` in the store `outside`: a file from Open file… or
//            the OS, named `abs:/web/<id>/<name>` above the adapter.
//   the tab  its vault in `sessionStorage['ose.web.vault']`, its epoch in
//            `sessionStorage['ose.web.epoch']`, and the Web Lock `ose-vault:<id>` while it has the
//            vault: one tab per vault, as one window per vault on the desktop.
//
// Where there is no sessionStorage (tests under Node) the tab's values live in memory, and where
// there are no Web Locks every hold succeeds.

import * as idb from './idb.ts';
import { ABS } from './rules.ts';

/** The root prefix of a vault in the browser: `web:<id>`. */
export const ROOT = 'web:';
/** The prefix of an outside file's path: `abs:/web/<id>/<name>`. */
export const OUTSIDE = `${ABS}/web/`;
const S_VAULT = 'ose.web.vault';
const S_EPOCH = 'ose.web.epoch';
const S_SOURCE = 'ose.web.source';
const RECENT_MAX = 10;

export type VaultRecord = { id: string, name: string, handle: FileSystemDirectoryHandle, openedAt: number, forgotten?: boolean };
export type OutsideRecord = { id: string, name: string, handle: FileSystemFileHandle, openedAt: number };

/** 16 random hex digits. */
export function newId() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** `web:<id>` -> the id, or null for anything else. */
export function idOfRoot(root: unknown) {
  const s = String(root ?? '');
  if (!s.startsWith(ROOT)) return null;
  const id = s.slice(ROOT.length);
  return /^[0-9a-f]{16}$/.test(id) ? id : null;
}

export const rootOf = (id: string) => `${ROOT}${id}`;

/** `abs:/web/<id>/<name>` -> `{ id, name }`, or null. */
export function parseOutside(p: unknown) {
  const s = String(p ?? '');
  if (!s.startsWith(OUTSIDE)) return null;
  const rest = s.slice(OUTSIDE.length);
  const i = rest.indexOf('/');
  if (i < 0) return null;
  const id = rest.slice(0, i);
  const name = rest.slice(i + 1);
  if (!/^[0-9a-f]{16}$/.test(id) || !name || name.includes('/')) return null;
  return { id, name };
}

async function same(a: unknown, b: unknown) {
  try {
    const x = (a as FileSystemHandle);
    return !!x && typeof x.isSameEntry === 'function' && (await x.isSameEntry((b as FileSystemHandle)));
  } catch { return false; }
}

// ---------------------------------------------------------------- the vaults

/**
 * `now`, or one past the newest kept when the clock has not moved on since (two opens in one
 * millisecond): the vault opened last is always first in the list.
 * @param all newest first
 */
const after = (all: VaultRecord[], now: number) => Math.max(now, ((all[0] && all[0].openedAt) || 0) + 1);

/** Whether any draft is filed under the vault `id` (local.ts keys `<id>/<hash>`); true when the
 *  drafts cannot be read, so an id is never let go on a guess.  */
async function hasDrafts(id: string) {
  try { return (await idb.entries('drafts')).some(([k]) => typeof k === 'string' && k.startsWith(`${id}/`)); } catch { return true; }
}

/** Every record, the forgotten ones too, newest first. */
async function records(): Promise<VaultRecord[]> {
  const all = (await idb.entries('vaults')).map(([, v]) => (v as VaultRecord)).filter((v) => v && v.id);
  return all.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
}

/** Let a record go, or, while drafts are filed under its id, keep it marked forgotten.
 *   */
async function letGo(v: VaultRecord) {
  if (await hasDrafts(v.id)) { if (!v.forgotten) await idb.put('vaults', { ...v, forgotten: true }, v.id); }
  else await idb.del('vaults', v.id);
}

export const vaults = {
  /** Every vault, newest first. */
  async list(): Promise<VaultRecord[]> {
    return (await records()).filter((v) => !v.forgotten);
  },
  async get(id: string | null | undefined): Promise<VaultRecord | null> {
    if (!id) return null;
    const v = await idb.get('vaults', id);
    return v && v.handle && !v.forgotten ? (v as VaultRecord) : null;
  },
  /**
   * The folder kept, its id answered: the id it already had when it is the same folder as one
   * kept before (`isSameEntry`, a forgotten record too, so its drafts are found again), a new
   * one otherwise. The twenty newest are listed; an older one goes, or stays forgotten while it
   * has drafts.
   */
  async add(handle: FileSystemDirectoryHandle, now: number = Date.now()): Promise<string> {
    const every = await records();
    let id: string | null = null;
    for (const v of every) if (await same(v.handle, handle)) { id = v.id; break; }
    if (!id) id = newId();
    await idb.put('vaults', { id, name: handle.name, handle, openedAt: after(every, now) }, id);
    for (const v of (await vaults.list()).slice(RECENT_MAX * 2)) await letGo(v);
    for (const v of await records()) if (v.forgotten && !(await hasDrafts(v.id))) await idb.del('vaults', v.id);
    return id;
  },
  /** Opened now: first in the recent list. */
  async touch(id: string, now: number = Date.now()) {
    const v = await vaults.get(id);
    if (v) await idb.put('vaults', { ...v, openedAt: after(await vaults.list(), now) }, id);
  },
  async forget(id: string) {
    const v = (await idb.get('vaults', id) as VaultRecord | undefined);
    if (v && v.id) await letGo(v);
    else await idb.del('vaults', id);
    if ((await idb.get('meta', 'lastVault')) === id) await idb.del('meta', 'lastVault');
  },
};

/** The vault the next boot opens when the tab names none. */
export async function lastVault(): Promise<string | null> {
  const v = await idb.get('meta', 'lastVault');
  return typeof v === 'string' ? v : null;
}
export async function setLastVault(id: string | null) {
  if (id) await idb.put('meta', id, 'lastVault');
  else await idb.del('meta', 'lastVault');
}

// ---------------------------------------------------------------- the outside files

export const outside = {
  /**
   * A file from outside, kept and named: `abs:/web/<id>/<name>`. The same file (`isSameEntry`)
   * keeps its id.
   */
  async register(handle: FileSystemFileHandle, now: number = Date.now()): Promise<string> {
    let id: string | null = null;
    for (const [, v] of await idb.entries('outside')) {
      if (v && (await same(v.handle, handle))) { id = v.id; break; }
    }
    if (!id) id = newId();
    await idb.put('outside', { id, name: handle.name, handle, openedAt: now }, id);
    return `${OUTSIDE}${id}/${handle.name}`;
  },
  /** The record of an `abs:/web/…` path, or null. */
  async get(absPath: unknown): Promise<OutsideRecord | null> {
    const p = parseOutside(absPath);
    if (!p) return null;
    const v = await idb.get('outside', p.id);
    return v && v.handle && v.name === p.name ? (v as OutsideRecord) : null;
  },
  /** The handle of an `abs:/web/…` path, or null (fs's `outside.handle`). */
  async handle(absPath: string) {
    const r = await outside.get(absPath);
    return r ? r.handle : null;
  },
  /** The handle kept under an id, for the service worker's `~abs/` form. */
  async byId(id: string) {
    const v = await idb.get('outside', id);
    return v && v.handle ? (v as OutsideRecord) : null;
  },
  /** Every registered file, as the watcher takes them. */
  async list(): Promise<{ path: string; handle: FileSystemFileHandle; }[]> {
    return (await idb.entries('outside'))
      .map(([, v]) => v)
      .filter((v) => v && v.handle)
      .map((v) => ({ path: `${OUTSIDE}${v.id}/${v.name}`, handle: v.handle }));
  },
};

// ---------------------------------------------------------------- permission

/**
 * Whether the page may read and write through `handle`. With `ask`, a permission not yet given
 * is requested, which needs a user gesture (the chooser's click, a key in the address bar).
 */
export async function permission(handle: FileSystemHandle, o: { ask?: boolean; mode?: 'read' | 'readwrite'; } = {}): Promise<boolean> {
  const mode = o.mode || 'readwrite';
  try {
    if (typeof handle.queryPermission !== 'function') return true;
    const now = await handle.queryPermission({ mode });
    if (now === 'granted') return true;
    if (!o.ask || now === 'denied' || typeof handle.requestPermission !== 'function') return false;
    return (await handle.requestPermission({ mode })) === 'granted';
  } catch { return false; }
}

// ---------------------------------------------------------------- the tab

const memory: Map<string, string> = new Map();
function session(): Storage | null {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}
function sget(k: string) {
  const s = session();
  if (s) { try { return s.getItem(k); } catch { /* blocked */ } }
  return memory.get(k) ?? null;
}
function sset(k: string, v: string | null) {
  const s = session();
  if (s) {
    try { if (v === null) s.removeItem(k); else s.setItem(k, v); return; } catch { /* blocked */ }
  }
  if (v === null) memory.delete(k); else memory.set(k, v);
}

/** This tab's vault id, or null. */
export const currentVault = () => sget(S_VAULT);
export const setCurrentVault = (id: string | null) => sset(S_VAULT, id);

/** How this tab's vault came (`picked`, `opened`, `remembered`), kept over a reload. */
export const tabSource = () => sget(S_SOURCE);
export const setTabSource = (source: string | null) => sset(S_SOURCE, source);

/** This tab's epoch: 1 at first, one more on every adopt. */
export function epoch() {
  const n = Number(sget(S_EPOCH));
  return Number.isInteger(n) && n > 0 ? n : 1;
}
/** One more, and answered. */
export function bumpEpoch() {
  const next = epoch() + 1;
  sset(S_EPOCH, String(next));
  return next;
}

/** The lock this tab holds: its vault id and how to let it go. */
let held: { id: string; release: () => void; } | null = null;

/** The Web Locks of this origin, or null. */
function locks() {
  const n = (globalThis.navigator as any);
  return n && n.locks && typeof n.locks.request === 'function' ? n.locks : null;
}

/**
 * Take the Web Lock `ose-vault:<id>` and keep it until `releaseVault()`: true when this tab has
 * the vault now, false when another tab holds it. `wait` (ms) waits that long for it first (a
 * reload of this very tab lets go a moment after the new page asks).
 */
export async function holdVault(id: string, o: { wait?: number; } = {}): Promise<boolean> {
  if (held && held.id === id) return true;
  const L = locks();
  if (!L) { releaseVault(); held = { id, release: () => {} }; return true; }
  let release: () => void = (): void => {};
  const kept = new Promise((r) => { release = () => r(undefined); });
  const got = await new Promise((resolve) => {
    const name = `ose-vault:${id}`;
    const cb = (lock: unknown) => {
      if (!lock) { resolve(false); return undefined; }
      resolve(true);
      return kept;
    };
    const wait = o.wait || 0;
    if (wait > 0 && typeof AbortController !== 'undefined') {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), wait);
      L.request(name, { signal: ac.signal }, (lock: unknown) => { clearTimeout(t); return cb(lock); })
        .catch(() => { clearTimeout(t); resolve(false); });
    } else {
      L.request(name, { ifAvailable: true }, cb).catch(() => resolve(false));
    }
  });
  if (!got) return false;
  releaseVault();
  held = { id, release };
  return true;
}

/** Let the vault go (another tab may take it). */
export function releaseVault() {
  const h = held;
  held = null;
  if (h) h.release();
}

/** The id this tab holds, or null. */
export const heldVault = () => (held ? held.id : null);

/** Tests: forget the tab's memory and its lock. */
export function resetTab() {
  releaseVault();
  memory.clear();
  sset(S_VAULT, null);
  sset(S_EPOCH, null);
  sset(S_SOURCE, null);
}
