// Module watch (src/web/watch.js, docs/HOST.md "The watcher"): the `fs` event from a
// FileSystemObserver or from the polling fallback, in watcher.rs's shape, over the in-memory
// File System Access API (tests/stubs/fsa.js). Fake timers: the debounce, the poll interval and
// the liveness tick are all driven by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFsa } from '../stubs/fsa.js';
import { diff, lookup, resolveKind, snapshot, startWatch } from '../../src/web/watch.js';

/** @type {Array<() => void>} */
let stops = [];

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const s of stops) s();
  stops = [];
  vi.useRealTimers();
});

const wait = (ms) => vi.advanceTimersByTimeAsync(ms);

/**
 * A watcher over a stub vault. `observer: null` forces the poll.
 * @param {any} [fsaOpts] @param {any} [opts]
 */
async function watch(fsaOpts = {}, opts = {}) {
  const fsa = createFsa(fsaOpts);
  /** @type {any[]} */
  const events = [];
  const followed = [];
  const fs = { followRename: vi.fn(async (from, to) => { followed.push([from, to]); }) };
  const root = opts.root ? opts.root(fsa) : fsa.root;
  const stop = startWatch(root, fs, (name, data) => { events.push({ name, data }); }, { observer: fsa.Observer, ...opts });
  stops.push(stop);
  const mode = await stop.ready;
  return { fsa, events, fs, followed, stop, mode, root, all: () => events.flatMap((e) => e.data.changes) };
}

describe('resolveKind: the kind a path comes to (watcher.rs changes_of)', () => {
  it('merges what gathered with what is there now', () => {
    expect(resolveKind(['create'], 'file')).toBe('create');
    expect(resolveKind(['create', 'modify'], 'file')).toBe('create');
    expect(resolveKind(['create', 'delete'], null)).toBe(null);
    expect(resolveKind(['modify'], 'file')).toBe('modify');
    expect(resolveKind(['modify'], null)).toBe('delete');
    expect(resolveKind(['delete'], null)).toBe('delete');
    expect(resolveKind(['delete', 'create'], 'file')).toBe('modify');
    expect(resolveKind(['delete', 'create'], 'directory')).toBe('create');
    expect(resolveKind(['delete', 'modify'], 'file')).toBe('modify');
    expect(resolveKind(['ambiguous'], 'file')).toBe('create');
    expect(resolveKind(['ambiguous'], null)).toBe('delete');
  });
});

describe('lookup and snapshot', () => {
  it('says what is at a path', async () => {
    const fsa = createFsa({ files: { 'a.md': 'a', 'd/b.md': 'b' } });
    expect(await lookup(fsa.root, 'a.md')).toBe('file');
    expect(await lookup(fsa.root, 'd')).toBe('directory');
    expect(await lookup(fsa.root, 'd/b.md')).toBe('file');
    expect(await lookup(fsa.root, 'd/none.md')).toBe(null);
    expect(await lookup(fsa.root, 'a.md/x')).toBe(null);
  });

  it('walks under the hide rule: hidden entries in, excluded ones never entered', async () => {
    const fsa = createFsa({
      files: {
        'a.md': 'a', '.obsidian/app.json': '{}', '.ose/state.json': '{}', '.git/HEAD': 'x',
        'a.md.crswap': '', '.trash/1-x.md': 'x', '.trash/.info/1-x.md.json': '{}', 'n/.hidden.md': 'h',
      },
    });
    const { map } = await snapshot(fsa.root);
    expect([...map.keys()].sort()).toEqual(['.obsidian', '.obsidian/app.json', '.trash', '.trash/1-x.md', 'a.md', 'n', 'n/.hidden.md']);
    expect(map.get('a.md')).toMatchObject({ kind: 'file', size: 1 });
    expect(map.get('n')).toEqual({ kind: 'directory', size: 0, mtime: 0 });
  });

  it('throws when the root cannot be read', async () => {
    const fsa = createFsa({ files: { 'a.md': 'a' } });
    fsa.loseRoot();
    await expect(snapshot(fsa.root)).rejects.toBeTruthy();
  });
});

