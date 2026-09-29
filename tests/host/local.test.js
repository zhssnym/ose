// Module local of Ose Web (src/host/local.js): drafts, the local store and the log over idb.js's
// memory backend, against the semantics of drafts.rs, local.rs and dev/files.mjs.

import { beforeEach, describe, expect, it } from 'vitest';
import * as idb from '../../src/host/idb.js';
import { createLocal, LOG_MAX } from '../../src/host/local.js';
import { hash } from '../../src/host/rules.js';

const VAULT = '0123456789abcdef';
const OTHER = 'fedcba9876543210';

/** A clock the test moves. */
function clock(start = 1000) {
  let t = start;
  const now = () => t;
  now.tick = (n = 1) => { t += n; return t; };
  return now;
}

/** @param {() => Promise<unknown>} fn */
async function code(fn) {
  try { await fn(); } catch (e) { return /** @type {any} */ (e).code; }
  return 'resolved';
}

/** @param {Partial<import('../../src/host/local.js').LocalOpts>} [o] */
function make(o = {}, key = VAULT) {
  const now = clock();
  let epoch = 1;
  /** @type {{ path: string, text: string, o: any }[]} */
  const kept = [];
  const local = createLocal(key, {
    epoch: () => epoch,
    now,
    console: null,
    keepVersion: async (path, bytes, opt) => { kept.push({ path, text: new TextDecoder().decode(bytes), o: opt }); return { kept: true }; },
    ...o,
  });
  return { local, now, kept, setEpoch: (n) => { epoch = n; } };
}

beforeEach(() => { idb.useMemory(); idb.resetMemory(); });

