// Module app of Ose Web (docs/HOST.md "Commands › app", "Identity", "Events"): src/host/adapter.js
// and src/host/vault-handle.js over the in-memory File System Access API (tests/stubs/fsa.js) and
// idb.js's memory backend, the pure parts of src/host/sw.js, the manifest and the web build's
// helpers. Every browser global the adapter reads (navigator.locks, the service worker
// container, launchQueue, location, window.open, the tab's own events) is a stub here.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFsa } from '../stubs/fsa.js';
import * as idb from '../../src/host/idb.js';
import { isExcluded } from '../../src/host/rules.js';
import * as vh from '../../src/host/vault-handle.js';
import { assetUrlFor, create, detectOs, FS_COMMANDS, LOCAL_COMMANDS, OPENABLE } from '../../src/host/adapter.js';
import { excludedSegs, fileResponse, parseVaultPath, precacheRequests } from '../../src/host/sw.js';
import { withCsp, withManifestLink, workerSource } from '../../vite.config.js';

const REPO = process.env.OSE_REPO || process.cwd();
const ID = /^[0-9a-f]{16}$/;

// ------------------------------------------------------------------ the browser, stubbed

/** Web Locks for one origin: `request(name, opts?, cb)` with `ifAvailable` and `signal`. */
function makeLocks() {
  /** @type {Map<string, { waiters: Array<() => void> }>} */
  const taken = new Map();
  /** @param {string} name @param {any} opts @param {any} [cb] */
  async function request(name, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const entry = taken.get(name);
    if (entry) {
      if (opts.ifAvailable) return cb(null);
      await new Promise((resolve, reject) => {
        const w = () => resolve(undefined);
        entry.waiters.push(w);
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            const i = entry.waiters.indexOf(w);
            if (i >= 0) entry.waiters.splice(i, 1);
            reject(new DOMException('aborted', 'AbortError'));
          });
        }
      });
    } else {
      taken.set(name, { waiters: [] });
    }
    try { return await cb({ name }); } finally {
      const e = taken.get(name);
      const next = e && e.waiters.shift();
      if (next) next(); else taken.delete(name);
    }
  }
  /** Another tab takes `name` and keeps it until the answer is called. @param {string} name */
  function other(name) {
    /** @type {() => void} */
    let release = () => {};
    void request(name, {}, () => new Promise((r) => { release = () => r(undefined); }));
    return () => release();
  }
  return { request, taken, other };
}

/** The tab: a window-ish EventTarget with open/close, a document, a location. */
function makeTab() {
  const target = new EventTarget();
  /** @type {any[]} */
  const opened = [];
  const tab = {
    target,
    opened,
    closed: false,
    closeCalls: 0,
    reloads: 0,
    blockPopups: false,
    document: { title: '' },
    open: vi.fn((url, name, features) => {
      opened.push({ url, name, features });
      return tab.blockPopups ? null : { opener: {} };
    }),
    close: vi.fn(() => { tab.closeCalls++; }),
  };
  return tab;
}

/** @type {Array<() => void>} */
let cleanups = [];
/** @type {ReturnType<typeof makeLocks>} */
let locks;
/** @type {ReturnType<typeof makeTab>} */
let tab;
/** @type {EventTarget & { controller?: unknown }} */
let swc;
/** @type {any} */
let fsa;

/**
 * Put the stubs on globalThis. `url` is the page's address (`?vault=` is read from it).
 * @param {{ url?: string, launchQueue?: boolean }} [o]
 */
function browser(o = {}) {
  locks = makeLocks();
  tab = makeTab();
  swc = new EventTarget();
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', locks, serviceWorker: swc, storage: { persist: vi.fn(async () => true) } });
  vi.stubGlobal('document', tab.document);
  vi.stubGlobal('open', tab.open);
  vi.stubGlobal('close', tab.close);
  vi.stubGlobal('addEventListener', tab.target.addEventListener.bind(tab.target));
  vi.stubGlobal('removeEventListener', tab.target.removeEventListener.bind(tab.target));
  const href = o.url || 'https://ose.test/app/';
  const u = new URL(href);
  vi.stubGlobal('location', { href, search: u.search, pathname: u.pathname, reload: vi.fn(() => { tab.reloads++; }) });
  if (o.launchQueue) {
    /** @type {any} */
    const lq = { consumer: null, setConsumer(fn) { lq.consumer = fn; } };
    vi.stubGlobal('launchQueue', lq);
  }
}

/** @param {Parameters<typeof create>[0]} [o] */
async function adapter(o = {}) {
  const a = await create({ serviceWorker: false, ...o });
  cleanups.push(() => a.close());
  return a;
}

/** @param {() => Promise<unknown>} fn */
async function code(fn) {
  try { await fn(); } catch (e) { return /** @type {any} */ (e).code; }
  return 'resolved';
}

/** @param {() => Promise<unknown>} fn */
async function thrown(fn) {
  try { await fn(); } catch (e) { return /** @type {any} */ (e); }
  throw new Error('did not throw');
}

/** A vault picked in a fresh adapter: `{ a, root, id }`. */
async function picked(files = { 'a.md': '# A\n', 'img/p.png': 'PNG' }) {
  fsa = createFsa({ files, name: 'Notes' });
  cleanups.push(fsa.install());
  const a = await adapter();
  const r = /** @type {any} */ (await a.invoke('pickVault', []));
  return { a, r, id: /** @type {string} */ (vh.idOfRoot(r.root)) };
}

beforeEach(() => {
  idb.useMemory();
  idb.resetMemory();
  vh.resetTab();
  browser();
});

