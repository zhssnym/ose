// Module local of Ose Web (docs/HOST.md "Machine-local state", "Commands › local"): drafts, the
// local store and the log, kept for this origin in IndexedDB (idb.js). Nothing of it is ever in
// the vault.
//
//   drafts  `<vaultKey>/<hash(path)>` for a vault path, `outside/<hash(abs path)>` for an `abs:`
//           one: `{v:1, vault, path, text, baselineHash, mode, exact, rev, at}` as drafts.rs
//           stores it. One draft command at a time (drafts.rs `GATE`), so a `draftDrop` can never
//           remove a draft written after its rev check.
//   local   `app` and `vault:<vaultKey>`: one object each, at most 1 MB of JSON, the host's keys
//           kept out of the page's hands as local.rs keeps them.
//   log     one record per line, `<stamp> <level> <text>`, the newest 5000 kept, and the console.
//
// The semantics are the ones ported from the desktop host (drafts.rs, local.rs, commands.rs, in
// git history at 6cee39d): a vault path with no vault
// is `no_vault`; a mutating call naming another epoch is `stale_vault`; an `abs:` draft needs
// neither (it is this machine's memory of what was typed for that file).

import * as idb from './idb.js';
import { ABS, clean, fail, hash } from './rules.js';

/** The vault key of every file outside the vault (drafts.rs `Scope::Outside`). */
const OUTSIDE = 'outside';
/** The most one local object may weigh, serialised (local.rs `MAX_BYTES`). */
export const LOCAL_MAX = 1024 * 1024;
/** How many log lines are kept. */
export const LOG_MAX = 5000;
/** The log is trimmed once this many lines were written past the last trim. */
const LOG_TRIM_EVERY = 250;
/** The keys of `app` the host owns (local.rs `HOST_KEYS`), and of a vault's object. */
const APP_HOST_KEYS = ['window', 'theme', 'legacyOrigin'];
const VAULT_HOST_KEYS = ['window'];
const LEVELS = ['error', 'warn', 'info', 'debug'];
const utf8 = new TextEncoder();

/**
 * @typedef {{ path: string, text: string, baselineHash: string | null, mode: 'rich' | 'live' | 'source',
 *   exact: boolean, rev: number, at: number }} Draft
 * @typedef {Omit<Draft, 'text'> & { bytes: number }} DraftInfo
 * @typedef {{ v: 1, vault: string, path: string, text: string, baselineHash: string | null,
 *   mode: string, exact: boolean, rev: number, at: number }} StoredDraft
 * @typedef {{
 *   epoch?: () => number,
 *   keepVersion?: (path: string, bytes: Uint8Array, o: { force: boolean, reason: string }) => Promise<unknown>,
 *   now?: () => number,
 *   console?: Pick<Console, 'error' | 'warn' | 'info' | 'debug'> | null,
 *   store?: Store,
 * }} LocalOpts
 * @typedef {Pick<typeof idb, 'get' | 'put' | 'del' | 'entries' | 'count'>} Store
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `2026-09-29 10:15:00.123`, as the dev bridge stamps its log. @param {number} ms */
const stampOf = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** @param {unknown} e */
const why = (e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));

/**
 * The machine-local state of one tab.
 * @param {string | null} vaultKey the vault's id, or null with no vault open
 * @param {LocalOpts} [opts]
 */
