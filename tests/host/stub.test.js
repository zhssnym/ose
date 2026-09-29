// @vitest-environment happy-dom
// The in-memory File System Access API (tests/stubs/fsa.js) that the Ose Web tests run on, and
// the IndexedDB helper's memory backend (src/host/idb.ts): both behave as the modules under
// test will expect Chrome to (docs/HOST.md "Testing").

import { afterEach, describe, expect, it } from 'vitest';
import { createFsa } from '../stubs/fsa.js';
import * as idb from '../../src/host/idb.ts';

const names = async (dir) => { const out = []; for await (const [n] of dir.entries()) out.push(n); return out.sort(); };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('fsa stub', () => {
  it('walks, reads and lists what was seeded', async () => {
    const fsa = createFsa({ files: { 'a.md': '# A\n', 'notes/b.md': 'b', 'notes/deep/c.txt': 'c' } });
    expect(await names(fsa.root)).toEqual(['a.md', 'notes']);
    const notes = await fsa.root.getDirectoryHandle('notes');
    expect(notes.kind).toBe('directory');
    const b = await notes.getFileHandle('b.md');
    const file = await b.getFile();
    expect(await file.text()).toBe('b');
    expect(file.size).toBe(1);
    expect(typeof file.lastModified).toBe('number');
    expect(await fsa.root.resolve(b)).toEqual(['notes', 'b.md']);
    expect(fsa.list()).toEqual(['a.md', 'notes/', 'notes/b.md', 'notes/deep/', 'notes/deep/c.txt']);
  });

  it('refuses what Chrome refuses', async () => {
    const fsa = createFsa({ files: { 'a.md': 'a', 'd/x': 'x' } });
    await expect(fsa.root.getFileHandle('missing.md')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(fsa.root.getFileHandle('d')).rejects.toMatchObject({ name: 'TypeMismatchError' });
    await expect(fsa.root.getDirectoryHandle('a.md')).rejects.toMatchObject({ name: 'TypeMismatchError' });
    await expect(fsa.root.getFileHandle('..')).rejects.toThrow(TypeError);
    await expect(fsa.root.getFileHandle('a/b')).rejects.toThrow(TypeError);
    await expect(fsa.root.removeEntry('d')).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await fsa.root.removeEntry('d', { recursive: true });
    expect(fsa.exists('d')).toBe(false);
  });

  it('writes through a swap file and replaces the target on close', async () => {
    const fsa = createFsa({ files: { 'a.md': 'old' } });
    const h = await fsa.root.getFileHandle('a.md');
    const w = await h.createWritable();
    await w.write('new ');
    await w.write(new TextEncoder().encode('bytes'));
    expect(fsa.readText('a.md')).toBe('old');
    expect(fsa.exists('a.md.crswap')).toBe(true);
    await w.close();
    expect(fsa.readText('a.md')).toBe('new bytes');
    expect(fsa.exists('a.md.crswap')).toBe(false);

    const w2 = await h.createWritable();
    await w2.write('never');
    await w2.abort();
    expect(fsa.readText('a.md')).toBe('new bytes');

    const w3 = await h.createWritable({ keepExistingData: true });
    await w3.write({ type: 'write', position: 0, data: 'N' });
    await w3.close();
    expect(fsa.readText('a.md')).toBe('New bytes');
  });

  it('creates files and folders on request, and keeps bytes exact', async () => {
    const fsa = createFsa();
    const d = await fsa.root.getDirectoryHandle('new', { create: true });
    const f = await d.getFileHandle('x.md', { create: true });
    const w = await f.createWritable();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    await w.write(bytes);
    await w.close();
    expect([...fsa.read('new/x.md')]).toEqual([...bytes]);
    expect(fsa.readText('new/x.md')).toBe('﻿a\r\n');
  });

  it('handles are path-based: a moved file is gone from the old handle', async () => {
    const fsa = createFsa({ files: { 'a.md': 'a', 'b.md': 'b' }, dirs: ['into'] });
    const a = await fsa.root.getFileHandle('a.md');
    const old = await fsa.root.getFileHandle('a.md');
    await expect(a.move('b.md')).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await a.move(await fsa.root.getDirectoryHandle('into'), 'moved.md');
    expect(fsa.readText('into/moved.md')).toBe('a');
    expect(fsa.exists('a.md')).toBe(false);
    expect(await (await a.getFile()).text()).toBe('a');
    await expect(old.getFile()).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await a.isSameEntry(await fsa.root.getDirectoryHandle('into').then((d) => d.getFileHandle('moved.md')))).toBe(true);
    expect(await a.isSameEntry(fsa.outsideFile('moved.md', 'a'))).toBe(false);
  });

  it('moves folders unless told Chrome cannot', async () => {
    const yes = createFsa({ files: { 'd/x.md': 'x' } });
    await (await yes.root.getDirectoryHandle('d')).move('e');
    expect(yes.readText('e/x.md')).toBe('x');
    const no = createFsa({ files: { 'd/x.md': 'x' }, dirMove: false });
    await expect((await no.root.getDirectoryHandle('d')).move('e')).rejects.toMatchObject({ name: 'NotSupportedError' });
  });

  it('folds case when asked', async () => {
    const fsa = createFsa({ files: { 'Notes/A.md': 'a' }, foldCase: true });
    const h = await (await fsa.root.getDirectoryHandle('notes')).getFileHandle('a.MD');
    expect(h.name).toBe('A.md');
    expect(fsa.readText('NOTES/a.md')).toBe('a');
  });

  it('answers and asks permission', async () => {
    const fsa = createFsa({ permission: 'prompt' });
    expect(await fsa.root.queryPermission({ mode: 'readwrite' })).toBe('prompt');
    fsa.permission.answer = 'denied';
    expect(await fsa.root.requestPermission({ mode: 'readwrite' })).toBe('denied');
    fsa.permission.answer = 'granted';
    expect(await fsa.root.requestPermission({ mode: 'readwrite' })).toBe('granted');
    expect(fsa.permission.requests).toBe(2);
  });

  it('injects a fault once', async () => {
    const fsa = createFsa({ files: { 'a.md': 'a' } });
    fsa.fail('close', 'a.md', 'QuotaExceededError');
    const w = await (await fsa.root.getFileHandle('a.md')).createWritable();
    await w.write('b');
    await expect(w.close()).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(fsa.readText('a.md')).toBe('a');
    expect(fsa.exists('a.md.crswap')).toBe(false);
    const w2 = await (await fsa.root.getFileHandle('a.md')).createWritable();
    await w2.write('b');
    await w2.close();
    expect(fsa.readText('a.md')).toBe('b');
  });

  it('loses the root and gets it back', async () => {
    const fsa = createFsa({ files: { 'a.md': 'a' } });
    fsa.loseRoot();
    await expect(names(fsa.root)).rejects.toMatchObject({ name: 'NotFoundError' });
    fsa.restoreRoot();
    expect(await names(fsa.root)).toEqual(['a.md']);
  });

  it('reports changes, outside and own, to an observer', async () => {
    const fsa = createFsa({ files: { 'a.md': 'a', 'd/b.md': 'b' } });
    const off = fsa.install();
    try {
      const seen = [];
      const obs = new globalThis.FileSystemObserver((records) => {
        for (const r of records) seen.push([r.type, r.relativePathComponents.join('/'), r.relativePathMovedFrom ? r.relativePathMovedFrom.join('/') : null, r.changedHandle.kind]);
      });
      await obs.observe(fsa.root, { recursive: true });
      fsa.write('a.md', 'changed');
      fsa.write('new.md', 'n');
      fsa.rename('d/b.md', 'd/c.md');
      fsa.remove('new.md');
      await tick();
      expect(seen).toEqual([
        ['modified', 'a.md', null, 'file'],
        ['appeared', 'new.md', null, 'file'],
        ['moved', 'd/c.md', 'd/b.md', 'file'],
        ['disappeared', 'new.md', null, 'file'],
      ]);
      seen.length = 0;
      const w = await (await fsa.root.getFileHandle('a.md')).createWritable();
      await w.write('own');
      await w.close();
      await tick();
      expect(seen.filter((s) => s[1] === 'a.md')).toEqual([['modified', 'a.md', null, 'file']]);
      expect(seen.some((s) => s[1] === 'a.md.crswap')).toBe(true);
      obs.disconnect();
      const before = seen.length;
      fsa.write('a.md', 'after');
      await tick();
      expect(seen.length).toBe(before);
    } finally { off(); }
    expect('FileSystemObserver' in globalThis).toBe(false);
  });

  it('installs the pickers', async () => {
    const fsa = createFsa({ files: { 'a.md': 'a' } });
    const off = fsa.install();
    try {
      expect(await globalThis.showDirectoryPicker({ mode: 'readwrite' })).toBe(fsa.root);
      fsa.pickFiles = [fsa.outsideFile('far.md', 'far')];
      const [h] = await globalThis.showOpenFilePicker();
      expect(await (await h.getFile()).text()).toBe('far');
      fsa.cancel = true;
      await expect(globalThis.showDirectoryPicker()).rejects.toMatchObject({ name: 'AbortError' });
    } finally { off(); }
  });
});

describe('idb memory backend', () => {
  afterEach(() => idb.resetMemory());

  it('stores, lists and deletes', async () => {
    idb.useMemory();
    await idb.put('local', { a: 1 }, 'app');
    await idb.put('drafts', { text: 'x' }, 'k/1');
    await idb.put('drafts', { text: 'y' }, 'k/0');
    expect(await idb.get('local', 'app')).toEqual({ a: 1 });
    expect((await idb.entries('drafts')).map(([k]) => k)).toEqual(['k/0', 'k/1']);
    const k1 = await idb.put('log', 'one');
    const k2 = await idb.put('log', 'two');
    expect(k2).toBeGreaterThan(/** @type {number} */ (k1));
    expect(await idb.count('log')).toBe(2);
    await idb.del('drafts', 'k/0');
    expect(await idb.get('drafts', 'k/0')).toBeUndefined();
    const fsa = createFsa();
    await idb.put('vaults', { id: 'v', handle: fsa.root }, 'v');
    expect((await idb.get('vaults', 'v')).handle).toBe(fsa.root);
  });
});