afterEach(() => {
  for (const c of cleanups.reverse()) { try { c(); } catch { /* gone */ } }
  cleanups = [];
  vh.resetTab();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ------------------------------------------------------------------ vault-handle.js

describe('vault-handle: ids and paths', () => {
  it('makes 16 hex digit ids, and reads roots and outside paths back', () => {
    const a = vh.newId();
    expect(a).toMatch(ID);
    expect(vh.newId()).not.toBe(a);
    expect(vh.rootOf(a)).toBe(`web:${a}`);
    expect(vh.idOfRoot(`web:${a}`)).toBe(a);
    for (const bad of [null, undefined, '', 'web:', 'web:xyz', `web:${a}0`, `/web/${a}`, 'C:\\notes', `WEB:${a}`]) {
      expect(vh.idOfRoot(bad)).toBeNull();
    }
    expect(vh.parseOutside(`abs:/web/${a}/My file.md`)).toEqual({ id: a, name: 'My file.md' });
    for (const bad of ['abs:/home/me/a.md', `abs:/web/${a}`, `abs:/web/${a}/`, `abs:/web/${a}/x/y.md`, 'abs:/web/zz/a.md', 'a.md']) {
      expect(vh.parseOutside(bad)).toBeNull();
    }
  });
});

describe('vault-handle: the vaults', () => {
  it('keeps a folder once, by isSameEntry, and lists newest first', async () => {
    const one = createFsa({ name: 'One' });
    const two = createFsa({ name: 'Two' });
    const a = await vh.vaults.add(one.root, 10);
    const b = await vh.vaults.add(two.root, 20);
    expect(a).toMatch(ID);
    expect(b).not.toBe(a);
    expect((await vh.vaults.list()).map((v) => v.name)).toEqual(['Two', 'One']);
    // The same folder again, from another handle to it: the same id, and first now.
    expect(await vh.vaults.add(one.handle(''), 30)).toBe(a);
    expect((await vh.vaults.list()).map((v) => v.id)).toEqual([a, b]);
    await vh.vaults.touch(b, 40);
    expect((await vh.vaults.list())[0]?.id).toBe(b);
    expect((await vh.vaults.get(a))?.handle).toBeTruthy();
    expect(await vh.vaults.get('0000000000000000')).toBeNull();
    expect(await vh.vaults.get(null)).toBeNull();
  });

  it('forgets a vault, and the last vault with it', async () => {
    const one = createFsa({ name: 'One' });
    const a = await vh.vaults.add(one.root);
    await vh.setLastVault(a);
    expect(await vh.lastVault()).toBe(a);
    await vh.vaults.forget(a);
    expect(await vh.vaults.get(a)).toBeNull();
    expect(await vh.lastVault()).toBeNull();
  });

  it('a forgotten vault with drafts keeps its id: the same folder picked again finds them', async () => {
    const one = createFsa({ name: 'One' });
    const a = await vh.vaults.add(one.root, 10);
    await idb.put('drafts', { v: 1, vault: a, path: 'a.md', text: 'typed' }, `${a}/0123`);
    await vh.vaults.forget(a);
    expect(await vh.vaults.get(a)).toBeNull();
    expect(await vh.vaults.list()).toEqual([]);
    expect(await vh.vaults.add(one.handle(''), 20)).toBe(a);
    expect((await vh.vaults.list()).map((v) => v.id)).toEqual([a]);
    // With no drafts left, forget lets the record go, and the next pick is a new id.
    await idb.del('drafts', `${a}/0123`);
    await vh.vaults.forget(a);
    expect(await vh.vaults.add(one.handle(''), 30)).not.toBe(a);
  });

  it('pruning never lets go of an id with drafts', async () => {
    const first = createFsa({ name: 'First' });
    const a = await vh.vaults.add(first.root, 0);
    await idb.put('drafts', { v: 1, vault: a, path: 'a.md', text: 'typed' }, `${a}/0123`);
    for (let i = 1; i < 25; i++) await vh.vaults.add(createFsa({ name: `V${i}` }).root, i);
    expect(await vh.vaults.list()).toHaveLength(20);
    expect(await vh.vaults.get(a)).toBeNull();
    expect(await vh.vaults.add(first.handle(''), 100)).toBe(a);
  });

  it('keeps at most twenty records', async () => {
    for (let i = 0; i < 25; i++) await vh.vaults.add(createFsa({ name: `V${i}` }).root, i);
    const all = await vh.vaults.list();
    expect(all).toHaveLength(20);
    expect(all[0]?.name).toBe('V24');
  });
});

describe('vault-handle: the outside files', () => {
  it('registers a file once and names it abs:/web/<id>/<name>', async () => {
    const f = createFsa({ files: { 'x.md': 'x' } });
    const h = f.handle('x.md');
    const p = await vh.outside.register(h, 5);
    expect(p).toMatch(/^abs:\/web\/[0-9a-f]{16}\/x\.md$/);
    expect(await vh.outside.register(f.handle('x.md'), 6)).toBe(p);
    expect(await vh.outside.handle(p)).toBeTruthy();
    expect(await vh.outside.handle(p.replace('x.md', 'y.md'))).toBeNull();
    expect(await vh.outside.handle('abs:/home/x.md')).toBeNull();
    const id = /** @type {any} */ (vh.parseOutside(p)).id;
    expect((await vh.outside.byId(id))?.name).toBe('x.md');
    expect(await vh.outside.list()).toEqual([{ path: p, handle: expect.anything() }]);
  });
});

describe('vault-handle: permission', () => {
  it('answers granted at once, asks only when told to, never after denied', async () => {
    const f = createFsa();
    expect(await vh.permission(f.root)).toBe(true);
    f.permission.permission = 'prompt';
    expect(await vh.permission(f.root)).toBe(false);
    expect(f.permission.requests).toBe(0);
    f.permission.answer = 'denied';
    expect(await vh.permission(f.root, { ask: true })).toBe(false);
    expect(f.permission.requests).toBe(1);
    expect(await vh.permission(f.root, { ask: true })).toBe(false);
    expect(f.permission.requests).toBe(1);
    f.permission.permission = 'prompt';
    f.permission.answer = 'granted';
    expect(await vh.permission(f.root, { ask: true })).toBe(true);
    // A handle whose query throws (the folder gone) is no permission.
    expect(await vh.permission(/** @type {any} */ ({ queryPermission: async () => { throw new Error('x'); } }))).toBe(false);
  });
});

describe('vault-handle: the tab', () => {
  it('keeps the vault, the source and the epoch per tab', () => {
    expect(vh.currentVault()).toBeNull();
    expect(vh.epoch()).toBe(1);
    expect(vh.bumpEpoch()).toBe(2);
    expect(vh.bumpEpoch()).toBe(3);
    vh.setCurrentVault('0123456789abcdef');
    vh.setTabSource('picked');
    expect(vh.currentVault()).toBe('0123456789abcdef');
    expect(vh.tabSource()).toBe('picked');
    vh.resetTab();
    expect(vh.currentVault()).toBeNull();
    expect(vh.epoch()).toBe(1);
  });

  it('holds one vault with the Web Lock, and lets it go', async () => {
    const id = '0123456789abcdef';
    expect(await vh.holdVault(id)).toBe(true);
    expect(vh.heldVault()).toBe(id);
    expect(locks.taken.has(`ose-vault:${id}`)).toBe(true);
    expect(await vh.holdVault(id)).toBe(true);
    // Another vault: taken, and the first let go.
    const other = 'fedcba9876543210';
    expect(await vh.holdVault(other)).toBe(true);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(locks.taken.has(`ose-vault:${id}`)).toBe(false);
    vh.releaseVault();
    await new Promise((r) => setTimeout(r, 0));
    expect(locks.taken.has(`ose-vault:${other}`)).toBe(false);
    expect(vh.heldVault()).toBeNull();
  });

  it('does not take a vault another tab holds, and waits when asked', async () => {
    const id = '0123456789abcdef';
    const release = locks.other(`ose-vault:${id}`);
    await Promise.resolve();
    expect(await vh.holdVault(id)).toBe(false);
    expect(await vh.holdVault(id, { wait: 20 })).toBe(false);
    const later = vh.holdVault(id, { wait: 1000 });
    setTimeout(release, 10);
    expect(await later).toBe(true);
  });

  it('holds anything where there are no Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    expect(await vh.holdVault('0123456789abcdef')).toBe(true);
    expect(vh.heldVault()).toBe('0123456789abcdef');
  });
});

// ------------------------------------------------------------------ the adapter with no vault

describe('adapter: no vault', () => {
  it('answers the Adapter shape', async () => {
    const a = await adapter();
    expect(typeof a.invoke).toBe('function');
    expect(typeof a.subscribe).toBe('function');
    expect(a.platform).toBe('linux');
    expect(typeof a.assetUrl).toBe('function');
    expect(typeof a.win?.setTitle).toBe('function');
    expect(typeof a.win?.destroy).toBe('function');
    expect(typeof a.win?.close).toBe('function');
    expect(typeof a.close).toBe('function');
  });

  it('answers nulls for the root, and no_vault for a vault command', async () => {
    const a = await adapter();
    expect(await a.invoke('rootInfo', [])).toEqual({ root: null, name: null, epoch: 1 });
    expect(await a.invoke('vaultInfo', [])).toEqual({ root: null, name: null, remembered: false, source: null, epoch: 1 });
    for (const name of FS_COMMANDS) expect(await code(() => a.invoke(name, ['a.md']))).toBe('no_vault');
    expect(await a.invoke('recentVaults', [])).toEqual([]);
  });

  it('refuses a name nobody answers with unknown_command, as a HostError', async () => {
    const a = await adapter();
    const e = await thrown(() => a.invoke('frobnicate', []));
    expect(e.name).toBe('HostError');
    expect(e.code).toBe('unknown_command');
    expect(e.cmd).toBe('frobnicate');
    expect(e.message).toBe('unknown_command: frobnicate');
  });

  it('answers the local commands in the app scope', async () => {
    const a = await adapter();
    expect(await a.invoke('localGet', ['app'])).toEqual({});
    await a.invoke('localSet', ['app', { sidebar: 3 }]);
    expect(await a.invoke('localGet', ['app'])).toEqual({ sidebar: 3 });
    expect(await a.invoke('log', ['hello'])).toBeNull();
    expect(await a.invoke('draftList', [])).toEqual([]);
    for (const n of LOCAL_COMMANDS) expect(FS_COMMANDS).not.toContain(n);
  });
});

// ------------------------------------------------------------------ pickVault and the vault's commands

describe('adapter: pickVault', () => {
  it('adopts the folder picked: root web:<id>, the epoch one more, remembered, persisted', async () => {
    const { a, r, id } = await picked();
    expect(r).toEqual({ root: `web:${id}`, name: 'Notes', epoch: 2 });
    expect(id).toMatch(ID);
    expect(await a.invoke('rootInfo', [])).toEqual({ root: `web:${id}`, name: 'Notes', epoch: 2 });
    expect(await a.invoke('vaultInfo', [])).toEqual({ root: `web:${id}`, name: 'Notes', remembered: true, source: 'picked', epoch: 2 });
    expect(vh.currentVault()).toBe(id);
    expect(await vh.lastVault()).toBe(id);
    expect(vh.heldVault()).toBe(id);
    expect(/** @type {any} */ (globalThis.navigator).storage.persist).toHaveBeenCalledTimes(1);
    expect(await a.invoke('recentVaults', [])).toEqual([{ path: `web:${id}`, name: 'Notes', exists: true, current: true }]);
  });

  it('answers null when the picker is cancelled', async () => {
    fsa = createFsa();
    cleanups.push(fsa.install());
    fsa.cancel = true;
    const a = await adapter();
    expect(await a.invoke('pickVault', [])).toBeNull();
    expect(await a.invoke('rootInfo', [])).toEqual({ root: null, name: null, epoch: 1 });
    expect(await vh.vaults.list()).toEqual([]);
  });

  it('only chooses with adopt:false', async () => {
    fsa = createFsa({ name: 'Other' });
    cleanups.push(fsa.install());
    const a = await adapter();
    const r = /** @type {any} */ (await a.invoke('pickVault', [{ adopt: false }]));
    expect(r).toEqual({ root: expect.stringMatching(/^web:[0-9a-f]{16}$/), name: 'Other' });
    expect(r.epoch).toBeUndefined();
    expect(await a.invoke('rootInfo', [])).toEqual({ root: null, name: null, epoch: 1 });
    expect(vh.heldVault()).toBeNull();
    // Then adopted by openVault, as the shell does after leaving the old vault.
    expect(await a.invoke('openVault', [r.root])).toEqual({ status: 'adopted', root: r.root, name: 'Other', epoch: 2 });
  });

  it('keeps the id of a folder picked again', async () => {
    const { a, id } = await picked();
    const r = /** @type {any} */ (await a.invoke('pickVault', []));
    expect(r.root).toBe(`web:${id}`);
    expect(r.epoch).toBe(3);
    expect(await vh.vaults.list()).toHaveLength(1);
  });

  it('is unsupported where there is no folder picker', async () => {
    const a = await adapter();
    expect(await code(() => a.invoke('pickVault', []))).toBe('unsupported');
  });

  it('turns what the picker throws into a HostError', async () => {
    vi.stubGlobal('showDirectoryPicker', async () => { throw new DOMException('no gesture', 'SecurityError'); });
    const a = await adapter();
    const e = await thrown(() => a.invoke('pickVault', []));
    expect(e).not.toBeInstanceOf(DOMException);
    expect(e.code).toBe('no_vault');
  });

  it('answers null when another tab holds the folder picked', async () => {
    fsa = createFsa({ name: 'Held' });
    cleanups.push(fsa.install());
    const id = await vh.vaults.add(fsa.root);
    locks.other(`ose-vault:${id}`);
    await Promise.resolve();
    const a = await adapter();
    expect(await a.invoke('pickVault', [])).toBeNull();
    expect(await a.invoke('rootInfo', [])).toEqual({ root: null, name: null, epoch: 1 });
  });
});

describe('adapter: the vault commands, once a vault is open', () => {
  it('reads and saves through fs, a conflict never a blind write', async () => {
    const { a } = await picked();
    const r = /** @type {any} */ (await a.invoke('readFile', ['a.md']));
    expect(r).toMatchObject({ text: '# A\n', encoding: 'UTF-8', bom: false, lossy: false });
    const s = /** @type {any} */ (await a.invoke('saveFile', ['a.md', '# A\n\nmore\n', { expectedHash: r.hash, epoch: 2 }]));
    expect(s.status).toBe('saved');
    expect(fsa.readText('a.md')).toBe('# A\n\nmore\n');
    fsa.write('a.md', 'someone else\n');
    const c = /** @type {any} */ (await a.invoke('saveFile', ['a.md', 'mine\n', { expectedHash: s.hash, epoch: 2 }]));
    expect(c.status).toBe('conflict');
    expect(c.disk.text).toBe('someone else\n');
    expect(fsa.readText('a.md')).toBe('someone else\n');
  });

  it('refuses a write from another epoch with stale_vault', async () => {
    const { a } = await picked();
    expect(await code(() => a.invoke('writeText', ['b.md', 'b', { epoch: 1 }]))).toBe('stale_vault');
    expect(fsa.exists('b.md')).toBe(false);
    await a.invoke('writeText', ['b.md', 'b', { epoch: 2 }]);
    expect(fsa.readText('b.md')).toBe('b');
  });

  it('never lets a DOMException out', async () => {
    const { a } = await picked();
    fsa.fail('getFile', 'a.md', 'NotReadableError');
    const e = await thrown(() => a.invoke('readFile', ['a.md']));
    expect(e.name).toBe('HostError');
    expect(e.code).toBe('io');
    expect(e.cmd).toBe('readFile');
    expect(await code(() => a.invoke('readFile', ['nope.md']))).toBe('not_found');
  });

  it('keeps drafts under the vault id', async () => {
    const { a, id } = await picked();
    await a.invoke('draftWrite', ['a.md', { text: 'typed', baselineHash: null }, { epoch: 2 }]);
    expect((await a.invoke('draftList', [])).map((d) => d.path)).toEqual(['a.md']);
    const keys = (await idb.entries('drafts')).map(([k]) => String(k));
    expect(keys.every((k) => k.startsWith(`${id}/`))).toBe(true);
  });

  it('drafts survive forgetting the vault and picking the same folder again', async () => {
    const { a, id } = await picked();
    await a.invoke('draftWrite', ['a.md', { text: 'typed, never saved', baselineHash: null }, { epoch: 2 }]);
    await a.invoke('forgetVault', [`web:${id}`]);
    const b = await adapter();
    const r = /** @type {any} */ (await b.invoke('pickVault', []));
    expect(vh.idOfRoot(r.root)).toBe(id);
    const epoch = (/** @type {any} */ (await b.invoke('rootInfo', []))).epoch;
    expect((await b.invoke('draftList', [])).map((d) => d.path)).toEqual(['a.md']);
    expect((/** @type {any} */ (await b.invoke('draftRead', ['a.md', { epoch }]))).text).toBe('typed, never saved');
  });

  it('fans the watcher out as the fs event', async () => {
    const { a } = await picked();
    /** @type {any[]} */
    const seen = [];
    a.subscribe((m) => { seen.push(m); });
    await a._state().fs?.requireVault();
    // The observer is started; an outside write is reported after the debounce.
    await new Promise((r) => setTimeout(r, 50));
    fsa.write('from-outside.md', 'x');
    fsa.flush();
    await vi.waitFor(() => {
      const changes = seen.filter((m) => m.event === 'fs').flatMap((m) => m.data.changes || []);
      expect(changes).toContainEqual(expect.objectContaining({ path: 'from-outside.md', kind: 'create' }));
    }, { timeout: 3000 });
  });
});

// ------------------------------------------------------------------ boot, openVault, the lock

describe('adapter: boot', () => {
  it('opens the tab\'s own vault again after a reload', async () => {
    const { a, id } = await picked();
    a.close();
    const b = await adapter();
    expect(await b.invoke('rootInfo', [])).toEqual({ root: `web:${id}`, name: 'Notes', epoch: 2 });
    expect((/** @type {any} */ (await b.invoke('vaultInfo', []))).source).toBe('picked');
  });

  it('opens the last vault in a new tab, as remembered', async () => {
    const { a, id } = await picked();
    a.close();
    vh.resetTab();
    const b = await adapter();
    expect(await b.invoke('rootInfo', [])).toEqual({ root: `web:${id}`, name: 'Notes', epoch: 1 });
    expect((/** @type {any} */ (await b.invoke('vaultInfo', []))).source).toBe('remembered');
  });

  it('opens the vault named on the URL, and none with ?vault=none', async () => {
    fsa = createFsa({ name: 'Named' });
    const id = await vh.vaults.add(fsa.root);
    browser({ url: `https://ose.test/app/?vault=${id}` });
    const a = await adapter();
    expect((/** @type {any} */ (await a.invoke('rootInfo', []))).root).toBe(`web:${id}`);
    a.close();
    vh.resetTab();
    await vh.setLastVault(id);
    browser({ url: 'https://ose.test/app/?vault=none' });
    const b = await adapter();
    expect((/** @type {any} */ (await b.invoke('rootInfo', []))).root).toBeNull();
  });

  it('opens nothing without permission; openVault asks, in the gesture', async () => {
    fsa = createFsa({ name: 'Asked' });
    const id = await vh.vaults.add(fsa.root);
    await vh.setLastVault(id);
    fsa.permission.permission = 'prompt';
    const a = await adapter();
    expect((/** @type {any} */ (await a.invoke('rootInfo', []))).root).toBeNull();
    expect(fsa.permission.requests).toBe(0);
    fsa.permission.answer = 'denied';
    expect(await code(() => a.invoke('openVault', [`web:${id}`]))).toBe('no_vault');
    fsa.permission.permission = 'prompt';
    fsa.permission.answer = 'granted';
    expect(await a.invoke('openVault', [`web:${id}`])).toEqual({ status: 'adopted', root: `web:${id}`, name: 'Asked', epoch: 2 });
    expect((/** @type {any} */ (await a.invoke('vaultInfo', []))).source).toBe('opened');
    expect(fsa.permission.requests).toBe(2);
  });

  it('opens nothing when another tab holds the vault', async () => {
    fsa = createFsa({ name: 'Busy' });
    const id = await vh.vaults.add(fsa.root);
    await vh.setLastVault(id);
    const release = locks.other(`ose-vault:${id}`);
    await Promise.resolve();
    const a = await adapter();
    expect((/** @type {any} */ (await a.invoke('rootInfo', []))).root).toBeNull();
    expect(await a.invoke('openVault', [`web:${id}`])).toEqual({ status: 'focused', label: 'tab' });
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect((/** @type {any} */ (await a.invoke('openVault', [`web:${id}`]))).status).toBe('adopted');
  });

  it('forgets a tab vault that is no longer known', async () => {
    vh.setCurrentVault('0123456789abcdef');
    const a = await adapter();
    expect((/** @type {any} */ (await a.invoke('rootInfo', []))).root).toBeNull();
    expect(vh.currentVault()).toBeNull();
  });

  it('refuses openVault of a root it does not know', async () => {
    const a = await adapter();
    expect(await code(() => a.invoke('openVault', ['web:0123456789abcdef']))).toBe('not_found');
    expect(await code(() => a.invoke('openVault', ['C:\\Users\\me\\notes']))).toBe('not_found');
  });

  it('switches vaults in one tab: the new lock, the old one let go, the epoch one more', async () => {
    const { a, id } = await picked();
    const two = createFsa({ name: 'Two' });
    const id2 = await vh.vaults.add(two.root);
    expect(await a.invoke('openVault', [`web:${id2}`])).toEqual({ status: 'adopted', root: `web:${id2}`, name: 'Two', epoch: 3 });
    await new Promise((r) => setTimeout(r, 0));
    expect(locks.taken.has(`ose-vault:${id}`)).toBe(false);
    expect(locks.taken.has(`ose-vault:${id2}`)).toBe(true);
    expect((await a.invoke('recentVaults', [])).map((v) => [v.name, v.current])).toEqual([['Two', true], ['Notes', false]]);
  });
});

// ------------------------------------------------------------------ the other app commands

describe('adapter: windows and the recent list', () => {
  it('opens a vault in a new tab, or a tab with none', async () => {
    const { a, id } = await picked();
    expect(await a.invoke('openVaultWindow', [`web:${id}`])).toEqual({ label: 'tab', created: true });
    expect(tab.opened.at(-1)?.url).toBe(`https://ose.test/app/?vault=${id}`);
    expect(await a.invoke('openVaultWindow', [])).toEqual({ label: 'tab', created: true });
    expect(tab.opened.at(-1)?.url).toBe('https://ose.test/app/?vault=none');
    expect(await code(() => a.invoke('openVaultWindow', ['web:0123456789abcdef']))).toBe('not_found');
    tab.blockPopups = true;
    expect(await code(() => a.invoke('openVaultWindow', []))).toBe('unsupported');
  });

  it('forgets one vault, or only the remembered root', async () => {
    const { a, id } = await picked();
    expect(await a.invoke('forgetVault', [])).toBeNull();
    expect(await vh.lastVault()).toBeNull();
    expect(await vh.vaults.get(id)).not.toBeNull();
    expect(await a.invoke('forgetVault', [`web:${id}`])).toBeNull();
    expect(await vh.vaults.get(id)).toBeNull();
    expect(await a.invoke('recentVaults', [])).toEqual([]);
    expect((/** @type {any} */ (await a.invoke('vaultInfo', []))).remembered).toBe(false);
    expect(await a.invoke('forgetVault', ['not a root'])).toBeNull();
  });

  it('lists at most ten recent vaults', async () => {
    for (let i = 0; i < 14; i++) await vh.vaults.add(createFsa({ name: `V${i}` }).root, i);
    const a = await adapter();
    const list = /** @type {any[]} */ (await a.invoke('recentVaults', []));
    expect(list).toHaveLength(10);
    expect(list[0]).toEqual({ path: expect.stringMatching(/^web:/), name: 'V13', exists: true, current: false });
  });
});

describe('adapter: platform, quit, print', () => {
  it('describes itself as the host does', async () => {
    const { a, id } = await picked();
    expect(await a.invoke('platform', [])).toEqual({
      os: 'linux', version: 'dev', exe: '', exeDir: null, root: `web:${id}`, logPath: 'IndexedDB: ose-web/log', build: null, dragIcon: null,
    });
    // No desktop verbs: quitting, a native PDF export, showing a file in the file manager.
    expect(await code(() => a.invoke('quit', []))).toBe('unknown_command');
    expect(await code(() => a.invoke('printToPdf', [null, {}]))).toBe('unknown_command');
    expect(await code(() => a.invoke('reveal', ['a.md']))).toBe('unknown_command');
  });

  it('tells the OS from the client hints or the user agent', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'Windows' }, userAgent: 'x' });
    expect(detectOs()).toBe('windows');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' });
    expect(detectOs()).toBe('macos');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
    expect(detectOs()).toBe('linux');
  });
});

