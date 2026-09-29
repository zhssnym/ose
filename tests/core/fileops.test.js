// @vitest-environment happy-dom
//
// ose.fileops (CONTRACT 4.5, C6, H12, H13): the one create, rename, move, trash and duplicate.
// Wave 2 adds an `entry` (the undo journal, tests/core/journal.test.js) to every result.
// What matters is the order: the page is asked first and a refusal touches nothing on disk; the
// host call comes next; only after it succeeded is the router re-pointed, the page told, the bus
// told and the links rewritten. A failed host call tells the page `ok:false` and rethrows.
//
// Depends on: core (src/core/fileops.ts, names.js, router.js repoint, links.js).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, fail, reset, vault, writes } from './fake-bridge.js';
import { create, duplicate, move, rename, trash } from '../../src/core/fileops.ts';
import { setPageHost } from '../../src/core/pagehost.ts';
import { bus } from '../../src/core/registry.ts';

vi.mock('../../src/core/bridge/index.ts', () => import('./fake-bridge.js'));

/**
 * A page host that writes its calls into the bridge's call log, so one list holds the order of
 * everything, and answers `beforePathChange` with `answer`.
 */
function host(answer = { ok: true }) {
  const h = {
    before: [],
    after: [],
    async beforePathChange(change) { calls.push(['beforePathChange', change]); h.before.push(change); return answer; },
    async afterPathChange(change) { calls.push(['afterPathChange', change]); h.after.push(change); },
  };
  return h;
}

let unhost = () => {};
const offs = [];
beforeEach(() => {
  reset({
    'notes/a.md': '# a\n',
    'notes/sub/c.md': '# c\n',
    'index.md': 'See [a](notes/a.md) and [c](notes/sub/c.md).\n',
    'script.py': 'print(1)\n',
    'b.txt': 'b\n',
    'archive/': '',
  });
  for (const ev of ['paths:moved', 'paths:trashed', 'route:repointed']) offs.push(bus.on(ev, (d) => calls.push([ev, d])));
});
afterEach(() => { unhost(); while (offs.length) offs.pop()(); });

/** The names of the steps in the log, in order, from the page's first question on. */
const steps = () => calls.map(([c]) => c).filter((c) => !['stat', 'exists', 'tree', 'list', 'search', 'setTitle'].includes(c));