export function createLocal(vaultKey, opts = {}) {
  const now = opts.now || (() => Date.now());
  const out = opts.console === undefined ? globalThis.console : opts.console;
  /** @type {Store} */
  const db = opts.store || idb;

  // -------------------------------------------------------------- epoch and scope

  /** A call naming an epoch that is not this tab's is refused (commands.rs `require_root_at`). @param {unknown} o */
  const checkEpoch = (o) => {
    if (!isObj(o) || o.epoch === undefined || o.epoch === null || !opts.epoch) return;
    const current = opts.epoch();
    if (Number(o.epoch) !== current) {
      throw fail('stale_vault', `this page belongs to vault epoch ${o.epoch}, the open vault is epoch ${current}`);
    }
  };

  /** The vault's key, or `no_vault`. */
  const requireVault = () => {
    if (!vaultKey) throw fail('no_vault', 'no vault is open in this tab');
    return vaultKey;
  };

  /**
   * Where a path's draft is filed (commands.rs `draft_scope`): an `abs:` path under `outside`, by
   * the path as it is; a vault path under the vault, cleaned, after the epoch check.
   * @param {unknown} p @param {unknown} [o] the options that may carry an epoch
   * @returns {{ key: string, path: string, vault: string }}
   */
  const scopeOf = (p, o) => {
    if (typeof p !== 'string') throw fail('bad_arg', 'a draft is named by its path');
    if (p.startsWith(ABS)) {
      if (p.length <= ABS.length) throw fail('bad_arg', `not a path outside the vault: ${p}`);
      return { key: `${OUTSIDE}/${hash(p)}`, path: p, vault: OUTSIDE };
    }
    const vault = requireVault();
    checkEpoch(o);
    const rel = clean(p);
    if (!rel) throw fail('bad_arg', 'a draft needs a file, not the vault root');
    return { key: `${vault}/${hash(rel)}`, path: rel, vault };
  };

  // -------------------------------------------------------------- drafts

  /** One draft command at a time (drafts.rs `GATE`). */
  let draftGate = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const gated = (fn) => {
    const run = draftGate.then(fn, fn);
    draftGate = run.then(() => {}, () => {});
    return run;
  };

  /** A stored draft, or null for anything that is not one. @param {unknown} o @returns {StoredDraft | null} */
  const asStored = (o) => (isObj(o) && o.v === 1 ? /** @type {StoredDraft} */ (o) : null);

  /** @param {string} key */
  const readStored = async (key) => {
    try { return asStored(await db.get('drafts', key)); } catch { return null; }
  };

  /** @param {string} key @param {StoredDraft} value */
  const writeStored = async (key, value) => {
    try { await db.put('drafts', value, key); } catch (e) { throw fail('write_failed', `draft: ${why(e)}`); }
  };

  /** The page-facing shape (drafts.rs `to_draft`). @param {StoredDraft} o @returns {Draft} */
  const toDraft = (o) => ({
    path: o.path ?? null,
    text: typeof o.text === 'string' ? o.text : '',
    baselineHash: o.baselineHash ?? null,
    mode: o.mode === 'source' || o.mode === 'live' ? o.mode : 'rich',
    exact: o.exact ?? true,
    rev: o.rev ?? 0,
    at: o.at ?? 0,
  });

  /**
   * `draftWrite(path, draft, opts?)` -> `{at}`.
   * @param {string} p @param {unknown} draft @param {{ epoch?: number }} [o]
   */
  const draftWrite = async (p, draft, o) => {
    const s = scopeOf(p, o);
    if (!isObj(draft)) throw fail('bad_arg', 'a draft is an object');
    if (typeof draft.text !== 'string') throw fail('bad_arg', 'a draft needs its text');
    const at = now();
    /** @type {StoredDraft} */
    const stored = {
      v: 1,
      vault: s.vault,
      path: s.path,
      text: draft.text,
      baselineHash: typeof draft.baselineHash === 'string' ? draft.baselineHash : null,
      mode: draft.mode === 'source' || draft.mode === 'live' ? draft.mode : 'rich',
      exact: typeof draft.exact === 'boolean' ? draft.exact : true,
      rev: typeof draft.rev === 'number' && Number.isFinite(draft.rev) ? draft.rev : 0,
      at,
    };
    await gated(() => writeStored(s.key, stored));
    return { at };
  };

  /** `draftList()`: this vault's drafts and every outside file's, without text, newest first. @returns {Promise<DraftInfo[]>} */
  const draftList = async () => {
    const prefixes = [`${OUTSIDE}/`];
    if (vaultKey) prefixes.unshift(`${vaultKey}/`);
    /** @type {[IDBValidKey, any][]} */
    let rows = [];
    try { rows = await db.entries('drafts'); } catch (e) { write('warn', `drafts: cannot list: ${why(e)}`); return []; }
    /** @type {DraftInfo[]} */
    const list = [];
    for (const [key, value] of rows) {
      if (typeof key !== 'string' || !prefixes.some((pre) => key.startsWith(pre))) continue;
      if (!/^[0-9a-f]{16}$/.test(key.slice(key.indexOf('/') + 1))) continue;
      const o = asStored(value);
      if (!o) continue;
      const { text, ...info } = toDraft(o);
      list.push({ ...info, bytes: utf8.encode(text).length });
    }
    return list.sort((a, b) => b.at - a.at);
  };

  /** `draftRead(path)` -> the draft or null. @param {string} p @returns {Promise<Draft | null>} */
  const draftRead = async (p) => {
    const s = scopeOf(p);
    const o = await readStored(s.key);
    return o ? toDraft(o) : null;
  };

  /**
   * `draftDrop(path, {ifRev?, epoch?})` -> `{dropped}`: only a draft at that edit or before it goes.
   * @param {string} p @param {{ ifRev?: number, epoch?: number }} [o]
   */
  const draftDrop = async (p, o) => {
    const s = scopeOf(p, o);
    return gated(async () => {
      const there = await readStored(s.key);
      if (!there) return { dropped: false };
      if (isObj(o) && typeof o.ifRev === 'number' && (Number(there.rev) || 0) > o.ifRev) return { dropped: false };
      try { await db.del('drafts', s.key); } catch (e) { throw fail('io', `draft of ${s.path}: ${why(e)}`); }
      return { dropped: true };
    });
  };

  /**
   * A rename of `from` (a file, or a folder and everything under it) to `to`: every draft of
   * this vault at or under `from` is re-keyed (drafts.rs `rekey_in`). When the new path has a
   * draft already, the newer of the two stays the draft and the older is kept as a version of
   * the new path (reason `conflict`); when that cannot be kept, both drafts stay where they are.
   * @param {string} from @param {string} to
   */
  const rekeyDrafts = (from, to) => gated(async () => {
    const [a, b] = [clean(from), clean(to)];
    if (!vaultKey || !a || a === b) return;
    const prefix = `${vaultKey}/`;
    /** @type {[IDBValidKey, any][]} */
    let rows = [];
    try { rows = await db.entries('drafts'); } catch { return; }
    for (const [oldKey, value] of rows) {
      if (typeof oldKey !== 'string' || !oldKey.startsWith(prefix)) continue;
      const o = asStored(value);
      if (!o || typeof o.path !== 'string') continue;
      let moved;
      if (o.path === a) moved = b;
      else if (o.path.startsWith(`${a}/`)) moved = b + o.path.slice(a.length);
      else continue;
      const newKey = `${prefix}${hash(moved)}`;
      const there = newKey === oldKey ? null : await readStored(newKey);
      if (there) {
        const thereIsNewer = (Number(there.at) || 0) > (Number(o.at) || 0);
        const older = thereIsNewer ? o : there;
        try {
          if (!opts.keepVersion) throw new Error('no place for versions');
          await opts.keepVersion(moved, utf8.encode(String(older.text ?? '')), { force: true, reason: 'conflict' });
        } catch (e) {
          write('warn', `drafts: ${o.path} -> ${moved}: both drafts stay, the older could not be kept: ${why(e)}`);
          continue;
        }
        if (thereIsNewer) {
          try { await db.del('drafts', oldKey); } catch { /* it stays; the version holds its text too */ }
          continue;
        }
      }
      await writeStored(newKey, { ...o, path: moved });
      if (newKey !== oldKey) {
        try { await db.del('drafts', oldKey); } catch { /* both keys hold the text: nothing lost */ }
      }
    }
  });

  // -------------------------------------------------------------- the local store

  let localGate = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const localGated = (fn) => {
    const run = localGate.then(fn, fn);
    localGate = run.then(() => {}, () => {});
    return run;
  };

  /**
   * The record's key and its host keys, or `bad_arg` / `no_vault` (commands.rs `local_file`).
   * @param {unknown} scope @param {unknown} [o]
   */
  const localKey = (scope, o) => {
    if (scope === 'app') return { key: 'app', host: APP_HOST_KEYS };
    if (scope === 'vault') {
      const v = requireVault();
      checkEpoch(o);
      return { key: `vault:${v}`, host: VAULT_HOST_KEYS };
    }
    throw fail('bad_arg', `not a local scope: ${String(scope)}`);
  };

  /** Always an object: missing or broken reads as `{}`. @param {string} key @returns {Promise<Record<string, any>>} */
  const readLocal = async (key) => {
    try {
      const v = await db.get('local', key);
      return isObj(v) ? v : {};
    } catch { return {}; }
  };

  /** `localGet(scope)` -> the object, less the host's keys. @param {'app' | 'vault'} scope */
  const localGet = async (scope) => {
    const { key, host } = localKey(scope);
    return localGated(async () => {
      const o = await readLocal(key);
      for (const k of host) delete o[k];
      return o;
    });
  };

  /**
   * `localSet(scope, value, opts?)` -> null: the whole object replaced, the host's keys keeping
   * what is stored whatever the page sent.
   * @param {'app' | 'vault'} scope @param {unknown} value @param {{ epoch?: number }} [o]
   */
  const localSet = async (scope, value, o) => {
    const { key, host } = localKey(scope, o);
    if (!isObj(value)) throw fail('bad_arg', 'local state is an object');
    let size;
    try { size = utf8.encode(JSON.stringify(value)).length; } catch (e) { throw fail('bad_arg', `local state is not JSON: ${why(e)}`); }
    if (size > LOCAL_MAX) throw fail('bad_arg', `local state is ${size} bytes, more than the 1 MB it may be`);
    // What IndexedDB keeps is the JSON of it, as the desktop's file is: no undefined, no Date.
    const next = JSON.parse(JSON.stringify(value));
    return localGated(async () => {
      const stored = await readLocal(key);
      for (const k of host) {
        delete next[k];
        if (k in stored) next[k] = stored[k];
      }
      try { await db.put('local', next, key); } catch (e) { throw fail('write_failed', `local state: ${why(e)}`); }
      return null;
    });
  };

  /**
   * One of the host's own keys of `app` (`window`, `theme`, `legacyOrigin`): what the adapter
   * keeps there for itself, out of the page's reach.
   * @param {string} name @returns {Promise<unknown>}
   */
  const hostGet = (name) => localGated(async () => (APP_HOST_KEYS.includes(name) ? (await readLocal('app'))[name] : undefined));

  /**
   * Set (or, with `undefined`, remove) one of the host's keys of `app`.
   * @param {string} name @param {unknown} value
   */
  const hostSet = (name, value) => {
    if (!APP_HOST_KEYS.includes(name)) return Promise.reject(fail('bad_arg', `not a host key: ${name}`));
    return localGated(async () => {
      const o = await readLocal('app');
      if (value === undefined) delete o[name];
      else o[name] = JSON.parse(JSON.stringify(value));
      try { await db.put('local', o, 'app'); } catch (e) { throw fail('write_failed', `local state: ${why(e)}`); }
    });
  };

  // -------------------------------------------------------------- the log

  let logChain = Promise.resolve();
  let sinceTrim = LOG_TRIM_EVERY; // trim at the first write: another tab may have left it long

  /** Keep the newest `LOG_MAX` lines. */
  const trimLog = async () => {
    const n = await db.count('log');
    if (n <= LOG_MAX) return;
    const rows = await db.entries('log');
    const excess = rows.slice(0, rows.length - LOG_MAX);
    const last = excess.at(-1);
    if (!last) return;
    if (typeof IDBKeyRange !== 'undefined' && typeof indexedDB !== 'undefined' && indexedDB) {
      try { await db.del('log', IDBKeyRange.upperBound(last[0])); return; } catch { /* one by one below */ }
    }
    for (const [k] of excess) await db.del('log', k);
  };

  /**
   * The log writer fs and the adapter use: one line `<stamp> <level> <text>` into the store and
   * the console. Never fails, never waits for the store.
   * @param {string} level @param {string} text
   */
  function write(level, text) {
    try {
      const l = LEVELS.includes(String(level).toLowerCase()) ? String(level).toLowerCase() : 'info';
      const line = `${stampOf(now())} ${l} ${String(text)}`;
      try {
        const c = out && /** @type {any} */ (out)[l];
        if (typeof c === 'function') c.call(out, `[ose] ${line}`);
      } catch { /* the console is a courtesy */ }
      logChain = logChain.then(async () => {
        try {
          await db.put('log', line);
          if (++sinceTrim >= LOG_TRIM_EVERY) {
            sinceTrim = 0;
            await trimLog();
          }
        } catch { /* logging never breaks a command */ }
      });
    } catch { /* never */ }
  }

  /** `log(text, level?)` -> null: the page's line, `ui: <text>`. @param {unknown} text @param {unknown} [level] */
  const log = async (text, level = 'info') => {
    try {
      const l = String(level || 'info').toLowerCase();
      write(LEVELS.includes(l) ? l : 'info', `ui: ${String(text)}`);
    } catch { /* never fails */ }
    return null;
  };

  /**
   * The newest `n` lines of the log, oldest first, for "Copy the log".
   * @param {number} [n] @returns {Promise<string[]>}
   */
  const logLines = async (n = LOG_MAX) => {
    await logChain;
    try {
      const rows = await db.entries('log');
      const lines = rows.map(([, v]) => String(v));
      return n > 0 ? lines.slice(-n) : [];
    } catch { return []; }
  };

  /** Everything written so far has reached the store (tests, and before a tab goes). */
  const flush = async () => {
    await Promise.all([draftGate, localGate, logChain]);
  };

  return {
    vaultKey,
    draftWrite, draftList, draftRead, draftDrop,
    localGet, localSet, log,
    rekeyDrafts, logLines, write, flush, hostGet, hostSet,
  };
}

/** @typedef {ReturnType<typeof createLocal>} Local */
