// The dev bridge's filesystem (dev/files.mjs), the Node twin of the host's save path (CONTRACT
// 3.1, 3.2): the hash, saveFile with its compare-and-write, createNew, copyFile, appendLine,
// replaceLine, drafts, versions after a rename, the epoch, and the atomic write that never
// throws the new bytes away. Every test runs on its own temp folder (a vault and an app-data
// folder under the OS temp directory) and removes it; nothing reads or writes a vault.
//
// Depends on: host (dev/files.mjs, dev/bridge-plugin.mjs).

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFiles, hash, writeAtomic } from '../../dev/files.mjs';

let base;
let root;
let data;
let F;       // the commands
let store;   // what createFiles answered

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ose-test-'));
  root = join(base, 'vault');
  data = join(base, 'appdata');
  mkdirSync(root, { recursive: true });
  store = createFiles({ root, dataDir: data, epoch: 1 });
  F = store.files;
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const put = (rel, bytes) => { const f = join(root, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, bytes); };
const get = (rel) => readFileSync(join(root, rel), 'utf8');
const has = (rel) => existsSync(join(root, rel));
/** Every file under `dir`, relative, sorted. */
function walk(dir, pre = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), `${pre}${e.name}/`));
    else out.push(pre + e.name);
  }
  return out.sort();
}
const coded = (code) => new RegExp(`^\\[${code}\\] `);

/** FNV-1a 64 the slow, obvious way, to check the fast one against. */
function fnv(bytes) {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}

describe('hash', () => {
  it('the test vectors of the contract', () => {
    expect(hash('')).toBe('cbf29ce484222325');
    expect(hash('a')).toBe('af63dc4c8601ec8c');
  });

  it('is FNV-1a 64 over the raw bytes, for any bytes', () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
      expect(hash(Buffer.from(bytes))).toBe(fnv(bytes));
    }), { numRuns: 300, seed: 20260925 });
  });

  it('a string is hashed as its UTF-8 bytes', () => {
    expect(hash('été')).toBe(fnv(Buffer.from('été', 'utf8')));
  });
});