describe('drafts', () => {
  it('writes, reads and stores the draft as drafts.rs does', async () => {
    const { local } = make();
    const r = await local.draftWrite('/notes\\a.md/', { text: 'héllo', baselineHash: 'af63dc4c8601ec8c', mode: 'live', exact: false, rev: 7 });
    expect(r).toEqual({ at: 1000 });
    expect(await local.draftRead('notes/a.md')).toEqual({ path: 'notes/a.md', text: 'héllo', baselineHash: 'af63dc4c8601ec8c', mode: 'live', exact: false, rev: 7, at: 1000 });
    const stored = await idb.get('drafts', `${VAULT}/${hash('notes/a.md')}`);
    expect(stored).toEqual({ v: 1, vault: VAULT, path: 'notes/a.md', text: 'héllo', baselineHash: 'af63dc4c8601ec8c', mode: 'live', exact: false, rev: 7, at: 1000 });
  });

  it('defaults mode, exact, rev and the baseline', async () => {
    const { local } = make();
    await local.draftWrite('a.md', { text: '', baselineHash: 3, mode: 'wysiwyg', exact: 'yes', rev: 'x' });
    expect(await local.draftRead('a.md')).toMatchObject({ text: '', baselineHash: null, mode: 'rich', exact: true, rev: 0 });
    await local.draftWrite('b.md', { text: 's', mode: 'source' });
    expect((await local.draftRead('b.md'))?.mode).toBe('source');
  });

  it('refuses what is not a draft', async () => {
    const { local } = make();
    expect(await code(() => local.draftWrite('a.md', null))).toBe('bad_arg');
    expect(await code(() => local.draftWrite('a.md', 'text'))).toBe('bad_arg');
    expect(await code(() => local.draftWrite('a.md', { rev: 1 }))).toBe('bad_arg');
    expect(await code(() => local.draftWrite('a.md', { text: 5 }))).toBe('bad_arg');
    expect(await code(() => local.draftWrite(/** @type {any} */ (3), { text: '' }))).toBe('bad_arg');
    expect(await code(() => local.draftWrite('', { text: '' }))).toBe('bad_arg');
    expect(await code(() => local.draftWrite('abs:', { text: '' }))).toBe('bad_arg');
    expect(await local.draftList()).toEqual([]);
  });

  it('reads null when there is none', async () => {
    const { local } = make();
    expect(await local.draftRead('none.md')).toBeNull();
    await idb.put('drafts', { v: 2, text: 'future' }, `${VAULT}/${hash('odd.md')}`);
    expect(await local.draftRead('odd.md')).toBeNull();
  });

  it('files outside drafts under `outside`, by the abs: path as it is', async () => {
    const { local } = make();
    const p = 'abs:/web/0011223344556677/Notes.md';
    await local.draftWrite(p, { text: 'out', rev: 2 });
    expect(await idb.get('drafts', `outside/${hash(p)}`)).toMatchObject({ vault: 'outside', path: p, text: 'out' });
    expect(await local.draftRead(p)).toMatchObject({ path: p, text: 'out', rev: 2 });
    expect((await local.draftDrop(p)).dropped).toBe(true);
  });

  it('lists this vault and the outside files, newest first, without text', async () => {
    const { local, now } = make();
    await local.draftWrite('a.md', { text: 'aa', rev: 1 });
    now.tick();
    await local.draftWrite('abs:/web/1/x.md', { text: 'é', rev: 2 });
    now.tick();
    await local.draftWrite('b/c.md', { text: 'ccc', mode: 'source' });
    const other = createLocal(OTHER, { now, console: null });
    await other.draftWrite('z.md', { text: 'not ours' });
    await idb.put('drafts', { v: 1, path: 'junk', text: '' }, `${VAULT}/not-a-hash`);
    const list = await local.draftList();
    expect(list).toEqual([
      { path: 'b/c.md', baselineHash: null, mode: 'source', exact: true, rev: 0, at: 1002, bytes: 3 },
      { path: 'abs:/web/1/x.md', baselineHash: null, mode: 'rich', exact: true, rev: 2, at: 1001, bytes: 2 },
      { path: 'a.md', baselineHash: null, mode: 'rich', exact: true, rev: 1, at: 1000, bytes: 2 },
    ]);
    expect((await other.draftList()).map((d) => d.path)).toEqual(['z.md', 'abs:/web/1/x.md']);
  });

  it('drops only a draft at or before ifRev', async () => {
    const { local } = make();
    expect(await local.draftDrop('a.md')).toEqual({ dropped: false });
    await local.draftWrite('a.md', { text: 't', rev: 5 });
    expect(await local.draftDrop('a.md', { ifRev: 4 })).toEqual({ dropped: false });
    expect(await local.draftRead('a.md')).not.toBeNull();
    expect(await local.draftDrop('a.md', { ifRev: 5 })).toEqual({ dropped: true });
    expect(await local.draftRead('a.md')).toBeNull();
    await local.draftWrite('b.md', { text: 't', rev: 9 });
    expect(await local.draftDrop('b.md')).toEqual({ dropped: true });
  });

  it('runs one draft command at a time: a drop never removes a draft written after it was asked', async () => {
    const { local } = make();
    await local.draftWrite('a.md', { text: 'old', rev: 1 });
    const w = local.draftWrite('a.md', { text: 'new', rev: 2 });
    const d = local.draftDrop('a.md', { ifRev: 1 });
    await Promise.all([w, d]);
    expect(await d).toEqual({ dropped: false });
    expect((await local.draftRead('a.md'))?.text).toBe('new');
  });

  it('refuses a stale epoch on a vault draft, not on an outside one', async () => {
    const { local, setEpoch } = make();
    setEpoch(2);
    expect(await code(() => local.draftWrite('a.md', { text: 'x' }, { epoch: 1 }))).toBe('stale_vault');
    expect(await code(() => local.draftDrop('a.md', { epoch: 1 }))).toBe('stale_vault');
    expect(await local.draftWrite('a.md', { text: 'x' }, { epoch: 2 })).toEqual({ at: 1000 });
    expect(await local.draftWrite('abs:/web/1/x.md', { text: 'x' }, { epoch: 1 })).toEqual({ at: 1000 });
  });

  it('with no vault: a vault path is no_vault, the outside drafts still work', async () => {
    const { local: withVault } = make();
    await withVault.draftWrite('abs:/web/1/x.md', { text: 'x' });
    await withVault.draftWrite('a.md', { text: 'a' });
    const { local } = make({}, /** @type {any} */ (null));
    expect(await code(() => local.draftWrite('a.md', { text: 'x' }))).toBe('no_vault');
    expect(await code(() => local.draftRead('a.md'))).toBe('no_vault');
    expect(await code(() => local.draftDrop('a.md'))).toBe('no_vault');
    expect((await local.draftList()).map((d) => d.path)).toEqual(['abs:/web/1/x.md']);
    expect(await local.draftRead('abs:/web/1/x.md')).toMatchObject({ text: 'x' });
  });

  it('turns a failed store into write_failed, and a failed read into none', async () => {
    const quota = () => Promise.reject(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }));
    const store = { ...idb, put: quota, get: quota };
    const { local } = make({ store });
    const err = await local.draftWrite('a.md', { text: 't' }).catch((e) => e);
    expect([err.code, err.message]).toEqual(['write_failed', 'draft: quota']);
    expect(await local.draftRead('a.md')).toBeNull();
    expect(await code(() => local.localSet('app', {}))).toBe('write_failed');
    expect(await local.localGet('app')).toEqual({});
    expect(await local.log('never fails')).toBeNull();
    // The gate is not stuck by a failure.
    expect(await local.draftDrop('a.md')).toEqual({ dropped: false });
  });
});