describe('rename', () => {
  it('asks the page, renames, re-points, tells the page, tells the bus, then rewrites links', async () => {
    const h = host();
    unhost = setPageHost(h);
    const r = await rename('notes/a.md', 'a.txt');
    expect(r.from).toBe('notes/a.md');
    expect(r.to).toBe('notes/a.txt');
    const order = steps();
    const at = (name) => order.indexOf(name);
    expect(at('beforePathChange')).toBe(0);
    expect(at('rename')).toBeGreaterThan(at('beforePathChange'));
    expect(at('route:repointed')).toBeGreaterThan(at('rename'));
    expect(at('afterPathChange')).toBeGreaterThan(at('route:repointed'));
    expect(at('paths:moved')).toBeGreaterThan(at('afterPathChange'));
    expect(at('saveFile')).toBeGreaterThan(at('paths:moved'));
    expect(h.before).toEqual([{ kind: 'rename', from: 'notes/a.md', to: 'notes/a.txt' }]);
    expect(h.after).toEqual([{ kind: 'rename', from: 'notes/a.md', to: 'notes/a.txt', ok: true }]);
    expect(vault.files.get('index.md')).toBe('See [a](notes/a.txt) and [c](notes/sub/c.md).\n');
    expect(r.links.files).toBe(1);
  });

  it('is literal: the name typed is the name written, the extension included', async () => {
    unhost = setPageHost(host());
    await rename('script.py', 'renamed.txt');
    expect(vault.files.has('renamed.txt')).toBe(true);
    await rename('b.txt', 'b.md');
    expect(vault.files.has('b.md')).toBe(true);
    await rename('notes/a.md', 'a');
    expect(vault.files.has('notes/a')).toBe(true);
  });

  it('a page that cannot be saved refuses, and nothing on disk is touched', async () => {
    const h = host({ ok: false, reason: 'a.md has unsaved changes that could not be saved' });
    unhost = setPageHost(h);
    await expect(rename('notes/a.md', 'z.md')).rejects.toMatchObject({ code: 'not_saved', message: 'a.md has unsaved changes that could not be saved' });
    expect(writes().map(([c]) => c)).toEqual([]);
    expect(h.after).toEqual([]);
    expect(steps()).toEqual(['beforePathChange']);
    expect(vault.files.has('notes/a.md')).toBe(true);
  });

  it('a host refusal tells the page ok:false and rethrows; nobody else hears of it', async () => {
    const h = host();
    unhost = setPageHost(h);
    fail('rename', 'io');
    await expect(rename('notes/a.md', 'z.md')).rejects.toMatchObject({ code: 'io' });
    expect(h.after).toEqual([{ kind: 'rename', from: 'notes/a.md', to: 'notes/z.md', ok: false }]);
    expect(steps()).not.toContain('route:repointed');
    expect(steps()).not.toContain('paths:moved');
    expect(steps()).not.toContain('saveFile');
  });

  it('refuses an existing name before asking the page', async () => {
    const h = host();
    unhost = setPageHost(h);
    await expect(rename('b.txt', 'script.py')).rejects.toMatchObject({ code: 'exists' });
    expect(h.before).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('allows a rename that only changes case', async () => {
    unhost = setPageHost(host());
    const r = await rename('notes/a.md', 'A.md');
    expect(r.to).toBe('notes/A.md');
    expect(vault.files.has('notes/A.md')).toBe(true);
  });

  it('refuses a bad name, and a name with a folder in it', async () => {
    const h = host();
    unhost = setPageHost(h);
    await expect(rename('b.txt', 'x/y.txt')).rejects.toMatchObject({ code: 'bad_name' });
    await expect(rename('b.txt', 'con.txt')).rejects.toMatchObject({ code: 'bad_name' });
    await expect(rename('b.txt', '')).rejects.toMatchObject({ code: 'bad_name' });
    expect(h.before).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('a folder: the page is asked about the folder, and the links into it follow', async () => {
    const h = host();
    unhost = setPageHost(h);
    await rename('notes', 'papers');
    expect(h.before).toEqual([{ kind: 'rename', from: 'notes', to: 'papers' }]);
    expect(vault.files.has('papers/sub/c.md')).toBe(true);
    expect(vault.files.get('index.md')).toBe('See [a](papers/a.md) and [c](papers/sub/c.md).\n');
  });

  it('without a page host it still renames', async () => {
    await rename('b.txt', 'c.txt');
    expect(vault.files.has('c.txt')).toBe(true);
  });
});

describe('move', () => {
  it('moves each path, skips what cannot go, and says so once', async () => {
    unhost = setPageHost(host());
    reset({ 'a.md': '', 'x.md': '', 'archive/x.md': '', 'notes/n.md': '', 'archive/': '' });
    const r = await move(['a.md', 'x.md', 'notes', 'archive'], 'archive');
    expect(r.moved).toEqual([{ from: 'a.md', to: 'archive/a.md' }, { from: 'notes', to: 'archive/notes' }]);
    const skipped = Object.fromEntries(r.skipped.map((s) => [s.path, s.error.code]));
    expect(skipped['x.md']).toBe('exists');
    expect(skipped.archive).toBe('bad_arg');
    expect(calls.filter(([c]) => c === 'paths:moved')).toHaveLength(1);
  });

  it('a page that refuses keeps its file where it is and the others still move', async () => {
    const h = {
      async beforePathChange(c) { return c.from === 'b.txt' ? { ok: false, reason: 'no' } : { ok: true }; },
      async afterPathChange() {},
    };
    unhost = setPageHost(h);
    const r = await move(['b.txt', 'script.py'], 'archive');
    expect(r.moved).toEqual([{ from: 'script.py', to: 'archive/script.py' }]);
    expect(r.skipped[0].path).toBe('b.txt');
    expect(r.skipped[0].error.code).toBe('not_saved');
    expect(vault.files.has('b.txt')).toBe(true);
  });
});

describe('trash', () => {
  it('asks the page, trashes, then tells the page and the bus', async () => {
    const h = host();
    unhost = setPageHost(h);
    const r = await trash(['b.txt']);
    expect(r).toMatchObject({ trashed: ['b.txt'], failed: [] });
    // Wave 2 (CONTRACT §4.7): where each item went, and the journal entry that undoes it.
    expect(r.items).toEqual([{ path: 'b.txt', id: expect.any(String), where: 'system' }]);
    expect(r.entry).toMatchObject({ verb: 'trash', undoable: true });
    const order = steps();
    expect(order.indexOf('beforePathChange')).toBeLessThan(order.indexOf('trash'));
    expect(order.indexOf('trash')).toBeLessThan(order.indexOf('afterPathChange'));
    expect(order.indexOf('afterPathChange')).toBeLessThan(order.indexOf('paths:trashed'));
    expect(h.before).toEqual([{ kind: 'trash', from: 'b.txt', to: null }]);
    expect(h.after).toEqual([{ kind: 'trash', from: 'b.txt', to: null, ok: true }]);
  });

  it('a refusal trashes nothing', async () => {
    unhost = setPageHost(host({ ok: false, reason: 'b.txt could not be saved' }));
    const r = await trash(['b.txt']);
    expect(r.trashed).toEqual([]);
    expect(r.failed[0].error.code).toBe('not_saved');
    expect(steps()).not.toContain('trash');
    expect(vault.files.has('b.txt')).toBe(true);
  });

  it('a failed trash tells the page ok:false and leaves the file', async () => {
    const h = host();
    unhost = setPageHost(h);
    fail('trash', 'io');
    const r = await trash(['b.txt']);
    expect(r.trashed).toEqual([]);
    expect(r.failed[0].error.code).toBe('io');
    expect(h.after).toEqual([{ kind: 'trash', from: 'b.txt', to: null, ok: false }]);
    expect(steps()).not.toContain('paths:trashed');
  });
});

describe('create', () => {
  it('a markdown file gets its title, anything else starts empty', async () => {
    expect(await create('notes', 'Untitled.md')).toMatchObject({ path: 'notes/Untitled.md' });
    expect(vault.files.get('notes/Untitled.md')).toBe('# Untitled\n');
    await create('', 'data.json');
    expect(vault.files.get('data.json')).toBe('');
    await create('', 'script.PY');
    expect(vault.files.get('script.PY')).toBe('');
  });

  it('takes the text it is given', async () => {
    await create('', 'x.md', { text: 'body\n' });
    expect(vault.files.get('x.md')).toBe('body\n');
  });

  it('a name with folders in it makes the folders', async () => {
    expect(await create('notes', 'a/b/c.ext')).toMatchObject({ path: 'notes/a/b/c.ext' });
    expect(vault.dirs.has('notes/a/b')).toBe(true);
  });

  it('never overwrites: exists, or the next free name when unique', async () => {
    await expect(create('notes', 'a.md')).rejects.toMatchObject({ code: 'exists' });
    expect(vault.files.get('notes/a.md')).toBe('# a\n');
    expect(await create('notes', 'a.md', { unique: true })).toMatchObject({ path: 'notes/a 2.md' });
    expect(vault.files.get('notes/a 2.md')).toBe('# a\n');
  });

  it('refuses a bad name', async () => {
    await expect(create('', 'a:b.md')).rejects.toMatchObject({ code: 'bad_name' });
    expect(writes()).toEqual([]);
  });
});

describe('duplicate', () => {
  it('a byte copy beside the file, stem 2 with the extension kept, the page asked first', async () => {
    const h = host();
    unhost = setPageHost(h);
    expect(await duplicate('script.py')).toMatchObject({ path: 'script 2.py' });
    expect(vault.files.get('script 2.py')).toBe('print(1)\n');
    expect(h.before).toEqual([{ kind: 'copy', from: 'script.py', to: 'script 2.py' }]);
    expect(steps().indexOf('beforePathChange')).toBeLessThan(steps().indexOf('copyFile'));
  });

  it('a refusal copies nothing', async () => {
    unhost = setPageHost(host({ ok: false, reason: 'no' }));
    await expect(duplicate('b.txt')).rejects.toMatchObject({ code: 'not_saved' });
    expect(steps()).not.toContain('copyFile');
  });
});
