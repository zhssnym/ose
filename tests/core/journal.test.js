// @vitest-environment happy-dom
//
// The undo journal for file operations (CONTRACT §4.7, M17, M18), over the fake bridge. Every
// operation `ose.fileops` makes is written down with the steps that undo it, newest first; an
// undo walks them back through the ordinary operations; a file changed since it was created or
// copied is left in place; a trash the platform cannot restore is not undoable; an undo is not
// journaled. Also copy and paste with free names, and restore refusing to overwrite.
//
// Depends on: core (src/core/journal.js, fileops.js). Skipped until fileops has the wave-2
// operations (copy, restore, mkdir, paste).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reset, setRestorable, vault } from './fake-bridge.js';

vi.mock('../../src/core/bridge/index.js', () => import('./fake-bridge.js'));

const F = await import('../../src/core/fileops.js');
const J = await import('../../src/core/journal.js');
const { setPageHost } = await import('../../src/core/pagehost.js');
const { bus } = await import('../../src/core/registry.js');


let unhost = () => {};
beforeEach(() => {
  reset({
    'notes/a.md': '# a\n',
    'notes/b.md': '# b\n',
    'notes/sub/c.md': '# c\n',
    'index.md': 'See [a](notes/a.md).\n',
    'archive/': '',
  });
  if (J) J.clearJournal();
  unhost = setPageHost({ async beforePathChange() { return { ok: true }; }, async afterPathChange() {} });
});
afterEach(() => { unhost(); });

const has = (p) => vault.files.has(p) || vault.dirs.has(p);

