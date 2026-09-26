// The folder view model (CONTRACT §6.2, H15, M22): pure sort, filter and label functions the
// folder view and the tree share. No DOM, no `ose:*`: the module is imported as it is.
//
// Depends on: shell-places (shell/folder-model.js). Skipped until that file exists.

import { describe, expect, it } from 'vitest';

const m = await import('../../shell/folder-model.js');

const file = (name, over = {}) => {
  const dot = name.lastIndexOf('.');
  return { name, path: `f/${name}`, kind: 'file', ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '', mtime: 0, size: 0, hidden: name.startsWith('.'), ...over };
};
const dir = (name, over = {}) => ({ name, path: `f/${name}`, kind: 'dir', ext: '', mtime: 0, size: 0, hidden: name.startsWith('.'), ...over });
const names = (list) => list.map((e) => e.name);

describe('folder-model', () => {
  it('names its sort keys and the default', () => {
    expect(m.SORT_KEYS).toEqual(['name', 'modified', 'size', 'type']);
    expect(m.DEFAULT_SORT).toEqual({ key: 'name', dir: 'asc' });
  });

  it('collates numerically and without case', () => {
    expect(m.collator).toBeInstanceOf(Intl.Collator);
    expect(m.collator.compare('file 2', 'file 10')).toBeLessThan(0);
    expect(m.collator.compare('a', 'A')).toBe(0);
    const o = m.collator.resolvedOptions();
    expect(o.numeric).toBe(true);
    expect(o.sensitivity).toBe('base');
  });

  it('puts folders first under every key and direction, ties broken by name', () => {
    const list = [file('b.md', { mtime: 5, size: 10 }), dir('z'), file('a.md', { mtime: 9, size: 1 }), dir('a'), file('c.txt', { mtime: 5, size: 10 })];
    for (const key of m.SORT_KEYS) {
      for (const d of ['asc', 'desc']) {
        const out = m.sortEntries(list, { key, dir: d });
        expect(out.slice(0, 2).every((e) => e.kind === 'dir'), `${key} ${d}`).toBe(true);
      }
    }
    expect(names(m.sortEntries(list))).toEqual(['a', 'z', 'a.md', 'b.md', 'c.txt']);
    expect(names(m.sortEntries(list, { key: 'name', dir: 'desc' }))).toEqual(['z', 'a', 'c.txt', 'b.md', 'a.md']);
    // b.md and c.txt share an mtime and a size: the name decides.
    expect(names(m.sortEntries(list, { key: 'modified', dir: 'desc' })).slice(2)).toEqual(['a.md', 'b.md', 'c.txt']);
    expect(names(m.sortEntries(list, { key: 'size', dir: 'asc' })).slice(2)).toEqual(['a.md', 'b.md', 'c.txt']);
  });

  it('sorts names like Explorer: 2 before 10, case ignored', () => {
    const list = [file('Note 10.md'), file('note 2.md'), file('note 1.md')];
    expect(names(m.sortEntries(list))).toEqual(['note 1.md', 'note 2.md', 'Note 10.md']);
  });

  it('sorts by type on the extension, then the name', () => {
    const list = [file('b.txt'), file('a.png'), file('c.md'), file('a.md'), file('README')];
    const out = names(m.sortEntries(list, { key: 'type', dir: 'asc' }));
    expect(out.indexOf('a.md')).toBeLessThan(out.indexOf('c.md'));
    expect(out.indexOf('a.md') + 1).toBe(out.indexOf('c.md'));
    expect(out.indexOf('a.png')).toBeGreaterThan(out.indexOf('c.md'));
    expect(out.indexOf('b.txt')).toBeGreaterThan(out.indexOf('a.png'));
  });

  it('answers a new array and leaves the input alone', () => {
    const list = [file('b.md'), file('a.md')];
    const out = m.sortEntries(list);
    expect(out).not.toBe(list);
    expect(names(list)).toEqual(['b.md', 'a.md']);
  });

  it('compareEntries is the comparator sortEntries uses', () => {
    expect(m.compareEntries(dir('z'), file('a.md'))).toBeLessThan(0);
    expect(m.compareEntries(file('a.md'), dir('z'))).toBeGreaterThan(0);
    expect(m.compareEntries(file('a.md'), file('b.md'))).toBeLessThan(0);
    expect(m.compareEntries(file('a.md'), file('b.md'), { key: 'name', dir: 'desc' })).toBeGreaterThan(0);
  });

  it('drops hidden entries unless asked to show them', () => {
    const list = [file('.env'), file('a.md'), dir('.config'), file('b.md', { hidden: true })];
    expect(names(m.visibleEntries(list))).toEqual(['a.md']);
    expect(names(m.visibleEntries(list, { showHidden: true }))).toEqual(['.env', 'a.md', '.config', 'b.md']);
    // Nothing is hidden by name: App, node_modules and _Archive are ordinary.
    expect(names(m.visibleEntries([dir('App'), dir('node_modules'), dir('_Archive')]))).toEqual(['App', 'node_modules', '_Archive']);
  });

  it('labels types the way a file manager does', () => {
    expect(m.typeLabel(dir('x'))).toBe('Folder');
    expect(m.typeLabel(file('a.md'))).toBe('MD file');
    expect(m.typeLabel(file('a.png'))).toBe('PNG image');
    expect(m.typeLabel(file('README'))).toBe('File');
    expect(m.typeLabel(dir('x', { link: 'dir' }))).toBe('Link to folder');
  });

  it('labels sizes: nothing for a folder, bytes, then KB and MB', () => {
    expect(m.sizeLabel(4096, 'dir')).toBe('');
    expect(m.sizeLabel(0, 'file')).toBe('0 bytes');
    expect(m.sizeLabel(1229, 'file')).toBe('1.2 KB');
    expect(m.sizeLabel(3.4 * 1024 * 1024, 'file')).toBe('3.4 MB');
  });

  it('labels dates as today, yesterday, or the date', () => {
    const now = new Date(2026, 8, 26, 16, 0).getTime();
    expect(m.dateLabel(new Date(2026, 8, 26, 14, 2).getTime(), now)).toBe('Today 14:02');
    expect(m.dateLabel(new Date(2026, 8, 25, 9, 10).getTime(), now)).toBe('Yesterday 09:10');
    expect(m.dateLabel(new Date(2026, 8, 12, 9, 10).getTime(), now)).toBe('12 Sept 2026');
  });

  it('reads and writes the per-folder sort, the default taking no room', () => {
    expect(m.sortSpecFor({}, 'notes')).toEqual(m.DEFAULT_SORT);
    expect(m.sortSpecFor(undefined, 'notes')).toEqual(m.DEFAULT_SORT);
    const spec = { key: 'modified', dir: 'desc' };
    const next = m.withSortSpec({}, 'notes', spec);
    expect(next).toEqual({ notes: spec });
    expect(m.sortSpecFor(next, 'notes')).toEqual(spec);
    expect(m.sortSpecFor(next, 'other')).toEqual(m.DEFAULT_SORT);
    // The root folder is '' and is a folder like any other.
    expect(m.sortSpecFor(m.withSortSpec(next, '', spec), '')).toEqual(spec);
    const back = m.withSortSpec(next, 'notes', { ...m.DEFAULT_SORT });
    expect(back).toEqual({});
    expect(next).toEqual({ notes: spec });
  });

  it('finds the README, readme or index to render below', () => {
    expect(m.readmeOf([file('a.md'), file('README.md')])?.name).toBe('README.md');
    expect(m.readmeOf([file('readme.md')])?.name).toBe('readme.md');
    expect(m.readmeOf([file('Index.md')])?.name).toBe('Index.md');
    expect(m.readmeOf([file('index.md'), file('README.md')])?.name).toBe('README.md');
    expect(m.readmeOf([file('a.md'), dir('README.md')])).toBe(null);
    expect(m.readmeOf([])).toBe(null);
  });

  it('knows the parent of a folder, and that the root has none', () => {
    expect(m.parentOf('a/b/c')).toBe('a/b');
    expect(m.parentOf('a')).toBe('');
    expect(m.parentOf('')).toBe(null);
  });
});