describe('saveFile', () => {
  it('creates a missing file when expectedHash is null, folders included', async () => {
    const r = await F.saveFile('a/b/new.md', 'text\n', { expectedHash: null });
    expect(r).toMatchObject({ status: 'saved', hash: hash('text\n') });
    expect(typeof r.mtime).toBe('number');
    expect(get('a/b/new.md')).toBe('text\n');
  });

  it('expectedHash null on a file that exists is a conflict, and nothing is written', async () => {
    put('a.md', 'disk\n');
    const r = await F.saveFile('a.md', 'mine\n', { expectedHash: null });
    expect(r).toEqual({ status: 'conflict', disk: { exists: true, text: 'disk\n', hash: hash('disk\n') } });
    expect(get('a.md')).toBe('disk\n');
  });

  it('a stale expectedHash is a conflict with the disk text', async () => {
    put('a.md', 'changed on disk\n');
    const r = await F.saveFile('a.md', 'mine\n', { expectedHash: hash('what I read\n') });
    expect(r).toEqual({ status: 'conflict', disk: { exists: true, text: 'changed on disk\n', hash: hash('changed on disk\n') } });
    expect(get('a.md')).toBe('changed on disk\n');
  });

  it('a file that went missing is a conflict that says so', async () => {
    const r = await F.saveFile('gone.md', 'mine\n', { expectedHash: hash('old\n') });
    expect(r).toEqual({ status: 'conflict', disk: { exists: false, text: null, hash: null } });
    expect(has('gone.md')).toBe(false);
  });

  it('a disk that is not UTF-8 is a conflict with text null', async () => {
    put('bin.md', Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const r = await F.saveFile('bin.md', 'mine\n', { expectedHash: 'x' });
    expect(r.status).toBe('conflict');
    expect(r.disk.text).toBe(null);
    expect(r.disk.hash).toBe(hash(Buffer.from([0xff, 0xfe, 0x00, 0x41])));
  });

  it('the same bytes already on disk: saved, unchanged, and no version', async () => {
    put('a.md', 'same\n');
    const r = await F.saveFile('a.md', 'same\n', { expectedHash: hash('same\n') });
    expect(r).toMatchObject({ status: 'saved', hash: hash('same\n'), unchanged: true });
    expect(await F.versionList('a.md')).toEqual([]);
  });

  it('a save keeps the bytes it replaced as a version', async () => {
    put('a.md', 'one\n');
    const r = await F.saveFile('a.md', 'two\n', { expectedHash: hash('one\n') });
    expect(r).toMatchObject({ status: 'saved', hash: hash('two\n') });
    expect(r.unchanged).toBeUndefined();
    expect(get('a.md')).toBe('two\n');
    const list = await F.versionList('a.md');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ reason: 'save', session: true, bytes: 4 });
    expect(await F.versionRead('a.md', list[0].id)).toBe('one\n');
  });

  it("version 'none' keeps nothing, 'conflict' forces one", async () => {
    put('a.md', 'one\n');
    await F.saveFile('a.md', 'two\n', { expectedHash: hash('one\n'), version: 'none' });
    expect(await F.versionList('a.md')).toEqual([]);
    await F.saveFile('a.md', 'three\n', { expectedHash: hash('two\n') });
    await F.saveFile('a.md', 'four\n', { expectedHash: hash('three\n'), version: 'conflict' });
    const reasons = (await F.versionList('a.md')).map((v) => v.reason);
    expect(reasons).toEqual(['conflict', 'save']);
  });

  it('non-forced versions: at most one a minute', async () => {
    put('a.md', '1\n');
    await F.saveFile('a.md', '2\n', { expectedHash: hash('1\n') });
    await F.saveFile('a.md', '3\n', { expectedHash: hash('2\n') });
    expect(await F.versionList('a.md')).toHaveLength(1);
  });

  it('keeps versions in .ose/history, with the file\'s own extension', async () => {
    put('notes/data.json', '{}\n');
    await F.saveFile('notes/data.json', '{"a":1}\n', { expectedHash: hash('{}\n') });
    const kept = walk(join(root, '.ose', 'history'));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/\.json$/);
    expect(existsSync(join(root, '.ose', 'versions'))).toBe(false);
  });

  it('refuses a bad argument', async () => {
    await expect(F.saveFile('a.md', 'x', {})).rejects.toThrow(coded('bad_arg'));
    await expect(F.saveFile('a.md', 'x', { expectedHash: null, version: 'maybe' })).rejects.toThrow(coded('bad_arg'));
  });

  it('refuses a path outside the vault', async () => {
    await expect(F.saveFile('../outside.md', 'x', { expectedHash: null })).rejects.toThrow(coded('escapes_vault'));
    expect(existsSync(join(base, 'outside.md'))).toBe(false);
  });

  it('two saves of the same path at once: the second sees the first', async () => {
    put('a.md', '0\n');
    const [r1, r2] = await Promise.all([
      F.saveFile('a.md', '1\n', { expectedHash: hash('0\n') }),
      F.saveFile('a.md', '2\n', { expectedHash: hash('0\n') }),
    ]);
    expect(r1.status).toBe('saved');
    expect(r2).toEqual({ status: 'conflict', disk: { exists: true, text: '1\n', hash: hash('1\n') } });
    expect(get('a.md')).toBe('1\n');
  });
});

describe('the epoch', () => {
  it('a mutating call naming another epoch does nothing and says stale_vault', async () => {
    put('a.md', 'one\n');
    const stale = { epoch: 2 };
    await expect(F.saveFile('a.md', 'two\n', { expectedHash: hash('one\n'), epoch: 2 })).rejects.toThrow(coded('stale_vault'));
    await expect(F.createNew('b.md', 'x', stale)).rejects.toThrow(coded('stale_vault'));
    await expect(F.appendLine('a.md', 'x', stale)).rejects.toThrow(coded('stale_vault'));
    await expect(F.replaceLine('a.md', 0, 'one', 'uno', stale)).rejects.toThrow(coded('stale_vault'));
    await expect(F.copyFile('a.md', 'c.md', stale)).rejects.toThrow(coded('stale_vault'));
    await expect(F.writeText('a.md', 'x', stale)).rejects.toThrow(coded('stale_vault'));
    await expect(F.rename('a.md', 'd.md', stale)).rejects.toThrow(coded('stale_vault'));
    await expect(F.draftWrite('a.md', { text: 'x' }, stale)).rejects.toThrow(coded('stale_vault'));
    expect(walk(root)).toEqual(['a.md']);
    expect(get('a.md')).toBe('one\n');
  });

  it('the current epoch, or none, goes through', async () => {
    await F.createNew('b.md', 'x', { epoch: 1 });
    await F.createNew('c.md', 'y');
    expect(walk(root)).toEqual(['b.md', 'c.md']);
  });
});

