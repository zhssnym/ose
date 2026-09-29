// The one IndexedDB database of Ose Web (docs/WEB.md "Machine-local state"): what the desktop
// keeps in the app's folders on this machine, kept for this origin instead. Every module of
// src/web that stores something goes through here, so there is one schema and one version.
//
//   db `ose-web`, version 1, object stores (out-of-line keys, strings unless said):
//     vaults    `<vaultId>`            -> { id, name, handle, openedAt }   the vault folders
//     outside   `<outsideId>`          -> { id, name, handle, openedAt }   files opened from outside
//     drafts    `<vaultKey>/<pathKey>` -> the draft object (as drafts.rs writes it)
//     local     `app` | `vault:<key>`  -> the local store's object
//     log       auto-increment         -> `<stamp> <level> <text>` lines
//     meta      any string             -> small values (`lastVault`, …)
//
// Where there is no IndexedDB (vitest under Node or happy-dom), the same calls run on maps in
// memory, so every module is testable without a dependency. `useMemory()` forces that, and
// `resetMemory()` empties it between tests.

const DB = 'ose-web';
const VERSION = 1;
/** @typedef {'vaults' | 'outside' | 'drafts' | 'local' | 'log' | 'meta'} StoreName */
/** @type {StoreName[]} */
export const STORES = ['vaults', 'outside', 'drafts', 'local', 'log', 'meta'];

/** @type {Map<string, Map<IDBValidKey, unknown>> | null} */
let memory = null;
let memorySeq = 0;
/** @type {Promise<IDBDatabase> | null} */
let opening = null;

/** Run on maps in memory from now on (tests). */
export function useMemory() { if (!memory) memory = new Map(STORES.map((s) => [s, new Map()])); }
/** Empty the memory backend. */
export function resetMemory() { memory = new Map(STORES.map((s) => [s, new Map()])); memorySeq = 0; }

const hasIdb = () => typeof indexedDB !== 'undefined' && indexedDB !== null;

/** @param {StoreName} name */
function mem(name) {
  if (!memory) useMemory();
  const m = /** @type {Map<string, Map<IDBValidKey, unknown>>} */ (memory).get(name);
  if (!m) throw new Error(`no such store: ${name}`);
  return m;
}

/** @returns {Promise<IDBDatabase>} */
function open() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (db.objectStoreNames.contains(s)) continue;
        if (s === 'log') db.createObjectStore(s, { autoIncrement: true });
        else db.createObjectStore(s);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading: let go, the next call opens again.
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    req.onerror = () => { opening = null; reject(req.error); };
    req.onblocked = () => { /* another tab holds an older version; onsuccess follows */ };
  });
  return opening;
}

/**
 * One request in its own transaction.
 * @template T
 * @param {StoreName} name
 * @param {IDBTransactionMode} mode
 * @param {(s: IDBObjectStore) => IDBRequest} fn
 * @returns {Promise<T>}
 */
async function run(name, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const req = fn(tx.objectStore(name));
    let value;
    req.onsuccess = () => { value = req.result; };
    tx.oncomplete = () => resolve(/** @type {T} */ (value));
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/**
 * A copy of plain data (objects, arrays, bytes), as IndexedDB would keep it, so a caller that
 * changes what it stored does not change the store. Anything else (a handle above all, which
 * IndexedDB keeps as a handle) is kept as it is.
 * @param {unknown} v
 * @returns {any}
 */
function cloned(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cloned);
  if (v instanceof Uint8Array) return v.slice();
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = cloned(x);
  return out;
}

/** @param {StoreName} name @param {IDBValidKey} key @returns {Promise<any>} */
export async function get(name, key) {
  if (!hasIdb() || memory) return cloned(mem(name).get(key));
  return run(name, 'readonly', (s) => s.get(key));
}

/**
 * @param {StoreName} name @param {unknown} value @param {IDBValidKey} [key] left out on `log`
 * @returns {Promise<IDBValidKey>}
 */
export async function put(name, value, key) {
  if (!hasIdb() || memory) {
    const k = key === undefined ? ++memorySeq : key;
    mem(name).set(k, cloned(value));
    return k;
  }
  return run(name, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
}

/** @param {StoreName} name @param {IDBValidKey | IDBKeyRange} key */
export async function del(name, key) {
  if (!hasIdb() || memory) {
    if (key instanceof Object && typeof IDBKeyRange !== 'undefined' && key instanceof IDBKeyRange) {
      for (const k of [...mem(name).keys()]) if (key.includes(k)) mem(name).delete(k);
    } else mem(name).delete(/** @type {IDBValidKey} */ (key));
    return;
  }
  await run(name, 'readwrite', (s) => s.delete(key));
}

/** Every `[key, value]` of a store, in key order. @param {StoreName} name @returns {Promise<[IDBValidKey, any][]>} */
export async function entries(name) {
  if (!hasIdb() || memory) {
    return [...mem(name).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => [k, cloned(v)]);
  }
  // Keys and values from one transaction, so they line up.
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readonly');
    const s = tx.objectStore(name);
    const k = s.getAllKeys();
    const v = s.getAll();
    tx.oncomplete = () => resolve(k.result.map((key, i) => [key, v.result[i]]));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/** @param {StoreName} name */
export async function clear(name) {
  if (!hasIdb() || memory) { mem(name).clear(); return; }
  await run(name, 'readwrite', (s) => s.clear());
}

/** How many records a store holds. @param {StoreName} name @returns {Promise<number>} */
export async function count(name) {
  if (!hasIdb() || memory) return mem(name).size;
  return run(name, 'readonly', (s) => s.count());
}