describe('adapter: links and files for the system', () => {
  it('opens http, https and mailto only', async () => {
    const a = await adapter();
    expect(await a.invoke('openExternal', ['https://example.org/x'])).toBeNull();
    expect(tab.opened.at(-1)).toEqual({ url: 'https://example.org/x', name: '_blank', features: 'noopener' });
    expect(await a.invoke('openExternal', ['mailto:a@b.c'])).toBeNull();
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ose://x', 'not a url']) {
      expect(await code(() => a.invoke('openExternal', [bad]))).toBe('bad_arg');
    }
  });

  it('opens a picture in a tab from a blob URL, never a program', async () => {
    const { a } = await picked();
    const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:https://ose.test/1');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    expect(await a.invoke('openPath', ['img/p.png'])).toBeNull();
    expect(tab.opened.at(-1)?.url).toBe('blob:https://ose.test/1');
    const blob = /** @type {Blob} */ (made.mock.calls[0]?.[0]);
    expect(blob.type).toBe('image/png');
    vi.advanceTimersByTime(60_000);
    expect(revoked).toHaveBeenCalledWith('blob:https://ose.test/1');
    vi.useRealTimers();
    for (const p of ['run.exe', 'x.bat', 'page.html', 'pic.svg', 'tool.js']) expect(await code(() => a.invoke('openPath', [p]))).toBe('unsupported');
    expect(await code(() => a.invoke('openPath', ['data.bin']))).toBe('unsupported');
    expect(await code(() => a.invoke('openPath', ['missing.png']))).toBe('not_found');
    tab.blockPopups = true;
    expect(await code(() => a.invoke('openPath', ['img/p.png']))).toBe('unsupported');
    expect(revoked).toHaveBeenCalledTimes(2);
    expect(OPENABLE.get('md')).toMatch(/^text\/plain/);
  });

  it('opens a registered outside file, and refuses one it never saw', async () => {
    const a = await adapter();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const f = createFsa({ files: { 'doc.pdf': '%PDF' } });
    const p = await vh.outside.register(f.handle('doc.pdf'));
    expect(await a.invoke('openPath', [p])).toBeNull();
    expect(await code(() => a.invoke('openPath', ['abs:/web/0123456789abcdef/doc.pdf']))).toBe('not_registered');
    expect(await code(() => a.invoke('openPath', ['doc.pdf']))).toBe('no_vault');
  });
});