describe('createNew and copyFile', () => {
  it('createNew makes the folders and answers the path and the hash', async () => {
    expect(await F.createNew('a/b/c.ext', 'hello')).toEqual({ path: 'a/b/c.ext', hash: hash('hello') });
    expect(get('a/b/c.ext')).toBe('hello');
    expect(await F.createNew('empty.json')).toEqual({ path: 'empty.json', hash: hash('') });
    expect(get('empty.json')).toBe('');
  });

  it('createNew never overwrites', async () => {
    put('a.md', 'keep me\n');
    await expect(F.createNew('a.md', 'no')).rejects.toThrow(coded('exists'));
    expect(get('a.md')).toBe('keep me\n');
  });

  it('createNew refuses a name no disk can hold', async () => {
    await expect(F.createNew('bad?.md', '')).rejects.toThrow(coded('bad_name'));
    await expect(F.createNew('dot.', '')).rejects.toThrow(coded('bad_name'));
  });

  it('copyFile copies the bytes, whatever they are, and never overwrites', async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
    put('img.bin', bytes);
    expect(await F.copyFile('img.bin', 'img 2.bin')).toEqual({ path: 'img 2.bin', hash: hash(bytes) });
    expect(readFileSync(join(root, 'img 2.bin')).equals(bytes)).toBe(true);
    await expect(F.copyFile('img.bin', 'img 2.bin')).rejects.toThrow(coded('exists'));
    await expect(F.copyFile('nope.bin', 'x.bin')).rejects.toThrow(coded('not_found'));
  });
});

describe('appendLine', () => {
  const cases = [
    ['a missing file', null, 'x', 'x\n'],
    ['an empty file', '', 'x', 'x\n'],
    ['a file ending in a newline', 'a\n', 'x', 'a\nx\n'],
    ['a file with no final newline', 'a', 'x', 'a\nx\n'],
    ['a CRLF file', 'a\r\nb\r\n', 'x', 'a\r\nb\r\nx\r\n'],
    ['a CRLF file with no final newline', 'a\r\nb', 'x', 'a\r\nb\r\nx\r\n'],
    ['a file whose last ending is LF', 'a\r\nb\n', 'x', 'a\r\nb\nx\n'],
  ];
  for (const [name, before, line, after] of cases) {
    it(name, async () => {
      if (before !== null) put('log/sys.log', before);
      const r = await F.appendLine('log/sys.log', line);
      expect(get('log/sys.log')).toBe(after);
      expect(r).toEqual({ hash: hash(after) });
    });
  }

  it('refuses a line with a line break in it', async () => {
    await expect(F.appendLine('a.log', 'one\ntwo')).rejects.toThrow(coded('bad_arg'));
    await expect(F.appendLine('a.log', 'one\rtwo')).rejects.toThrow(coded('bad_arg'));
    expect(has('a.log')).toBe(false);
  });

  it('keeps no version', async () => {
    put('a.log', 'a\n');
    await F.appendLine('a.log', 'b');
    expect(await F.versionList('a.log')).toEqual([]);
  });
});