describe('rekeyDrafts', () => {
  it('moves a file draft', async () => {
    const { local } = make();
    await local.draftWrite('a.md', { text: 'aa', rev: 3 });
    await local.rekeyDrafts('a.md', 'b/a.md');
    expect(await local.draftRead('a.md')).toBeNull();
    expect(await local.draftRead('b/a.md')).toMatchObject({ path: 'b/a.md', text: 'aa', rev: 3 });
    expect((await local.draftList()).length).toBe(1);
  });

  it('moves every draft under a folder, and nothing beside it', async () => {
    const { local } = make();
    await local.draftWrite('f/a.md', { text: '1' });
    await local.draftWrite('f/g/b.md', { text: '2' });
    await local.draftWrite('fx/c.md', { text: '3' });
    await local.draftWrite('abs:/web/1/f/a.md', { text: '4' });
    await local.rekeyDrafts('f', 'h');
    expect((await local.draftList()).map((d) => d.path).sort()).toEqual(['abs:/web/1/f/a.md', 'fx/c.md', 'h/a.md', 'h/g/b.md']);
  });

  it('leaves another vault and the same path alone', async () => {
    const { local, now } = make();
    const other = createLocal(OTHER, { now, console: null });
    await other.draftWrite('a.md', { text: 'theirs' });
    await local.draftWrite('a.md', { text: 'ours' });
    await local.rekeyDrafts('a.md', 'a.md');
    await local.rekeyDrafts('a.md', 'b.md');
    expect((await other.draftRead('a.md'))?.text).toBe('theirs');
    expect((await local.draftRead('b.md'))?.text).toBe('ours');
  });

  it('onto a path with a draft keeps both texts: the newer the draft, the older a version', async () => {
    const { local, now, kept } = make();
    await local.draftWrite('gone.md', { text: 'recovered', rev: 1 });
    now.tick();
    await local.draftWrite('moving.md', { text: 'typing', rev: 1 });
    await local.rekeyDrafts('moving.md', 'gone.md');
    expect((await local.draftRead('gone.md'))?.text).toBe('typing');
    expect(await local.draftRead('moving.md')).toBeNull();
    expect(kept).toEqual([{ path: 'gone.md', text: 'recovered', o: { force: true, reason: 'conflict' } }]);

    now.tick();
    await local.draftWrite('old.md', { text: 'older' });
    now.tick();
    await local.draftWrite('new.md', { text: 'newer' });
    await local.rekeyDrafts('old.md', 'new.md');
    expect((await local.draftRead('new.md'))?.text).toBe('newer');
    expect(await local.draftRead('old.md')).toBeNull();
    expect(kept[1]).toEqual({ path: 'new.md', text: 'older', o: { force: true, reason: 'conflict' } });
  });

  it('keeps both drafts where they are when the version cannot be kept', async () => {
    const lines = [];
    const { local, now } = make({ keepVersion: async () => { throw new Error('no vault folder'); } });
    await local.draftWrite('x.md', { text: 'x' });
    now.tick();
    await local.draftWrite('y.md', { text: 'y' });
    await local.rekeyDrafts('y.md', 'x.md');
    expect((await local.draftRead('x.md'))?.text).toBe('x');
    expect((await local.draftRead('y.md'))?.text).toBe('y');
    lines.push(...(await local.logLines()));
    expect(lines.some((l) => / warn drafts: y\.md -> x\.md: both drafts stay/.test(l))).toBe(true);
  });

  it('without keepVersion a collision keeps both too', async () => {
    const local = createLocal(VAULT, { console: null });
    await local.draftWrite('x.md', { text: 'x' });
    await local.draftWrite('y.md', { text: 'y' });
    await local.rekeyDrafts('y.md', 'x.md');
    expect((await local.draftRead('x.md'))?.text).toBe('x');
    expect((await local.draftRead('y.md'))?.text).toBe('y');
  });
});