describe('adapter: files outside the vault', () => {
  it('picks a file, registers it and answers its abs: path', async () => {
    fsa = createFsa();
    cleanups.push(fsa.install());
    const other = createFsa({ files: { 'far.md': 'far' }, name: 'Elsewhere' });
    fsa.pickFiles = [other.handle('far.md')];
    const a = await adapter();
    const p = /** @type {string} */ (await a.invoke('pickFile', [{ title: 'Open' }]));
    expect(p).toMatch(/^abs:\/web\/[0-9a-f]{16}\/far\.md$/);
    expect(await a.invoke('pickFile', [])).toBe(p);
    fsa.cancel = true;
    expect(await a.invoke('pickFile', [])).toBeNull();
  });

  it('is unsupported where there is no file picker', async () => {
    const a = await adapter();
    expect(await code(() => a.invoke('pickFile', []))).toBe('unsupported');
  });

  it('opens a registered file outside, and a file inside the vault as its vault path', async () => {
    const { a } = await picked({ 'notes/in.md': 'in' });
    const other = createFsa({ files: { 'far.md': 'far' } });
    const far = await vh.outside.register(other.handle('far.md'));
    expect(await a.invoke('outsideOpen', [far])).toEqual({ path: far, inside: false, name: 'far.md', exists: true, kind: 'file' });
    expect(await a.invoke('outsideOpen', [far])).toEqual({ path: far, inside: false, name: 'far.md', exists: true, kind: 'file' });
    const inner = await vh.outside.register(fsa.handle('notes/in.md'));
    expect(await a.invoke('outsideOpen', [inner])).toEqual({ path: 'notes/in.md', inside: true, name: 'in.md', exists: true, kind: 'file' });
    // The file removed since: known, not there.
    other.remove('far.md');
    expect(await a.invoke('outsideOpen', [far])).toEqual({ path: far, inside: false, name: 'far.md', exists: false, kind: null });
    // A native path, and an abs: one this browser never saw.
    expect(await code(() => a.invoke('outsideOpen', ['C:\\Users\\me\\x.md']))).toBe('unsupported');
    expect(await code(() => a.invoke('outsideOpen', ['abs:/home/me/x.md']))).toBe('unsupported');
    expect(await code(() => a.invoke('outsideOpen', ['abs:/web/0123456789abcdef/x.md']))).toBe('not_found');
  });

  it('asks permission again for an outside file, and says so when refused', async () => {
    const a = await adapter();
    const other = createFsa({ files: { 'far.md': 'far' } });
    const far = await vh.outside.register(other.handle('far.md'));
    other.permission.permission = 'prompt';
    other.permission.answer = 'denied';
    expect(await code(() => a.invoke('outsideOpen', [far]))).toBe('no_vault');
    other.permission.permission = 'prompt';
    other.permission.answer = 'granted';
    expect((/** @type {any} */ (await a.invoke('outsideOpen', [far]))).exists).toBe(true);
  });
});