describe('replaceLine', () => {
  it('replaces one line when it still says what was expected, every other byte kept', async () => {
    put('todo.md', '- [ ] a\r\n- [ ] b\r\n- [ ] c');
    const r = await F.replaceLine('todo.md', 1, '- [ ] b', '- [x] b');
    expect(r).toEqual({ status: 'replaced', hash: hash('- [ ] a\r\n- [x] b\r\n- [ ] c') });
    expect(get('todo.md')).toBe('- [ ] a\r\n- [x] b\r\n- [ ] c');
  });

  it('the last line, with no newline after it', async () => {
    put('todo.md', 'a\nb');
    await F.replaceLine('todo.md', 1, 'b', 'B');
    expect(get('todo.md')).toBe('a\nB');
  });

  it('a line that changed is a conflict with what it says now', async () => {
    put('todo.md', 'a\nchanged\nc\n');
    expect(await F.replaceLine('todo.md', 1, 'b', 'B')).toEqual({ status: 'conflict', actual: 'changed' });
    expect(get('todo.md')).toBe('a\nchanged\nc\n');
  });

  it('an index out of range is a conflict with actual null', async () => {
    put('todo.md', 'a\nb\n');
    expect(await F.replaceLine('todo.md', 7, 'x', 'y')).toEqual({ status: 'conflict', actual: null });
    expect(await F.replaceLine('todo.md', -1, 'x', 'y')).toEqual({ status: 'conflict', actual: null });
  });

  it('a missing file is not_found', async () => {
    await expect(F.replaceLine('none.md', 0, 'a', 'b')).rejects.toThrow(coded('not_found'));
  });

  it('keeps a version of what it replaced', async () => {
    put('todo.md', 'a\nb\n');
    await F.replaceLine('todo.md', 0, 'a', 'A');
    const list = await F.versionList('todo.md');
    expect(list).toHaveLength(1);
    expect(await F.versionRead('todo.md', list[0].id)).toBe('a\nb\n');
  });
});

describe('drafts', () => {
  const draft = { text: 'unsaved buffer\n', baselineHash: hash('disk\n'), mode: 'rich', exact: true, rev: 7 };

  it('round trip: what is written is what is read, with the time set by the host', async () => {
    const before = Date.now();
    const { at } = await F.draftWrite('notes/a.md', draft);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(await F.draftRead('notes/a.md')).toEqual({ path: 'notes/a.md', ...draft, at });
    expect(await F.draftRead('notes/other.md')).toBe(null);
  });

  it('lives outside the vault, in the app-data folder', async () => {
    await F.draftWrite('a.md', draft);
    expect(walk(root)).toEqual([]);
    const kept = walk(join(data, 'drafts'));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/\.json$/);
  });

  it('draftList: the info without the text, newest first, this vault only', async () => {
    await F.draftWrite('a.md', draft);
    await new Promise((r) => setTimeout(r, 5));
    await F.draftWrite('b.md', { ...draft, text: 'x', rev: 1, mode: 'source', exact: false, baselineHash: null });
    const list = await F.draftList();
    expect(list.map((d) => d.path)).toEqual(['b.md', 'a.md']);
    expect(list[0]).toEqual({ path: 'b.md', baselineHash: null, mode: 'source', exact: false, rev: 1, at: list[0].at, bytes: 1 });
    expect('text' in list[1]).toBe(false);
    const other = createFiles({ root: join(base, 'other-vault'), dataDir: data, epoch: 1 }).files;
    expect(await other.draftList()).toEqual([]);
  });

  it('draftDrop with ifRev drops only a draft no newer than it', async () => {
    await F.draftWrite('a.md', draft);
    expect(await F.draftDrop('a.md', { ifRev: 6 })).toEqual({ dropped: false });
    expect(await F.draftRead('a.md')).not.toBe(null);
    expect(await F.draftDrop('a.md', { ifRev: 7 })).toEqual({ dropped: true });
    expect(await F.draftRead('a.md')).toBe(null);
    await F.draftWrite('a.md', draft);
    expect(await F.draftDrop('a.md')).toEqual({ dropped: true });
    expect(await F.draftDrop('a.md')).toEqual({ dropped: false });
  });

  it('a draft holds the text exactly, whatever it is', async () => {
    const text = '# T\r\n\r\nété \u{1F600} \\ "q" \u0000 end';
    await F.draftWrite('a.md', { ...draft, text });
    expect((await F.draftRead('a.md')).text).toBe(text);
  });
});