describe('diff: the poll pairs renames', () => {
  const m = (/** @type {Record<string, [number, number] | 'dir'>} */ o) => new Map(Object.entries(o).map(([p, v]) => [p, v === 'dir' ? { kind: 'directory', size: 0, mtime: 0 } : { kind: 'file', size: v[0], mtime: v[1] }]));
  const d = (a, b, unreadable = []) => diff(m(a), { map: m(b), unreadable });

  it('reports create, modify and delete', () => {
    expect(d({ 'a.md': [1, 1], 'b.md': [1, 1] }, { 'a.md': [2, 2], 'c.md': [5, 5] })).toEqual([
      { path: 'b.md', kind: 'delete' },
      { path: 'c.md', kind: 'create' },
      { path: 'a.md', kind: 'modify' },
    ]);
  });

  it('pairs a rename in one folder and a move under the same name', () => {
    expect(d({ 'a.md': [3, 9] }, { 'b.md': [3, 9] })).toEqual([{ path: 'a.md', kind: 'rename', to: 'b.md' }]);
    expect(d({ 'x/a.md': [3, 9], y: 'dir' }, { 'y/a.md': [3, 9], y: 'dir' })).toEqual([{ path: 'x/a.md', kind: 'rename', to: 'y/a.md' }]);
  });

  it('does not pair a new name in another folder, nor two look-alikes', () => {
    expect(d({ 'x/a.md': [3, 9] }, { 'y/b.md': [3, 9] }).map((c) => c.kind).sort()).toEqual(['create', 'delete']);
    const out = d({ 'a.md': [3, 9], 'b.md': [3, 9] }, { 'c.md': [3, 9], 'e.md': [3, 9] });
    expect(out.every((c) => c.kind !== 'rename')).toBe(true);
    expect(d({ 'a.md': [3, 9] }, { 'b.md': [3, 10] }).map((c) => c.kind).sort()).toEqual(['create', 'delete']);
  });

  it('moves a folder as one rename, dir flagged, nothing under it reported', () => {
    const out = d({ f: 'dir', 'f/a.md': [1, 1], 'f/s': 'dir', 'f/s/b.md': [2, 2] }, { g: 'dir', 'g/a.md': [1, 1], 'g/s': 'dir', 'g/s/b.md': [2, 2] });
    expect(out).toEqual([{ path: 'f', kind: 'rename', to: 'g', dir: true }]);
  });

  it('never pairs across the bin', () => {
    const out = d({ 'a.md': [1, 1] }, { '.trash/a.md': [1, 1], '.trash': 'dir' });
    expect(out).toEqual([
      { path: 'a.md', kind: 'delete' },
      { path: '.trash/a.md', kind: 'create', hidden: true },
      { path: '.trash', kind: 'create', dir: true, hidden: true },
    ]);
  });

  it('keeps what was known under an unreadable folder', () => {
    expect(d({ f: 'dir', 'f/a.md': [1, 1] }, { f: 'dir' }, ['f'])).toEqual([]);
  });

  it('a folder replaced by a file is a modify, a file replaced by a folder a create', () => {
    expect(d({ x: 'dir' }, { x: [1, 1] })).toEqual([{ path: 'x', kind: 'modify' }]);
    expect(d({ x: [1, 1] }, { x: 'dir' })).toEqual([{ path: 'x', kind: 'create', dir: true }]);
  });
});