describe('adapter: OS opens (launchQueue)', () => {
  it('queues the files of a launch until takeOpens, then sends the open event', async () => {
    browser({ launchQueue: true });
    const { a } = await picked({ 'in.md': 'in' });
    const lq = /** @type {any} */ (globalThis).launchQueue;
    expect(typeof lq.consumer).toBe('function');
    const other = createFsa({ files: { 'far.md': 'far' } });
    lq.consumer({ files: [other.handle('far.md'), fsa.handle('in.md')] });
    const first = /** @type {any[]} */ (await a.invoke('takeOpens', []));
    expect(first).toEqual([
      { path: expect.stringMatching(/^abs:\/web\/[0-9a-f]{16}\/far\.md$/), outside: true, kind: 'file' },
      { path: 'in.md', outside: false, kind: 'file' },
    ]);
    expect(await a.invoke('takeOpens', [])).toEqual([]);
    /** @type {any[]} */
    const seen = [];
    a.subscribe((m) => { if (m.event === 'open') seen.push(m.data); });
    lq.consumer({ files: [fsa.handle('in.md')] });
    await vi.waitFor(() => expect(seen).toEqual([{ requests: [{ path: 'in.md', outside: false, kind: 'file' }] }]));
  });

  it('adds a folder handed over to the recent vaults, and opens nothing for it', async () => {
    browser({ launchQueue: true });
    const a = await adapter();
    const lq = /** @type {any} */ (globalThis).launchQueue;
    const folder = createFsa({ name: 'Dropped' });
    lq.consumer({ files: [folder.root] });
    expect(await a.invoke('takeOpens', [])).toEqual([]);
    expect((await a.invoke('recentVaults', [])).map((v) => v.name)).toEqual(['Dropped']);
  });
});