describe('rename and trash carry history and drafts', () => {
  it('a rename moves the file\'s versions and its draft', async () => {
    put('a.md', 'one\n');
    await F.saveFile('a.md', 'two\n', { expectedHash: hash('one\n') });
    await F.draftWrite('a.md', { text: 'three\n', baselineHash: hash('two\n'), mode: 'rich', exact: true, rev: 1 });
    await F.rename('a.md', 'notes/b.md');
    expect(await F.versionList('a.md')).toEqual([]);
    const list = await F.versionList('notes/b.md');
    expect(list).toHaveLength(1);
    expect(await F.versionRead('notes/b.md', list[0].id)).toBe('one\n');
    expect(await F.draftRead('a.md')).toBe(null);
    expect((await F.draftRead('notes/b.md')).text).toBe('three\n');
  });

  it('a folder rename moves everything under it', async () => {
    put('notes/a.md', 'one\n');
    await F.saveFile('notes/a.md', 'two\n', { expectedHash: hash('one\n') });
    await F.draftWrite('notes/a.md', { text: 'x', rev: 1 });
    await F.rename('notes', 'papers');
    expect(await F.versionList('papers/a.md')).toHaveLength(1);
    expect((await F.draftRead('papers/a.md')).text).toBe('x');
  });

  it('trash leaves history and drafts where they are', async () => {
    put('a.md', 'one\n');
    await F.saveFile('a.md', 'two\n', { expectedHash: hash('one\n') });
    await F.draftWrite('a.md', { text: 'x', rev: 1 });
    await F.trash('a.md', { mode: 'vault' });
    expect(has('a.md')).toBe(false);
    expect(await F.versionList('a.md')).toHaveLength(1);
    expect(await F.draftRead('a.md')).not.toBe(null);
  });

  it('an old .ose/versions folder becomes .ose/history, old ids still valid', async () => {
    put('.ose/versions/a.md/2026-01-01-120000.md', 'old\n');
    put('a.md', 'now\n');
    const list = await F.versionList('a.md');
    expect(list.map((v) => v.id)).toContain('2026-01-01-120000');
    expect(await F.versionRead('a.md', '2026-01-01-120000')).toBe('old\n');
    expect(existsSync(join(root, '.ose', 'history'))).toBe(true);
  });
});

describe('writeAtomic', () => {
  it('replaces the target and leaves no temp file behind', async () => {
    put('a.md', 'old\n');
    await writeAtomic(join(root, 'a.md'), 'new\n');
    expect(get('a.md')).toBe('new\n');
    expect(walk(root)).toEqual(['a.md']);
  });

  it('when the rename cannot happen, the new bytes are kept in a visible file and the old file survives', async () => {
    // The target is a folder holding a file: no rename can replace it, on any system. The
    // write must fail without deleting either side, and say where the new bytes are.
    mkdirSync(join(root, 'target.md'));
    put('target.md/inside.txt', 'old\n');
    let err = null;
    try { await writeAtomic(join(root, 'target.md'), 'new bytes\n', { budget: 50 }); } catch (e) { err = e; }
    expect(err).not.toBe(null);
    expect(typeof err.kept).toBe('string');
    expect(readFileSync(err.kept, 'utf8')).toBe('new bytes\n');
    expect(get('target.md/inside.txt')).toBe('old\n');
    expect(walk(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('the temp file held open while the rename runs: the bytes still land', async () => {
    put('a.md', 'old\n');
    let held = null;
    await writeAtomic(join(root, 'a.md'), 'new\n', {
      beforeRename: async (tmp) => { held = statSync(tmp).size; },
    });
    expect(held).toBe(4);
    expect(get('a.md')).toBe('new\n');
  });
});

describe('the log', () => {
  it('writes "<stamp> <level> ui: <text>" to the log file', async () => {
    await F.log('hello', 'warn');
    const text = readFileSync(store.logPath, 'utf8');
    expect(text).toMatch(/^\S+ \S+ warn ui: hello\n$/);
  });
});