describe('the local store', () => {
  it('answers {} when there is none, and what was set', async () => {
    const { local } = make();
    expect(await local.localGet('app')).toEqual({});
    expect(await local.localGet('vault')).toEqual({});
    expect(await local.localSet('app', { recent: ['a.md'], n: 1 })).toBeNull();
    expect(await local.localSet('vault', { sidebar: { w: 240 } })).toBeNull();
    expect(await local.localGet('app')).toEqual({ recent: ['a.md'], n: 1 });
    expect(await local.localGet('vault')).toEqual({ sidebar: { w: 240 } });
    expect(await idb.get('local', `vault:${VAULT}`)).toEqual({ sidebar: { w: 240 } });
  });

  it('keeps each vault its own object and the app one shared', async () => {
    const { local, now } = make();
    const other = createLocal(OTHER, { now, console: null });
    await local.localSet('vault', { a: 1 });
    await other.localSet('vault', { b: 2 });
    await local.localSet('app', { shared: true });
    expect(await other.localGet('vault')).toEqual({ b: 2 });
    expect(await other.localGet('app')).toEqual({ shared: true });
  });

  it('refuses a bad scope, a value that is not an object, and more than 1 MB', async () => {
    const { local } = make();
    expect(await code(() => local.localGet(/** @type {any} */ ('machine')))).toBe('bad_arg');
    expect(await code(() => local.localSet(/** @type {any} */ ('machine'), {}))).toBe('bad_arg');
    expect(await code(() => local.localSet('app', /** @type {any} */ ([1])))).toBe('bad_arg');
    expect(await code(() => local.localSet('app', /** @type {any} */ (null)))).toBe('bad_arg');
    expect(await code(() => local.localSet('app', /** @type {any} */ ('x')))).toBe('bad_arg');
    expect(await code(() => local.localSet('app', { big: 'x'.repeat(1024 * 1024) }))).toBe('bad_arg');
    expect(await local.localSet('app', { fits: 'x'.repeat(1024 * 1024 - 20) })).toBeNull();
  });

  it('keeps the host keys out of the page hands', async () => {
    const { local } = make();
    await local.hostSet('theme', 'dark');
    await local.hostSet('window', { w: 800 });
    expect(await local.localGet('app')).toEqual({});
    await local.localSet('app', { theme: 'light', window: null, legacyOrigin: 'x', mine: 1 });
    expect(await idb.get('local', 'app')).toEqual({ theme: 'dark', window: { w: 800 }, mine: 1 });
    expect(await local.localGet('app')).toEqual({ mine: 1 });
    expect(await local.hostGet('theme')).toBe('dark');
    await local.hostSet('theme', undefined);
    expect(await local.hostGet('theme')).toBeUndefined();
    expect(await code(() => local.hostSet('recent', 1))).toBe('bad_arg');

    await idb.put('local', { window: { x: 1 }, theme: 'kept' }, `vault:${VAULT}`);
    expect(await local.localGet('vault')).toEqual({ theme: 'kept' });
    await local.localSet('vault', { window: 'no', theme: 'page' });
    expect(await idb.get('local', `vault:${VAULT}`)).toEqual({ window: { x: 1 }, theme: 'page' });
  });

  it('checks the epoch on a vault write only', async () => {
    const { local, setEpoch } = make();
    setEpoch(3);
    expect(await code(() => local.localSet('vault', {}, { epoch: 2 }))).toBe('stale_vault');
    expect(await local.localSet('vault', { ok: 1 }, { epoch: 3 })).toBeNull();
    expect(await local.localSet('app', { ok: 1 }, { epoch: 2 })).toBeNull();
  });

  it('needs a vault for the vault scope', async () => {
    const { local } = make({}, /** @type {any} */ (null));
    expect(await code(() => local.localGet('vault'))).toBe('no_vault');
    expect(await code(() => local.localSet('vault', {}))).toBe('no_vault');
    expect(await local.localSet('app', { a: 1 })).toBeNull();
    expect(await local.localGet('app')).toEqual({ a: 1 });
  });

  it('reads a broken record as {} and stores a copy, not the caller object', async () => {
    const { local } = make();
    await idb.put('local', 'garbage', 'app');
    expect(await local.localGet('app')).toEqual({});
    const v = { list: [1], when: undefined };
    await local.localSet('app', v);
    v.list.push(2);
    expect(await local.localGet('app')).toEqual({ list: [1] });
  });
});