// ------------------------------------------------------------------ what is not a host command

describe('adapter: assetUrl', () => {
  it('names the worker\'s vault/ form', async () => {
    const { a, id } = await picked();
    expect(a.assetUrl('img/p.png')).toBe(`https://ose.test/app/vault/${id}/img/p.png`);
    expect(a.assetUrl('./a b/c#d.png')).toBe(`https://ose.test/app/vault/${id}/a%20b/c%23d.png`);
    const out = `abs:/web/${id}/pic 1.png`;
    expect(a.assetUrl(out)).toBe(`https://ose.test/app/vault/~abs/${id}/pic%201.png`);
  });

  it('is relative without a base, and has a placeholder with no vault', () => {
    expect(assetUrlFor('0123456789abcdef', '/x/y.png')).toBe('./vault/0123456789abcdef/x/y.png');
    expect(assetUrlFor(null, 'y.png')).toBe('./vault/_/y.png');
    expect(assetUrlFor('0123456789abcdef', 'y.png', 'https://h.test/sub/')).toBe('https://h.test/sub/vault/0123456789abcdef/y.png');
  });
});

describe('adapter: the window', () => {
  it('sets the tab title and closes the tab', async () => {
    const a = await adapter();
    a.win?.setTitle?.('a.md — Notes');
    expect(tab.document.title).toBe('a.md — Notes');
    expect(a.win?.destroy?.()).toBeNull();
    expect(tab.closeCalls).toBe(1);
  });

  it('closes through the closing handlers, and a false keeps the tab', async () => {
    const a = await adapter();
    let answer = /** @type {unknown} */ (true);
    /** @type {any[]} */
    const got = [];
    a.subscribe((m) => {
      got.push(m);
      if (m.event === 'window' && m.data.closing) return Promise.resolve(answer);
      return undefined;
    });
    answer = false;
    expect(await a.win?.close?.()).toBe(false);
    expect(tab.closeCalls).toBe(0);
    expect(got).toEqual([{ event: 'window', data: { closing: true } }]);
    answer = undefined;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    expect(await a.win?.close?.()).toBe(true);
    expect(tab.closeCalls).toBe(1);
    // Chrome kept a tab it did not open: it boots again, never stays on a torn-down view.
    vi.advanceTimersByTime(600);
    expect(tab.reloads).toBe(1);
  });

  it('asks "Leave site?" only while a write is in flight', async () => {
    const { a } = await picked();
    const leave = () => {
      const ev = new Event('beforeunload', { cancelable: true });
      tab.target.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(leave()).toBe(false);
    /** @type {() => void} */
    let go = () => {};
    const gate = new Promise((r) => { go = () => r(undefined); });
    const real = a._state().fs;
    const orig = real?.writeText;
    if (real) real.writeText = async (...args) => { await gate; return orig?.(...args); };
    const w = a.invoke('writeText', ['w.md', 'w', { epoch: 2 }]);
    expect(leave()).toBe(true);
    go();
    await w;
    expect(leave()).toBe(false);
    a.close();
    expect(leave()).toBe(false);
  });
});

describe('adapter: the service worker\'s questions', () => {
  /** @param {any} data @returns {Promise<any>} */
  function ask(data) {
    const ch = new MessageChannel();
    return new Promise((resolve) => {
      ch.port1.onmessage = (ev) => { resolve(ev.data); ch.port1.close(); };
      swc.dispatchEvent(new MessageEvent('message', { data, ports: [ch.port2] }));
    });
  }

  it('answers a vault file, and 404 for an excluded or missing one', async () => {
    const { id } = await picked({ 'img/p.png': 'PNG', '.ose/state.json': '{}' });
    const r = await ask({ type: 'ose-vault-read', outside: false, vault: id, path: 'img/p.png' });
    expect(r.ok).toBe(true);
    expect(await r.file.text()).toBe('PNG');
    expect(await ask({ type: 'ose-vault-read', outside: false, vault: id, path: '.ose/state.json' })).toEqual({ ok: false, status: 404 });
    expect(await ask({ type: 'ose-vault-read', outside: false, vault: id, path: 'none.png' })).toEqual({ ok: false, status: 404 });
    expect(await ask({ type: 'ose-vault-read', outside: false, vault: 'ffffffffffffffff', path: 'img/p.png' })).toEqual({ ok: false, status: 404 });
  });

  it('answers an outside file by id and name', async () => {
    await adapter();
    const other = createFsa({ files: { 'o.png': 'O' } });
    const p = await vh.outside.register(other.handle('o.png'));
    const { id, name } = /** @type {any} */ (vh.parseOutside(p));
    const r = await ask({ type: 'ose-vault-read', outside: true, id, name });
    expect(await r.file.text()).toBe('O');
    expect(await ask({ type: 'ose-vault-read', outside: true, id, name: 'x.png' })).toEqual({ ok: false, status: 404 });
  });
});

// ------------------------------------------------------------------ sw.js, the manifest, the build

describe('sw.js: the vault/ origin', () => {
  it('parses the two forms and refuses what must not be served', () => {
    const id = '0123456789abcdef';
    expect(parseVaultPath(`${id}/img/a%20b.png`)).toEqual({ outside: false, vault: id, id: '', name: 'a b.png', path: 'img/a b.png', segs: ['img', 'a b.png'] });
    expect(parseVaultPath(`~abs/${id}/x.pdf`)).toEqual({ outside: true, vault: '', id, name: 'x.pdf', path: '', segs: [] });
    for (const bad of [`${id}`, `${id}/../x.png`, `${id}/.ose/state.json`, `${id}/a/.git/HEAD`, `${id}/a.md.crswap`, `${id}/a%2Fb.png`,
      'nothex/a.png', `~abs/${id}`, `~abs/${id}/a/b`, `~abs/zz/a.png`, `${id}/%E0%A4%A`]) {
      expect(parseVaultPath(bad)).toBeNull();
    }
  });

  it('serves nothing the hide rule excludes, as rules.js says', () => {
    const id = '0123456789abcdef';
    const paths = ['.trash/.info/1-a.md.json', '.Trash/.INFO/x', 'ose.exe', 'OSE.EXE', 'webview2loader.dll', 'os-update-tmp/x',
      'notes/~$doc.docx', 'notes/.~lock.a.odt#', 'notes/.a.md.12.3.tmp', 'notes/.a.md.12.case', 'a.md.crswap', '.git/HEAD', 'x/.OSE/y',
      'notes/ose.exe', '.trash/1-a.md', 'notes/a.md', '.hidden/a.png', 'img/p.svg'];
    for (const p of paths) {
      expect(excludedSegs(p.split('/'))).toBe(isExcluded(p));
      expect(parseVaultPath(`${id}/${p}`) === null).toBe(isExcluded(p));
    }
    expect(parseVaultPath(`${id}/.trash/.info/1-a.md.json`)).toBeNull();
    expect(parseVaultPath(`${id}/ose.exe`)).toBeNull();
    expect(parseVaultPath(`${id}/notes/ose.exe`)).not.toBeNull();
  });

  it('sandboxes active content and never lets a type be sniffed, as protocol.rs does', () => {
    const f = new Blob(['<script>1</script>']);
    for (const name of ['a.html', 'a.HTM', 'a.xhtml', 'a.svg', 'a.xml', 'a.xsl']) {
      const r = fileResponse(f, name, null);
      expect(r.headers.get('content-security-policy')).toBe('sandbox');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(fileResponse(f, name, 'bytes=0-3').headers.get('content-security-policy')).toBe('sandbox');
    }
    const pdf = fileResponse(new Blob(['%PDF-1.4']), 'b.pdf', null);
    expect(pdf.headers.get('content-security-policy')).toBeNull();
    expect(pdf.headers.get('x-content-type-options')).toBe('nosniff');
    expect(fileResponse(new Blob(['x']), 'b.png', 'bytes=9-').headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('precaches past the HTTP cache, so a new build never takes an old build\'s files', () => {
    const reqs = precacheRequests(['index.html', 'ose/core.js'], 'https://ose.test/app/');
    expect(reqs.map((r) => r.url)).toEqual(['https://ose.test/app/index.html', 'https://ose.test/app/ose/core.js']);
    expect(reqs.every((r) => r.cache === 'reload')).toBe(true);
    // The worker's install uses them.
    const src = readFileSync(path.join(REPO, 'src/host/sw.js'), 'utf8');
    expect(src).toContain('cache.addAll(precacheRequests(FILES, sw.registration.scope))');
  });

  it('answers a Range with 206, a bad one with 416, and none with the whole file', async () => {
    const f = new Blob(['0123456789']);
    const whole = fileResponse(f, 'a.png', null);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('image/png');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(await whole.text()).toBe('0123456789');
    const part = fileResponse(f, 'v.mp4', 'bytes=2-5');
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(part.headers.get('content-type')).toBe('video/mp4');
    expect(await part.text()).toBe('2345');
    expect(await fileResponse(f, 'v.mp4', 'bytes=7-').text()).toBe('789');
    expect(await fileResponse(f, 'v.mp4', 'bytes=-3').text()).toBe('789');
    expect(fileResponse(f, 'v.mp4', 'bytes=4-100').headers.get('content-range')).toBe('bytes 4-9/10');
    const bad = fileResponse(f, 'v.mp4', 'bytes=20-30');
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */10');
    expect(fileResponse(f, 'x.unknown', null).headers.get('content-type')).toBe('application/octet-stream');
  });
});

describe('the manifest and the web build', () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO, 'web/manifest.webmanifest'), 'utf8'));

  it('declares an installable app with .md and .txt handlers', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    const accept = manifest.file_handlers[0].accept;
    expect(Object.values(accept).flat()).toEqual(expect.arrayContaining(['.md', '.txt']));
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['256x256', '512x512']));
  });

  it('has the icons the manifest names', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO, 'web/manifest.webmanifest'), 'utf8'));
    for (const icon of manifest.icons) expect(existsSync(path.join(REPO, 'web', icon.src)), icon.src).toBe(true);
  });

  it('writes the precache list and a content build id into the worker', () => {
    const dir = path.join(REPO, 'web');
    const one = workerSource(['manifest.webmanifest'], dir);
    expect(one.build).toMatch(ID);
    expect(one.source).toContain(`const MANIFEST = {"build":"${one.build}","files":["manifest.webmanifest"]};`);
    expect(one.source).not.toContain('@ose-manifest');
    expect(workerSource(['manifest.webmanifest'], dir).build).toBe(one.build);
  });

  it('puts the desktop\'s policy into the page, before the import map, which it allows by hash', () => {
    const shell = readFileSync(path.join(REPO, 'shell/index.html'), 'utf8');
    const html = withCsp(withManifestLink(shell));
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
    expect(meta).not.toBeNull();
    const csp = /** @type {RegExpExecArray} */ (meta)[1] || '';
    expect(html.indexOf(/** @type {RegExpExecArray} */ (meta)[0])).toBeLessThan(html.indexOf('<script type="importmap">'));
    const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(shell)?.[1] || '';
    const sha = createHash('sha256').update(map).digest('base64');
    expect(csp).toContain(`script-src 'self' 'sha256-${sha}'`);
    for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "connect-src 'self' data: blob:"]) {
      expect(csp).toContain(d);
    }
    expect(csp).not.toMatch(/https?:|'unsafe-eval'|\*/);
    expect(withCsp(html)).toBe(html);
  });

  it('links the manifest into the page once', () => {
    const html = '<html><head><title>Ose</title></head><body></body></html>';
    const once = withManifestLink(html);
    expect(once).toContain('<link rel="manifest" href="./manifest.webmanifest">\n</head>');
    expect(withManifestLink(once)).toBe(once);
  });
});