describe('startWatch with FileSystemObserver', () => {
  it('uses the observer and waits 150 ms of quiet', async () => {
    const w = await watch({ files: { 'a.md': 'a' } });
    expect(w.mode).toBe('observer');
    w.fsa.write('a.md', 'b');
    await wait(100);
    expect(w.events).toEqual([]);
    await wait(100);
    expect(w.events).toEqual([{ name: 'fs', data: { changes: [{ path: 'a.md', kind: 'modify' }] } }]);
  });

  it('keeps waiting while changes keep coming, but not for ever', async () => {
    const w = await watch({ files: { 'a.md': 'a' } });
    for (let i = 0; i < 12; i++) { w.fsa.write('a.md', `v${i}`); await wait(100); }
    expect(w.events.length).toBe(1);
    await wait(300);
    expect(w.all().every((c) => c.path === 'a.md' && c.kind === 'modify')).toBe(true);
  });

  it('a save through a writable is one modify; its .crswap is never reported', async () => {
    const w = await watch({ files: { 'n/a.md': 'a' } });
    const h = await (await w.root.getDirectoryHandle('n')).getFileHandle('a.md');
    const wr = await h.createWritable();
    await wr.write('new text');
    await wr.close();
    await wait(200);
    expect(w.events).toEqual([{ name: 'fs', data: { changes: [{ path: 'n/a.md', kind: 'modify' }] } }]);
  });

  it('create, delete, folders, hidden', async () => {
    const w = await watch({ files: { 'old.md': 'o', 'gone/x.md': 'x' } });
    w.fsa.write('new/deep.md', 'd');
    w.fsa.remove('old.md');
    w.fsa.remove('gone');
    w.fsa.write('.dot.md', '.');
    await wait(200);
    expect(w.all()).toEqual([
      { path: 'new', kind: 'create', dir: true },
      { path: 'new/deep.md', kind: 'create' },
      { path: 'old.md', kind: 'delete' },
      { path: 'gone', kind: 'delete' },
      { path: '.dot.md', kind: 'create', hidden: true },
    ]);
  });

  it('created then deleted is nothing; created then changed is a create', async () => {
    const w = await watch();
    w.fsa.write('t.md', '1');
    w.fsa.remove('t.md');
    w.fsa.write('u.md', '1');
    w.fsa.write('u.md', '2');
    await wait(200);
    expect(w.all()).toEqual([{ path: 'u.md', kind: 'create' }]);
  });

  it('a file removed and written again is a modify', async () => {
    const w = await watch({ files: { 'a.md': 'a' } });
    w.fsa.remove('a.md');
    w.fsa.write('a.md', 'b');
    await wait(200);
    expect(w.all()).toEqual([{ path: 'a.md', kind: 'modify' }]);
  });

  it('never reports .ose, .git, .trash/.info or temp files', async () => {
    const w = await watch();
    w.fsa.write('.ose/state.json', '{}');
    w.fsa.write('.git/index', 'x');
    w.fsa.write('.trash/.info/1-a.md.json', '{}');
    w.fsa.write('x.md.crswap', '');
    w.fsa.write('~$doc.docx', '');
    await wait(300);
    // `.trash` itself appearing is real; nothing below `.info` is.
    expect(w.all()).toEqual([{ path: '.trash', kind: 'create', dir: true, hidden: true }]);
  });

  it('a rename is one change with `to`, and is followed', async () => {
    const w = await watch({ files: { 'a.md': 'a', 'f/b.md': 'b' } });
    w.fsa.rename('a.md', 'z.md');
    w.fsa.rename('f', 'g');
    await wait(200);
    expect(w.all()).toEqual([
      { path: 'a.md', kind: 'rename', to: 'z.md' },
      { path: 'f', kind: 'rename', to: 'g', dir: true },
    ]);
    expect(w.followed).toEqual([['a.md', 'z.md'], ['f', 'g']]);
  });

  it('a rename whose `from` is back is reported but not followed (backup-then-write)', async () => {
    const w = await watch({ files: { 'a.md': 'a' } });
    w.fsa.rename('a.md', 'a.md.bak');
    w.fsa.write('a.md', 'new');
    await wait(200);
    expect(w.all()[0]).toEqual({ path: 'a.md', kind: 'rename', to: 'a.md.bak' });
    expect(w.followed).toEqual([]);
  });

  it('into the bin and out of it is a delete and a create', async () => {
    const w = await watch({ files: { 'a.md': 'a', '.trash/1-b.md': 'b' } });
    w.fsa.rename('a.md', '.trash/2-a.md');
    w.fsa.rename('.trash/1-b.md', 'b.md');
    await wait(200);
    expect(w.all()).toEqual([
      { path: 'a.md', kind: 'delete' },
      { path: '.trash/2-a.md', kind: 'create', hidden: true },
      { path: '.trash/1-b.md', kind: 'delete', hidden: true },
      { path: 'b.md', kind: 'create' },
    ]);
    expect(w.followed).toEqual([]);
  });

  it('a temp file renamed onto the page is a modify; a page moved into .ose is gone', async () => {
    const w = await watch({ files: { 'p.md': 'p', 'q.md': 'q', '.p.md.12.0.tmp': 'new' } });
    w.fsa.remove('p.md');
    w.fsa.rename('.p.md.12.0.tmp', 'p.md');
    w.fsa.rename('q.md', '.ose/q.md');
    await wait(200);
    expect(w.all()).toEqual([{ path: 'p.md', kind: 'modify' }, { path: 'q.md', kind: 'delete' }]);
  });

  it('`unknown` is a rescan', async () => {
    const w = await watch({ files: { 'a.md': 'a' } });
    w.fsa.observers()[0]._signal('unknown');
    await wait(200);
    expect(w.events).toEqual([{ name: 'fs', data: { changes: [], rescan: true } }]);
  });

  it('`errored` restarts the observer and says rescan', async () => {
    const w = await watch({ files: { 'a.md': 'a' } });
    const first = w.fsa.observers()[0];
    first._signal('errored');
    await wait(50);
    expect(w.events).toEqual([{ name: 'fs', data: { changes: [], rescan: true } }]);
    expect(w.fsa.observers().length).toBe(1);
    expect(w.fsa.observers()[0]).not.toBe(first);
    w.fsa.write('a.md', 'b');
    await wait(200);
    expect(w.all()).toEqual([{ path: 'a.md', kind: 'modify' }]);
  });

  it('the root lost is said once, and its return is lost:false then rescan', async () => {
    const w = await watch({ files: { 'a.md': 'a' } });
    w.fsa.loseRoot();
    await wait(3500);
    expect(w.events.map((e) => e.data)).toEqual([{ changes: [], lost: true }]);
    w.fsa.restoreRoot();
    await wait(1100);
    expect(w.events.map((e) => e.data)).toEqual([{ changes: [], lost: true }, { changes: [], lost: false }, { changes: [], rescan: true }]);
    w.fsa.write('a.md', 'b');
    await wait(200);
    expect(w.events.at(-1).data).toEqual({ changes: [{ path: 'a.md', kind: 'modify' }] });
  });

  it('`errored` on a root that is gone is lost', async () => {
    const w = await watch({ files: { 'a.md': 'a' } });
    const o = w.fsa.observers()[0];
    w.fsa.loseRoot();
    o._signal('errored');
    await wait(50);
    expect(w.events.map((e) => e.data)).toEqual([{ changes: [], lost: true }]);
  });

  it('observes a subfolder as a root: paths are relative to it', async () => {
    const w = await watch({ files: { 'vault/a.md': 'a', 'other/b.md': 'b' } }, { root: (fsa) => fsa.handle('vault') });
    w.fsa.write('vault/a.md', 'x');
    w.fsa.write('other/b.md', 'x');
    await wait(200);
    expect(w.all()).toEqual([{ path: 'a.md', kind: 'modify' }]);
  });

  it('falls back to polling when observe() throws', async () => {
    const fsa0 = createFsa();
    class Broken extends fsa0.Observer {
      async observe() { throw new DOMException('no', 'NotSupportedError'); }
    }
    const w = await watch({ files: { 'a.md': 'a' } }, { observer: Broken });
    expect(w.mode).toBe('poll');
    w.fsa.write('a.md', 'bb');
    await wait(2100);
    expect(w.all()).toEqual([{ path: 'a.md', kind: 'modify' }]);
  });

  it('stop() ends it all', async () => {
    const w = await watch({ files: { 'a.md': 'a' } });
    w.fsa.write('a.md', 'b');
    w.stop();
    await wait(500);
    expect(w.events).toEqual([]);
    expect(w.fsa.observers()).toEqual([]);
  });

  it('a subscriber that throws does not stop the watcher', async () => {
    const fsa = createFsa({ files: { 'a.md': 'a' } });
    let n = 0;
    const stop = startWatch(fsa.root, null, () => { n++; throw new Error('boom'); }, { observer: fsa.Observer });
    stops.push(stop);
    await stop.ready;
    fsa.write('a.md', 'b');
    await wait(200);
    fsa.write('a.md', 'c');
    await wait(200);
    expect(n).toBe(2);
  });
});

