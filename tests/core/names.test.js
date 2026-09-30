// ose.names (CONTRACT 4.5, H12, H13): a name is literal, the extension is whatever follows the
// last dot, and the free name is `stem 2.ext`.
//
// Depends on: core (src/core/names.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reset } from './fake-bridge.js';
import { check, extChanged, free, split } from '../../src/core/names.ts';

vi.mock('../../src/core/bridge/index.ts', () => import('./fake-bridge.js'));

describe('names.split', () => {
  it.each([
    ['notes.md', { stem: 'notes', ext: 'md' }],
    ['a.tar.gz', { stem: 'a.tar', ext: 'gz' }],
    ['README', { stem: 'README', ext: '' }],
    ['.env', { stem: '.env', ext: '' }],
    ['.config.json', { stem: '.config', ext: 'json' }],
    ['trailing.', { stem: 'trailing.', ext: '' }],
    ['folder/sub/file.txt', { stem: 'file', ext: 'txt' }],
  ])('%s', (name, want) => {
    expect(split(name)).toEqual(want);
  });
});

describe('names.check', () => {
  it('accepts any extension, and none', () => {
    for (const n of ['a.md', 'a.txt', 'a.json', 'script.py', 'Makefile', '.env', 'notes 2.md', 'été à Paris.md']) {
      expect(check(n), n).toEqual({ ok: true, name: n });
    }
  });

  it('trims surrounding whitespace and nothing else', () => {
    expect(check('  a b.md \t')).toEqual({ ok: true, name: 'a b.md' });
  });

  it.each([
    [''], ['   '], ['.'], ['..'],
    ['a\\b.md'], ['a:b.md'], ['a*.md'], ['a?.md'], ['a".md'], ['a<b.md'], ['a>b.md'], ['a|b.md'],
    ['a\u0001b.md'], ['a\u007f.md'],
    ['ends with dot.'], ['CON'], ['con.txt'], ['Nul.md'], ['COM1'], ['lpt9.log'], ['aux'],
    ['x'.repeat(256)],
  ])('refuses %j', (name) => {
    const r = check(name);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('a trailing space is trimmed, not refused', () => {
    expect(check('a.md ')).toEqual({ ok: true, name: 'a.md' });
  });

  it('allows 255 characters', () => {
    expect(check('x'.repeat(251) + '.txt').ok).toBe(true);
  });

  it('refuses / unless folders are allowed, then checks every segment', () => {
    expect(check('a/b.md').ok).toBe(false);
    expect(check('a/b/c.ext', { folders: true })).toEqual({ ok: true, name: 'a/b/c.ext' });
    expect(check('a//b.md', { folders: true }).ok).toBe(false);
    expect(check('a/con/b.md', { folders: true }).ok).toBe(false);
    expect(check('a/b./c.md', { folders: true }).ok).toBe(false);
    expect(check('a/../c.md', { folders: true }).ok).toBe(false);
  });

  it('is not fooled by COM10 or a stem that only starts like a reserved one', () => {
    expect(check('COM10').ok).toBe(true);
    expect(check('console.log').ok).toBe(true);
    expect(check('nulls.md').ok).toBe(true);
  });
});

describe('names.free', () => {
  beforeEach(() => reset({ 'notes/a.md': '# a\n', 'notes/a 2.md': '', 'b.txt': '', 'Makefile': '' }));

  it('the name itself when it is free', async () => {
    expect(await free('notes', 'new.md')).toBe('notes/new.md');
  });

  it('stem 2, 3, … with the extension kept', async () => {
    expect(await free('notes', 'a.md')).toBe('notes/a 3.md');
    expect(await free('', 'b.txt')).toBe('b 2.txt');
  });

  it('a name with no extension', async () => {
    expect(await free('', 'Makefile')).toBe('Makefile 2');
  });

  it('the vault root', async () => {
    expect(await free('', 'c.md')).toBe('c.md');
  });
});

describe('names.extChanged', () => {
  it.each([
    ['a.md', 'a.MD', false],
    ['a.md', 'b.md', false],
    ['a.md', 'a.txt', true],
    ['a.md', 'a', true],
    ['a', 'b', false],
    ['a.tar.gz', 'a.gz', false],
  ])('%s -> %s: %s', (a, b, want) => {
    expect(extChanged(a, b)).toBe(want);
  });
});