describe('the log', () => {
  it('writes `<stamp> <level> ui: <text>` for the page and never fails', async () => {
    const { local } = make();
    expect(await local.log('hello')).toBeNull();
    expect(await local.log('careful', 'WARN')).toBeNull();
    expect(await local.log('odd', 'loud')).toBeNull();
    expect(await local.log(/** @type {any} */ ({ toString: () => 'obj' }), 'debug')).toBeNull();
    const lines = await local.logLines();
    expect(lines).toEqual([
      '1970-01-01 00:00:01.000 info ui: hello',
      '1970-01-01 00:00:01.000 warn ui: careful',
      '1970-01-01 00:00:01.000 info ui: odd',
      '1970-01-01 00:00:01.000 debug ui: obj',
    ]);
  });

  it('has a writer for fs and the adapter, without `ui:`', async () => {
    const { local } = make();
    local.write('error', 'save failed notes/a.md');
    local.write('nonsense', 'x');
    expect(await local.logLines(5)).toEqual(['1970-01-01 00:00:01.000 error save failed notes/a.md', '1970-01-01 00:00:01.000 info x']);
    expect(await local.logLines(1)).toEqual(['1970-01-01 00:00:01.000 info x']);
    expect(await local.logLines(0)).toEqual([]);
  });

  it('echoes to the console at the level', async () => {
    /** @type {string[]} */
    const seen = [];
    const c = { error: (s) => seen.push(`E ${s}`), warn: (s) => seen.push(`W ${s}`), info: (s) => seen.push(`I ${s}`), debug: (s) => seen.push(`D ${s}`) };
    const { local } = make({ console: c });
    await local.log('a', 'error');
    await local.log('b');
    expect(seen).toEqual(['E [ose] 1970-01-01 00:00:01.000 error ui: a', 'I [ose] 1970-01-01 00:00:01.000 info ui: b']);
    const broken = make({ console: /** @type {any} */ ({ info: () => { throw new Error('no'); } }) }).local;
    expect(await broken.log('still')).toBeNull();
  });

  it('keeps the newest 5000 lines', async () => {
    const { local } = make();
    for (let i = 0; i < LOG_MAX + 600; i++) local.write('info', `line ${i}`);
    await local.flush();
    const lines = await local.logLines();
    expect(lines.length).toBeLessThanOrEqual(LOG_MAX + 250);
    expect(lines.at(-1)).toMatch(/line 5599$/);
    // A trim runs at the first write of a tab, so a new tab starts from at most LOG_MAX.
    const next = make().local;
    next.write('info', 'fresh');
    await next.flush();
    const after = await next.logLines();
    expect(after.length).toBe(LOG_MAX);
    expect(after.at(-1)).toMatch(/fresh$/);
    expect(after[0]).toMatch(/line 601$/);
  });

  it('keeps order across the writers', async () => {
    const { local } = make();
    local.write('info', '1');
    await local.log('2');
    local.write('info', '3');
    expect((await local.logLines()).map((l) => l.split(' ').pop())).toEqual(['1', '2', '3']);
  });
});