describe('the undo journal', () => {
  it('fileops has copy, restore, mkdir and paste', () => {
    for (const k of ['copy', 'restore', 'mkdir', 'paste']) expect(typeof F[k], k).toBe('function');
  });

  it('a rename is written down with a label that uses the real names, and undone', async () => {
    const r = await F.rename('notes/a.md', 'a.txt');
    expect(r.entry).toMatchObject({ verb: 'rename', label: 'Renamed a.md to a.txt', undone: false, undoable: true });
    expect(J.list()[0].id).toBe(r.entry.id);
    expect(J.canUndo()).toBe(true);
    expect(vault.files.get('index.md')).toBe('See [a](notes/a.txt).\n');

    const u = await J.undo();
    expect(u.ok).toBe(true);
    expect(u.failed).toEqual([]);
    expect(has('notes/a.md')).toBe(true);
    expect(has('notes/a.txt')).toBe(false);
    // The undo goes through the ordinary path, so the links follow back.
    expect(vault.files.get('index.md')).toBe('See [a](notes/a.md).\n');
    expect(J.canUndo()).toBe(false);
    expect(J.list()[0].undone).toBe(true);
  });

  it('repeated undo walks back: after two operations and one undo, the older one is still undoable', async () => {
    await F.rename('notes/a.md', 'a2.md');
    await F.rename('notes/b.md', 'b2.md');
    await J.undo();
    expect(has('notes/b.md')).toBe(true);
    expect(J.canUndo()).toBe(true);
    await J.undo();
    expect(has('notes/a.md')).toBe(true);
    expect(J.canUndo()).toBe(false);
  });

  it('a move of several items says how many and where, and moves every one back', async () => {
    const r = await F.move(['notes/a.md', 'notes/b.md', 'notes/sub'], 'archive');
    expect(r.entry.label).toBe('Moved 3 items to archive');
    expect(has('archive/sub/c.md')).toBe(true);
    await J.undo(r.entry.id);
    for (const p of ['notes/a.md', 'notes/b.md', 'notes/sub/c.md']) expect(has(p)).toBe(true);
    expect(has('archive/sub')).toBe(false);
  });

  it('an undo is not journaled, and there is no second undo of one entry', async () => {
    const r = await F.rename('notes/a.md', 'z.md');
    await J.undo();
    expect(J.list()).toHaveLength(1);
    const again = await J.undo(r.entry.id);
    expect(again.ok).toBe(false);
    expect(has('notes/a.md')).toBe(true);
  });

  it('a created file is trashed by the undo, unless it changed since', async () => {
    const r = await F.create('notes', 'new.md', { text: 'hello\n' });
    expect(r.entry).toMatchObject({ verb: 'create' });
    expect(r.entry.steps[0]).toMatchObject({ op: 'created', path: 'notes/new.md', dir: false });
    await J.undo();
    expect(has('notes/new.md')).toBe(false);

    const r2 = await F.create('notes', 'kept.md', { text: 'hello\n' });
    vault.files.set('notes/kept.md', 'hello, edited\n');
    const u = await J.undo(r2.entry.id);
    expect(u.ok).toBe(false);
    expect(u.failed).toHaveLength(1);
    expect(String(u.failed[0].error)).toMatch(/changed since/i);
    expect(vault.files.get('notes/kept.md')).toBe('hello, edited\n');
  });

  it('a new folder is undone by trashing it', async () => {
    const r = await F.mkdir('notes', 'fresh');
    expect(r.path).toBe('notes/fresh');
    expect(r.entry).toMatchObject({ verb: 'mkdir' });
    expect(vault.dirs.has('notes/fresh')).toBe(true);
    await J.undo();
    expect(vault.dirs.has('notes/fresh')).toBe(false);
  });

  it('copy takes free names and is undone by trashing the copies', async () => {
    const r = await F.copy(['notes/a.md', 'notes/sub'], 'archive');
    expect(r.copied).toEqual([{ from: 'notes/a.md', to: 'archive/a.md' }, { from: 'notes/sub', to: 'archive/sub' }]);
    expect(vault.files.get('archive/sub/c.md')).toBe('# c\n');
    const again = await F.copy(['notes/a.md', 'notes/sub'], 'archive');
    expect(again.copied.map((c) => c.to)).toEqual(['archive/a 2.md', 'archive/sub 2']);
    expect(again.entry.verb).toBe('copy');
    await J.undo(again.entry.id);
    expect(has('archive/a 2.md')).toBe(false);
    expect(has('archive/sub 2')).toBe(false);
    expect(has('archive/a.md')).toBe(true);
    // The originals are never touched.
    expect(vault.files.get('notes/a.md')).toBe('# a\n');
  });

  it('paste: cut moves, copy copies, and a copy into the same folder is "x 2"', async () => {
    await F.paste({ mode: 'copy', paths: ['notes/a.md'] }, 'notes');
    expect(vault.files.get('notes/a 2.md')).toBe('# a\n');
    await F.paste({ mode: 'cut', paths: ['notes/b.md'] }, 'archive');
    expect(has('notes/b.md')).toBe(false);
    expect(vault.files.get('archive/b.md')).toBe('# b\n');
    expect(J.list()[0].verb).toBe('move');
  });

  it('a trash names where it went and is undone by a restore', async () => {
    const seen = [];
    const off = bus.on('paths:trashed', (d) => seen.push(d));
    const r = await F.trash(['notes/a.md', 'notes/sub']);
    off();
    expect(r.trashed).toEqual(['notes/a.md', 'notes/sub']);
    expect(r.items).toEqual([
      { path: 'notes/a.md', id: expect.any(String), where: 'system' },
      { path: 'notes/sub', id: expect.any(String), where: 'system' },
    ]);
    expect(seen[0].items).toHaveLength(2);
    expect(r.entry).toMatchObject({ verb: 'trash', undoable: true });
    await J.undo();
    expect(vault.files.get('notes/a.md')).toBe('# a\n');
    expect(vault.files.get('notes/sub/c.md')).toBe('# c\n');
  });

  it('a trash the platform cannot restore is not undoable', async () => {
    setRestorable(false);
    const r = await F.trash(['notes/a.md']);
    expect(r.entry.undoable).toBe(false);
    expect(J.canUndo()).toBe(false);
    const u = await J.undo(r.entry.id);
    expect(u.ok).toBe(false);
    expect(has('notes/a.md')).toBe(false);
  });

  it('restore puts items back, refuses a taken path, and is undone by trashing again', async () => {
    const t = await F.trash(['notes/a.md', 'notes/b.md']);
    const [a, b] = t.items;
    vault.files.set('notes/b.md', 'a new b\n');
    const seen = [];
    const off = bus.on('paths:restored', (d) => seen.push(d));
    const r = await F.restore([a.id, b.id]);
    off();
    expect(r.restored).toEqual([{ id: a.id, path: 'notes/a.md' }]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].id).toBe(b.id);
    expect(String(r.failed[0].error)).toMatch(/exists/);
    expect(vault.files.get('notes/b.md')).toBe('a new b\n');
    expect(seen).toHaveLength(1);
    expect(r.entry.verb).toBe('restore');
    await J.undo(r.entry.id);
    expect(has('notes/a.md')).toBe(false);
  });

  it('keeps fifty entries, newest first, and tells its subscribers', async () => {
    const seen = [];
    const off = J.on((d) => seen.push(d.entries.length));
    for (let i = 0; i < 26; i += 1) {
      await F.rename('notes/a.md', 'x.md');
      await F.rename('notes/x.md', 'a.md');
    }
    off();
    const list = J.list();
    expect(list).toHaveLength(50);
    expect(list[0].label).toBe('Renamed x.md to a.md');
    expect(seen.at(-1)).toBe(50);
    // A copy: changing it does not change the journal.
    list[0].label = 'changed';
    expect(J.list()[0].label).toBe('Renamed x.md to a.md');
  });
});