describe('startWatch polling', () => {
  it('polls every 2 s, from a first snapshot that says nothing', async () => {
    const w = await watch({ files: { 'a.md': 'a', 'b.md': 'b' } }, { observer: null });
    expect(w.mode).toBe('poll');
    await wait(2100);
    expect(w.events).toEqual([]);
    w.fsa.write('a.md', 'changed');
    w.fsa.write('c/new.md', 'n');
    w.fsa.remove('b.md');
    await wait(1000);
    expect(w.events).toEqual([]);
    await wait(1100);
    expect(w.all()).toEqual([
      { path: 'b.md', kind: 'delete' },
      { path: 'c', kind: 'create', dir: true },
      { path: 'c/new.md', kind: 'create' },
      { path: 'a.md', kind: 'modify' },
    ]);
  });

  it('pairs renames and follows them', async () => {
    const w = await watch({ files: { 'a.md': 'a', 'f/x.md': 'x', 'f/y.md': 'yy' } }, { observer: null });
    w.fsa.rename('a.md', 'b.md');
    w.fsa.rename('f', 'g');
    await wait(2100);
    const byPath = (a, b) => (a.path < b.path ? -1 : 1);
    expect(w.all().sort(byPath)).toEqual([
      { path: 'a.md', kind: 'rename', to: 'b.md' },
      { path: 'f', kind: 'rename', to: 'g', dir: true },
    ]);
    expect(w.followed.sort()).toEqual([['a.md', 'b.md'], ['f', 'g']]);
  });

  it('trash and restore through the bin are deletes and creates', async () => {
    const w = await watch({ files: { 'a.md': 'a' }, dirs: ['.trash'] }, { observer: null });
    w.fsa.rename('a.md', '.trash/1-a.md');
    w.fsa.write('.trash/.info/1-a.md.json', '{}');
    await wait(2100);
    expect(w.all()).toEqual([
      { path: 'a.md', kind: 'delete' },
      { path: '.trash/1-a.md', kind: 'create', hidden: true },
    ]);
  });

  it('slows to 10 s while hidden, and polls at once when shown', async () => {
    const doc = new EventTarget();
    /** @type {any} */ (doc).visibilityState = 'hidden';
    const w = await watch({ files: { 'a.md': 'a' } }, { observer: null, document: doc });
    w.fsa.write('a.md', 'b');
    await wait(5000);
    expect(w.events).toEqual([]);
    /** @type {any} */ (doc).visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await wait(10);
    expect(w.all()).toEqual([{ path: 'a.md', kind: 'modify' }]);
  });

  it('an unreadable folder is not a delete', async () => {
    const w = await watch({ files: { 'f/a.md': 'a' } }, { observer: null });
    w.fsa.fail('entries', 'f');
    await wait(2100);
    expect(w.events).toEqual([]);
    await wait(2000);
    expect(w.events).toEqual([]);
  });

  it('the root lost and back', async () => {
    const w = await watch({ files: { 'a.md': 'a' } }, { observer: null });
    w.fsa.loseRoot();
    await wait(4100);
    expect(w.events.map((e) => e.data)).toEqual([{ changes: [], lost: true }]);
    w.fsa.restoreRoot();
    w.fsa.write('a.md', 'changed while lost');
    await wait(2100);
    expect(w.events.map((e) => e.data)).toEqual([{ changes: [], lost: true }, { changes: [], lost: false }, { changes: [], rescan: true }]);
    w.fsa.write('b.md', 'b');
    await wait(2100);
    expect(w.events.at(-1).data).toEqual({ changes: [{ path: 'b.md', kind: 'create' }] });
  });

  it('stop() stops the poll', async () => {
    const w = await watch({ files: { 'a.md': 'a' } }, { observer: null });
    w.stop();
    w.fsa.write('a.md', 'b');
    await wait(5000);
    expect(w.events).toEqual([]);
  });
});

describe('files outside the vault', () => {
  it('observed one by one: modify and delete under their abs: path', async () => {
    let list = [];
    const w = await watch({ files: { 'vault/a.md': 'a', 'elsewhere/x.md': 'x' } }, {
      root: (fsa) => fsa.handle('vault'),
      outside: { list: async () => list },
    });
    list = [{ path: 'abs:/web/1/x.md', handle: w.fsa.handle('elsewhere/x.md') }];
    await w.stop.refresh();
    w.fsa.write('elsewhere/x.md', 'changed');
    await wait(200);
    expect(w.all()).toEqual([{ path: 'abs:/web/1/x.md', kind: 'modify' }]);
    w.fsa.remove('elsewhere/x.md');
    await wait(200);
    expect(w.all().at(-1)).toEqual({ path: 'abs:/web/1/x.md', kind: 'delete' });
    // Dropped from the list: no longer watched.
    list = [];
    await w.stop.refresh();
    w.fsa.write('elsewhere/x.md', 'again');
    await wait(300);
    expect(w.all().length).toBe(2);
  });

  it('polled by lastModified when a file cannot be observed', async () => {
    const other = createFsa({ files: { 'x.md': 'x' } });
    const w = await watch({ files: { 'a.md': 'a' } }, {
      outside: { list: async () => [{ path: 'abs:/web/9/x.md', handle: other.handle('x.md') }] },
    });
    // The vault's observer cannot observe another tree's handle: the file is polled.
    other.write('x.md', 'changed');
    await wait(2300);
    expect(w.all()).toEqual([{ path: 'abs:/web/9/x.md', kind: 'modify' }]);
    await wait(2300);
    expect(w.all().length).toBe(1);
    other.remove('x.md');
    await wait(2300);
    expect(w.all().at(-1)).toEqual({ path: 'abs:/web/9/x.md', kind: 'delete' });
    await wait(2300);
    expect(w.all().length).toBe(2);
    other.write('x.md', 'back');
    await wait(2300);
    expect(w.all().at(-1)).toEqual({ path: 'abs:/web/9/x.md', kind: 'modify' });
  });

  it('polled with the vault when there is no observer', async () => {
    const other = createFsa({ files: { 'x.md': 'x' } });
    const w = await watch({ files: { 'a.md': 'a' } }, {
      observer: null,
      outside: { list: async () => [{ path: 'abs:/web/9/x.md', handle: other.handle('x.md') }] },
    });
    other.write('x.md', 'changed');
    await wait(2400);
    expect(w.all()).toEqual([{ path: 'abs:/web/9/x.md', kind: 'modify' }]);
  });
});
