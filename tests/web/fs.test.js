// Module fs of Ose Web (src/web/fs.js) on the in-memory File System Access API
// (tests/stubs/fsa.js): the same cases as tests/dev-bridge/files.test.js where the semantics are
// shared (the save path, creates, appendLine, replaceLine, versions, the epoch), plus the
// browser's own: the last look before close(), the set-aside when close() fails, a folder
// Chrome will not move, a case-only rename on a folding disk, the vault bin, the listings under
// the one hide rule, search, the encodings and files outside the vault. Never a real vault.

import { beforeEach, describe, expect, it } from 'vitest';
import { createFs, fromBase64, survivors, toBase64 } from '../../src/web/fs.js';
import { hash } from '../../src/web/rules.js';
import { createFsa } from '../stubs/fsa.js';

const enc = new TextEncoder();
/** @type {ReturnType<typeof createFsa>} */
let fsa;
/** @type {any} */
let F;
let epoch = 1;
/** @type {string[]} */
let logs = [];
/** @type {[string, string][]} */
let renames = [];
/** @type {Map<string, FileSystemFileHandle>} */
let outside;
let clock = 0;

/** @param {Parameters<typeof createFsa>[0]} [o] @param {Partial<Parameters<typeof createFs>[1]>} [extra] */
function setup(o = {}, extra = {}) {
  fsa = createFsa(o);
  epoch = 1;
  logs = [];
  renames = [];
  outside = new Map();
  clock = 0;
  F = createFs(fsa.root, {
    vaultId: 'v1',
    epoch: () => epoch,
    os: 'linux',
    log: (level, text) => { logs.push(`${level} ${text}`); },
    outside: { handle: async (p) => outside.get(p) || null },
    onRename: async (a, b) => { renames.push([a, b]); },
    now: () => Date.now() + clock,
    ...extra,
  });
  return F;
}
beforeEach(() => { setup(); });

/** @param {string} code */
const coded = (code) => expect.objectContaining({ code });
const tree = () => fsa.list();
/** Every file under `.ose/history`, relative to it. */
const history = () => fsa.list().filter((p) => p.startsWith('.ose/history/') && !p.endsWith('/')).map((p) => p.slice('.ose/history/'.length));

/** Run `hook` once, right after the next writable's write(): between the write and the last
 *  look before close(), where another program's change must be caught. @param {() => void | Promise<void>} hook */
async function afterNextWrite(hook) {
  fsa.seed({ '__probe': '' });
  const w = await (/** @type {any} */ (fsa.handle('__probe'))).createWritable();
  const proto = Object.getPrototypeOf(w);
  await w.abort();
  fsa.remove('__probe');
  const write = proto.write;
  proto.write = async function patched(/** @type {any} */ data) {
    proto.write = write;
    await write.call(this, data);
    await hook();
  };
  return () => { proto.write = write; };
}

describe('saveFile', () => {
  it('creates a missing file when expectedHash is null, folders included, no swap file left', async () => {
    const r = await F.saveFile('a/b/new.md', 'text\n', { expectedHash: null });
    expect(r).toMatchObject({ status: 'saved', hash: hash('text\n') });
    expect(typeof r.mtime).toBe('number');
    expect(fsa.readText('a/b/new.md')).toBe('text\n');
    expect(tree().some((p) => p.endsWith('.crswap'))).toBe(false);
  });

  it('expectedHash null on a file that exists is a conflict, and nothing is written', async () => {
    fsa.seed({ 'a.md': 'disk\n' });
    const r = await F.saveFile('a.md', 'mine\n', { expectedHash: null });
    expect(r).toEqual({ status: 'conflict', disk: { exists: true, text: 'disk\n', hash: hash('disk\n') } });
    expect(fsa.readText('a.md')).toBe('disk\n');
  });

  it('a stale expectedHash is a conflict with the disk text', async () => {
    fsa.seed({ 'a.md': 'changed on disk\n' });
    const r = await F.saveFile('a.md', 'mine\n', { expectedHash: hash('what I read\n') });
    expect(r).toEqual({ status: 'conflict', disk: { exists: true, text: 'changed on disk\n', hash: hash('changed on disk\n') } });
    expect(fsa.readText('a.md')).toBe('changed on disk\n');
    expect(logs.some((l) => l === 'warn save conflict a.md')).toBe(true);
  });

  it('a file that went missing is a conflict that says so', async () => {
    const r = await F.saveFile('gone.md', 'mine\n', { expectedHash: hash('old\n') });
    expect(r).toEqual({ status: 'conflict', disk: { exists: false, text: null, hash: null } });
    expect(fsa.exists('gone.md')).toBe(false);
  });

  it('a disk that is not UTF-8 is a conflict with text null', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    fsa.seed({ 'bin.md': bytes });
    const r = await F.saveFile('bin.md', 'mine\n', { expectedHash: 'x' });
    expect(r.status).toBe('conflict');
    expect(r.disk.text).toBe(null);
    expect(r.disk.hash).toBe(hash(bytes));
  });

  it('the same bytes already on disk: saved, unchanged, and no version', async () => {
    fsa.seed({ 'a.md': 'same\n' });
    const r = await F.saveFile('a.md', 'same\n', { expectedHash: hash('same\n') });
    expect(r).toMatchObject({ status: 'saved', hash: hash('same\n'), unchanged: true });
    expect(await F.versionList('a.md')).toEqual([]);
  });

  it('a save keeps the bytes it replaced as a version', async () => {
    fsa.seed({ 'a.md': 'one\n' });
    const r = await F.saveFile('a.md', 'two\n', { expectedHash: hash('one\n') });
    expect(r).toMatchObject({ status: 'saved', hash: hash('two\n') });
    expect(r.unchanged).toBeUndefined();
    expect(fsa.readText('a.md')).toBe('two\n');
    const list = await F.versionList('a.md');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ reason: 'save', session: true, bytes: 4 });
    expect(await F.versionRead('a.md', list[0].id)).toBe('one\n');
    expect(logs).toContain('info save ok a.md');
  });

  it("version 'none' keeps nothing, 'conflict' forces one", async () => {
    fsa.seed({ 'a.md': 'one\n' });
    await F.saveFile('a.md', 'two\n', { expectedHash: hash('one\n'), version: 'none' });
    expect(await F.versionList('a.md')).toEqual([]);
    await F.saveFile('a.md', 'three\n', { expectedHash: hash('two\n') });
    await F.saveFile('a.md', 'four\n', { expectedHash: hash('three\n'), version: 'conflict' });
    expect((await F.versionList('a.md')).map((v) => v.reason)).toEqual(['conflict', 'save']);
  });

  it('non-forced versions: at most one a minute; a minute later another', async () => {
    fsa.seed({ 'a.md': '1\n' });
    await F.saveFile('a.md', '2\n', { expectedHash: hash('1\n') });
    await F.saveFile('a.md', '3\n', { expectedHash: hash('2\n') });
    expect(await F.versionList('a.md')).toHaveLength(1);
    clock = 61_000;
    await F.saveFile('a.md', '4\n', { expectedHash: hash('3\n') });
    const list = await F.versionList('a.md');
    expect(list).toHaveLength(2);
    expect(list[0].session).toBe(false);
  });

  it("keeps versions in .ose/history, with the file's own extension, the desktop's names", async () => {
    fsa.seed({ 'notes/data.json': '{}\n' });
    await F.saveFile('notes/data.json', '{"a":1}\n', { expectedHash: hash('{}\n') });
    const kept = history();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^notes\/data\.json\/\d{4}-\d{2}-\d{2}-\d{6}\.save-s\.json$/);
  });

  it('refuses a bad argument', async () => {
    await expect(F.saveFile('a.md', 'x', {})).rejects.toEqual(coded('bad_arg'));
    await expect(F.saveFile('a.md', 1, { expectedHash: null })).rejects.toEqual(coded('bad_arg'));
    await expect(F.saveFile('a.md', 'x', { expectedHash: 5 })).rejects.toEqual(coded('bad_arg'));
    await expect(F.saveFile('a.md', 'x', { expectedHash: null, version: 'maybe' })).rejects.toEqual(coded('bad_arg'));
    expect(logs.some((l) => l.startsWith('error save failed a.md: [bad_arg]'))).toBe(true);
  });

  it('refuses a path outside the vault', async () => {
    await expect(F.saveFile('../outside.md', 'x', { expectedHash: null })).rejects.toEqual(coded('escapes_vault'));
    await expect(F.saveFile('abs:/nowhere.md', 'x', { expectedHash: null })).rejects.toEqual(coded('not_registered'));
  });

  it('two saves of the same path at once: the second sees the first', async () => {
    fsa.seed({ 'a.md': '0\n' });
    const [r1, r2] = await Promise.all([
      F.saveFile('a.md', '1\n', { expectedHash: hash('0\n') }),
      F.saveFile('a.md', '2\n', { expectedHash: hash('0\n') }),
    ]);
    expect(r1.status).toBe('saved');
    expect(r2).toEqual({ status: 'conflict', disk: { exists: true, text: '1\n', hash: hash('1\n') } });
    expect(fsa.readText('a.md')).toBe('1\n');
  });

  it('the last look: a change on disk just before close() aborts the write and is the conflict', async () => {
    fsa.seed({ 'a.md': 'one\n' });
    await afterNextWrite(() => { fsa.write('a.md', 'theirs\n'); });
    const r = await F.saveFile('a.md', 'mine\n', { expectedHash: hash('one\n') });
    expect(r).toEqual({ status: 'conflict', disk: { exists: true, text: 'theirs\n', hash: hash('theirs\n') } });
    expect(fsa.readText('a.md')).toBe('theirs\n');
    expect(tree().some((p) => p.endsWith('.crswap'))).toBe(false);
    expect(await F.versionList('a.md')).toEqual([]);
  });

  it('the last look on a new file: one made meanwhile wins; nothing of ours is left', async () => {
    await afterNextWrite(() => { fsa.write('n.md', 'theirs\n'); });
    const r = await F.saveFile('n.md', 'mine\n', { expectedHash: null });
    expect(r.status).toBe('conflict');
    expect(fsa.readText('n.md')).toBe('theirs\n');
  });

  it('a close() that fails keeps the new bytes in a visible .unsaved- file and the old file', async () => {
    fsa.seed({ 'notes/a.md': 'old\n' });
    fsa.fail('close', 'notes/a.md', 'NoModificationAllowedError');
    const err = await F.saveFile('notes/a.md', 'new\n', { expectedHash: hash('old\n') }).catch((e) => e);
    expect(err.code).toBe('write_failed');
    expect(err.message).toMatch(/your text is in notes\/a\.unsaved-\d{8}-\d{6}\.md$/);
    expect(fsa.readText('notes/a.md')).toBe('old\n');
    const aside = err.message.split('your text is in ')[1];
    expect(fsa.readText(aside)).toBe('new\n');
    // A retry that fails again replaces the same copy: one file per target.
    fsa.fail('close', 'notes/a.md', 'NoModificationAllowedError');
    await F.saveFile('notes/a.md', 'newer\n', { expectedHash: hash('old\n') }).catch(() => {});
    expect(tree().filter((p) => p.includes('.unsaved-'))).toEqual([aside]);
    expect(fsa.readText(aside)).toBe('newer\n');
  });

  it('a failed close() on a new file leaves no empty file behind', async () => {
    fsa.fail('close', 'new.md', 'NoModificationAllowedError');
    await expect(F.saveFile('new.md', 'x', { expectedHash: null })).rejects.toEqual(coded('write_failed'));
    expect(fsa.exists('new.md')).toBe(false);
  });

  it('a lost vault is no_vault, and nothing is recreated', async () => {
    fsa.loseRoot();
    await expect(F.saveFile('a.md', 'x', { expectedHash: null })).rejects.toEqual(coded('no_vault'));
    await expect(F.createNew('b.md', 'x')).rejects.toEqual(coded('no_vault'));
    await expect(F.setState({ a: 1 })).rejects.toEqual(coded('no_vault'));
    fsa.restoreRoot();
    expect(tree()).toEqual([]);
  });

  it('withdrawn permission is no_vault', async () => {
    fsa.permission.permission = 'prompt';
    await expect(F.saveFile('a.md', 'x', { expectedHash: null })).rejects.toEqual(coded('no_vault'));
    await expect(F.requireVault()).rejects.toEqual(coded('no_vault'));
  });
});

describe('encodings', () => {
  it('UTF-8 keeps its byte-order mark in the text', async () => {
    fsa.seed({ 'bom.md': new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]) });
    const r = await F.readFile('bom.md');
    expect(r).toMatchObject({ text: '﻿a\n', encoding: 'UTF-8', bom: true, lossy: false, size: 5 });
    await F.saveFile('bom.md', '﻿b\n', { expectedHash: r.hash });
    expect([...fsa.read('bom.md')]).toEqual([0xef, 0xbb, 0xbf, 0x62, 0x0a]);
  });

  it('windows-1252 is detected, and one edit keeps every other byte', async () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0x80, 0x0d, 0x0a]);
    fsa.seed({ 'w.txt': bytes });
    const r = await F.readFile('w.txt');
    expect(r).toMatchObject({ text: 'café\r\n€\r\n', encoding: 'windows-1252', bom: false, lossy: false, hash: hash(bytes) });
    await F.saveFile('w.txt', 'cafés\r\n€\r\n', { expectedHash: r.hash, encoding: 'windows-1252' });
    expect([...fsa.read('w.txt')]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x73, 0x0d, 0x0a, 0x80, 0x0d, 0x0a]);
  });

  it('a character windows-1252 cannot hold is unencodable, and nothing is written', async () => {
    fsa.seed({ 'w.txt': new Uint8Array([0xe9]) });
    await expect(F.saveFile('w.txt', 'ψ', { expectedHash: hash(new Uint8Array([0xe9])), encoding: 'windows-1252' })).rejects.toEqual(coded('unencodable'));
    expect([...fsa.read('w.txt')]).toEqual([0xe9]);
  });

  it('a forced UTF-8 that is not UTF-8 is not_utf8; an unknown label is unsupported', async () => {
    fsa.seed({ 'w.txt': new Uint8Array([0xe9]) });
    await expect(F.readFile('w.txt', { encoding: 'utf-8' })).rejects.toEqual(coded('not_utf8'));
    await expect(F.readFile('w.txt', { encoding: 'shift_jis' })).rejects.toEqual(coded('unsupported'));
    await expect(F.readText('w.txt')).rejects.toEqual(coded('not_utf8'));
  });

  it('UTF-16LE and BE with a BOM round-trip, CRLF and all', async () => {
    const le = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x0d, 0x00, 0x0a, 0x00]);
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x61, 0x00, 0x0a]);
    fsa.seed({ 'le.txt': le, 'be.txt': be });
    const a = await F.readFile('le.txt');
    expect(a).toMatchObject({ text: '﻿a\r\n', encoding: 'UTF-16LE', bom: true });
    await F.saveFile('le.txt', '﻿b\r\n', { expectedHash: a.hash, encoding: a.encoding });
    expect([...fsa.read('le.txt')]).toEqual([0xff, 0xfe, 0x62, 0x00, 0x0d, 0x00, 0x0a, 0x00]);
    const b = await F.readFile('be.txt');
    expect(b).toMatchObject({ text: '﻿a\n', encoding: 'UTF-16BE' });
    await F.saveFile('be.txt', '﻿c\n', { expectedHash: b.hash, encoding: 'UTF-16BE' });
    expect([...fsa.read('be.txt')]).toEqual([0xfe, 0xff, 0x00, 0x63, 0x00, 0x0a]);
  });

  it('a decode that does not round-trip is lossy, and its save is refused', async () => {
    const odd = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62]);
    fsa.seed({ 'odd.txt': odd });
    const r = await F.readFile('odd.txt');
    expect(r.lossy).toBe(true);
    await expect(F.saveFile('odd.txt', r.text, { expectedHash: r.hash, encoding: r.encoding })).rejects.toEqual(coded('lossy'));
    expect([...fsa.read('odd.txt')]).toEqual([...odd]);
  });
});

describe('the epoch', () => {
  it('a mutating call naming another epoch does nothing and says stale_vault', async () => {
    fsa.seed({ 'a.md': 'one\n' });
    const stale = { epoch: 2 };
    await expect(F.saveFile('a.md', 'two\n', { expectedHash: hash('one\n'), epoch: 2 })).rejects.toEqual(coded('stale_vault'));
    await expect(F.createNew('b.md', 'x', stale)).rejects.toEqual(coded('stale_vault'));
    await expect(F.appendLine('a.md', 'x', stale)).rejects.toEqual(coded('stale_vault'));
    await expect(F.replaceLine('a.md', 0, 'one', 'uno', stale)).rejects.toEqual(coded('stale_vault'));
    await expect(F.copyFile('a.md', 'c.md', stale)).rejects.toEqual(coded('stale_vault'));
    await expect(F.writeText('a.md', 'x', stale)).rejects.toEqual(coded('stale_vault'));
    await expect(F.rename('a.md', 'd.md', stale)).rejects.toEqual(coded('stale_vault'));
    await expect(F.trash('a.md', stale)).rejects.toEqual(coded('stale_vault'));
    await expect(F.mkdir('x', stale)).rejects.toEqual(coded('stale_vault'));
    await expect(F.setState({}, stale)).rejects.toEqual(coded('stale_vault'));
    await expect(F.versionKeep('a.md', 'x', stale)).rejects.toEqual(coded('stale_vault'));
    expect(tree()).toEqual(['a.md']);
    expect(fsa.readText('a.md')).toBe('one\n');
  });

  it('the current epoch, or none, goes through; it follows the tab', async () => {
    await F.createNew('b.md', 'x', { epoch: 1 });
    await F.createNew('c.md', 'y');
    epoch = 2;
    await F.createNew('d.md', 'z', { epoch: 2 });
    await expect(F.createNew('e.md', 'z', { epoch: 1 })).rejects.toEqual(coded('stale_vault'));
    expect(tree()).toEqual(['b.md', 'c.md', 'd.md']);
  });
});

describe('createNew, createNewBinary, copyFile, importOutside', () => {
  it('createNew makes the folders and answers the path and the hash', async () => {
    expect(await F.createNew('a/b/c.ext', 'hello')).toEqual({ path: 'a/b/c.ext', hash: hash('hello') });
    expect(fsa.readText('a/b/c.ext')).toBe('hello');
    expect(await F.createNew('empty.json')).toEqual({ path: 'empty.json', hash: hash('') });
    expect(await F.createNew('opts.md', { epoch: 1 })).toEqual({ path: 'opts.md', hash: hash('') });
    expect(fsa.readText('empty.json')).toBe('');
  });

  it('createNew never overwrites, a file or a folder', async () => {
    fsa.seed({ 'a.md': 'keep me\n', 'd/x': 'x' });
    await expect(F.createNew('a.md', 'no')).rejects.toEqual(coded('exists'));
    await expect(F.createNew('d', 'no')).rejects.toEqual(coded('exists'));
    expect(fsa.readText('a.md')).toBe('keep me\n');
  });

  it('createNew refuses a name no disk can hold', async () => {
    await expect(F.createNew('bad?.md', '')).rejects.toEqual(coded('bad_name'));
    await expect(F.createNew('dot.', '')).rejects.toEqual(coded('bad_name'));
  });

  it('createNew in a folding disk: exists in any case', async () => {
    setup({ foldCase: true, files: { 'Note.md': 'n' } });
    await expect(F.createNew('note.md', 'x')).rejects.toEqual(coded('exists'));
  });

  it('a failed write removes the file it made', async () => {
    fsa.fail('write', 'x.md', 'QuotaExceededError');
    await expect(F.createNew('x.md', 'data')).rejects.toEqual(coded('write_failed'));
    expect(fsa.exists('x.md')).toBe(false);
  });

  it('createNewBinary: the bytes in one call, exclusive, base64 only', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 10]);
    const b64 = toBase64(bytes);
    expect(await F.createNewBinary('img/p.png', b64)).toEqual({ path: 'img/p.png', hash: hash(bytes) });
    expect([...fsa.read('img/p.png')]).toEqual([...bytes]);
    await expect(F.createNewBinary('img/p.png', b64)).rejects.toEqual(coded('exists'));
    await expect(F.createNewBinary('img/q.png', 5)).rejects.toEqual(coded('bad_arg'));
    await expect(F.createNewBinary('bad?.png', b64)).rejects.toEqual(coded('bad_name'));
  });

  it('copyFile copies the bytes, whatever they are, and never overwrites', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 10, 13]);
    fsa.seed({ 'img.bin': bytes, 'dir/x': 'x' });
    expect(await F.copyFile('img.bin', 'img 2.bin')).toEqual({ path: 'img 2.bin', hash: hash(bytes) });
    expect([...fsa.read('img 2.bin')]).toEqual([...bytes]);
    await expect(F.copyFile('img.bin', 'img 2.bin')).rejects.toEqual(coded('exists'));
    await expect(F.copyFile('nope.bin', 'x.bin')).rejects.toEqual(coded('not_found'));
    await expect(F.copyFile('dir', 'dir2')).rejects.toEqual(coded('bad_arg'));
  });

  it('importOutside copies a registered outside file in, create-only', async () => {
    outside.set('abs:/web/o1/pic.bin', fsa.outsideFile('pic.bin', new Uint8Array([9, 8, 7])));
    expect(await F.importOutside('abs:/web/o1/pic.bin', 'in/pic.bin')).toEqual({ path: 'in/pic.bin', hash: hash(new Uint8Array([9, 8, 7])) });
    expect([...fsa.read('in/pic.bin')]).toEqual([9, 8, 7]);
    await expect(F.importOutside('abs:/web/o1/pic.bin', 'in/pic.bin')).rejects.toEqual(coded('exists'));
    await expect(F.importOutside('pic.bin', 'x.bin')).rejects.toEqual(coded('bad_arg'));
    await expect(F.importOutside('abs:/web/zz/x', 'x.bin')).rejects.toEqual(coded('not_registered'));
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
      if (before !== null) fsa.seed({ 'log/sys.log': /** @type {string} */ (before) });
      const r = await F.appendLine('log/sys.log', line);
      expect(fsa.readText('log/sys.log')).toBe(after);
      expect(r).toEqual({ hash: hash(/** @type {string} */ (after)) });
    });
  }

  it('refuses a line with a line break in it', async () => {
    await expect(F.appendLine('a.log', 'one\ntwo')).rejects.toEqual(coded('bad_arg'));
    await expect(F.appendLine('a.log', 'one\rtwo')).rejects.toEqual(coded('bad_arg'));
    expect(fsa.exists('a.log')).toBe(false);
  });

  it('a file that is not UTF-8 is not_utf8 and left as it was', async () => {
    fsa.seed({ 'w.log': new Uint8Array([0xe9, 0x0a]) });
    await expect(F.appendLine('w.log', 'x')).rejects.toEqual(coded('not_utf8'));
    expect([...fsa.read('w.log')]).toEqual([0xe9, 0x0a]);
  });

  it('keeps no version, and a BOM stays', async () => {
    fsa.seed({ 'a.log': '﻿a\n' });
    await F.appendLine('a.log', 'b');
    expect(fsa.readText('a.log')).toBe('﻿a\nb\n');
    expect(await F.versionList('a.log')).toEqual([]);
  });

  it('appendText appends as given, folders made', async () => {
    await F.appendText('x/t.txt', 'a');
    await F.appendText('x/t.txt', 'b\r\n');
    expect(fsa.readText('x/t.txt')).toBe('ab\r\n');
  });
});

describe('replaceLine', () => {
  it('replaces one line when it still says what was expected, every other byte kept', async () => {
    fsa.seed({ 'todo.md': '- [ ] a\r\n- [ ] b\r\n- [ ] c' });
    const r = await F.replaceLine('todo.md', 1, '- [ ] b', '- [x] b');
    expect(r).toEqual({ status: 'replaced', hash: hash('- [ ] a\r\n- [x] b\r\n- [ ] c') });
    expect(fsa.readText('todo.md')).toBe('- [ ] a\r\n- [x] b\r\n- [ ] c');
  });

  it('the last line, with no newline after it', async () => {
    fsa.seed({ 'todo.md': 'a\nb' });
    await F.replaceLine('todo.md', 1, 'b', 'B');
    expect(fsa.readText('todo.md')).toBe('a\nB');
  });

  it('line 0 is compared without a BOM, and the BOM is kept', async () => {
    fsa.seed({ 'todo.md': '﻿a\nb\n' });
    await F.replaceLine('todo.md', 0, 'a', 'A');
    expect(fsa.readText('todo.md')).toBe('﻿A\nb\n');
  });

  it('a line that changed is a conflict with what it says now', async () => {
    fsa.seed({ 'todo.md': 'a\nchanged\nc\n' });
    expect(await F.replaceLine('todo.md', 1, 'b', 'B')).toEqual({ status: 'conflict', actual: 'changed' });
    expect(fsa.readText('todo.md')).toBe('a\nchanged\nc\n');
  });

  it('an index out of range is a conflict with actual null; bad arguments are bad_arg', async () => {
    fsa.seed({ 'todo.md': 'a\nb\n' });
    expect(await F.replaceLine('todo.md', 7, 'x', 'y')).toEqual({ status: 'conflict', actual: null });
    expect(await F.replaceLine('todo.md', -1, 'x', 'y')).toEqual({ status: 'conflict', actual: null });
    await expect(F.replaceLine('todo.md', 1.5, 'a', 'b')).rejects.toEqual(coded('bad_arg'));
    await expect(F.replaceLine('todo.md', 0, 'a', 'b\nc')).rejects.toEqual(coded('bad_arg'));
    await expect(F.replaceLine('todo.md', 0, 1, 'b')).rejects.toEqual(coded('bad_arg'));
  });

  it('unchanged answers the current hash; a missing file is not_found; not UTF-8 is not_utf8', async () => {
    fsa.seed({ 'todo.md': 'a\n', 'w.md': new Uint8Array([0xe9]) });
    expect(await F.replaceLine('todo.md', 0, 'a', 'a')).toEqual({ status: 'replaced', hash: hash('a\n') });
    await expect(F.replaceLine('none.md', 0, 'a', 'b')).rejects.toEqual(coded('not_found'));
    await expect(F.replaceLine('w.md', 0, 'a', 'b')).rejects.toEqual(coded('not_utf8'));
  });

  it('keeps a version of what it replaced', async () => {
    fsa.seed({ 'todo.md': 'a\nb\n' });
    await F.replaceLine('todo.md', 0, 'a', 'A');
    const list = await F.versionList('todo.md');
    expect(list).toHaveLength(1);
    expect(await F.versionRead('todo.md', list[0].id)).toBe('a\nb\n');
  });

  it('the last look: the line changed on disk before close() is the conflict', async () => {
    fsa.seed({ 'todo.md': 'a\nb\n' });
    await afterNextWrite(() => { fsa.write('todo.md', 'a\nB2\n'); });
    expect(await F.replaceLine('todo.md', 1, 'b', 'x')).toEqual({ status: 'conflict', actual: 'B2' });
    expect(fsa.readText('todo.md')).toBe('a\nB2\n');
  });
});

describe('plain reads and writes', () => {
  it('writeText, readText, writeBinary, readBinary, readBytes, writeBytes', async () => {
    await F.writeText('a/b.txt', 'hé');
    expect(await F.readText('a/b.txt')).toBe('hé');
    await F.writeBinary('bin/x.bin', toBase64(new Uint8Array([1, 2, 3])));
    expect(await F.readBinary('bin/x.bin')).toBe(toBase64(new Uint8Array([1, 2, 3])));
    expect([...(await F.readBytes('bin/x.bin'))]).toEqual([1, 2, 3]);
    expect(await F.readBytes('none')).toBe(null);
    await F.writeBytes('w/y.bin', new Uint8Array([4]));
    expect([...fsa.read('w/y.bin')]).toEqual([4]);
    await expect(F.readText('missing.md')).rejects.toEqual(coded('not_found'));
    await expect(F.readBinary('missing.md')).rejects.toEqual(coded('not_found'));
    await expect(F.readFile('missing.md')).rejects.toEqual(coded('not_found'));
    expect(tree().some((p) => p.endsWith('.crswap'))).toBe(false);
  });

  it('base64 of large and odd inputs', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect([...fromBase64(toBase64(big))]).toEqual([...big]);
    expect([...fromBase64('AQID')]).toEqual([1, 2, 3]);
    expect([...fromBase64('AQI')]).toEqual([1, 2]);
    expect([...fromBase64('_-8')]).toEqual([...fromBase64('/+8=')]);
  });

  it('mkdir is recursive; exists and stat', async () => {
    await F.mkdir('a/b/c');
    expect(fsa.kind('a/b/c')).toBe('directory');
    expect(await F.exists('a/b')).toBe(true);
    expect(await F.exists('a/z')).toBe(false);
    expect(await F.stat('a/b')).toEqual({ exists: true, kind: 'dir', mtime: 0, size: 0, hidden: false });
    expect(await F.stat('nope')).toEqual({ exists: false, kind: null, mtime: 0, size: 0, hidden: false });
  });

  it('getState and setState: .ose/state.json, pretty, {} when missing or broken', async () => {
    expect(await F.getState()).toEqual({});
    await F.setState({ pins: ['a.md'] });
    expect(fsa.readText('.ose/state.json')).toBe(JSON.stringify({ pins: ['a.md'] }, null, 2));
    expect(await F.getState()).toEqual({ pins: ['a.md'] });
    fsa.write('.ose/state.json', '{broken');
    expect(await F.getState()).toEqual({});
  });
});

describe('listings under the one hide rule', () => {
  beforeEach(() => {
    setup({
      files: {
        'b.md': 'b', 'a10.md': 'x', 'a2.md': 'y', '.env': 'e', 'ose.exe': 'x', 'sub/ose.exe': 'x',
        'Notes/x.md': 'x', '.hidden/y.md': 'y', '.ose/state.json': '{}', '.git/HEAD': 'h',
        'n/a.md.crswap': '', '~$doc.docx': '', '.trash/.info/1-a.json': '{}',
      },
    });
  });

  it('list: folders first, natural order; excluded never; hidden only on request', async () => {
    const names = (await F.list('')).map((e) => e.name);
    expect(names).toEqual(['n', 'Notes', 'sub', 'a2.md', 'a10.md', 'b.md']);
    const all = (await F.list('', { hidden: true })).map((e) => e.name);
    expect(all).toEqual(['.hidden', '.trash', 'n', 'Notes', 'sub', '.env', 'a2.md', 'a10.md', 'b.md']);
    const env = (await F.list('', { hidden: true })).find((e) => e.name === '.env');
    expect(env).toMatchObject({ path: '.env', kind: 'file', hidden: true, ext: '', size: 1 });
    expect((await F.list('sub')).map((e) => e.name)).toEqual(['ose.exe']);
    expect(await F.list('n')).toEqual([]);
    const md = (await F.list('Notes'))[0];
    expect(md).toMatchObject({ name: 'x.md', path: 'Notes/x.md', kind: 'file', ext: 'md', size: 1, hidden: false });
    expect(md.mtime).toBeGreaterThan(0);
    expect(md.link).toBeUndefined();
  });

  it('list: an excluded path, a file or a missing folder is not_found; paths are checked', async () => {
    await expect(F.list('.ose')).rejects.toEqual(coded('not_found'));
    await expect(F.list('b.md')).rejects.toEqual(coded('not_found'));
    await expect(F.list('nope')).rejects.toEqual(coded('not_found'));
    await expect(F.list('../x')).rejects.toEqual(coded('escapes_vault'));
  });

  it('list: a folder that cannot be read is readable:false', async () => {
    fsa.fail('entries', 'Notes');
    const notes = (await F.list('')).find((e) => e.name === 'Notes');
    expect(notes.readable).toBe(false);
  });

  it('tree: rooted at the vault name, the same rule, folders with mtime 0', async () => {
    const t = await F.tree();
    expect(t).toMatchObject({ name: 'vault', path: '', kind: 'dir', ext: '', mtime: 0, size: 0, hidden: false });
    expect(t.children.map((e) => e.name)).toEqual(['n', 'Notes', 'sub', 'a2.md', 'a10.md', 'b.md']);
    const notes = t.children.find((e) => e.name === 'Notes');
    expect(notes).toMatchObject({ kind: 'dir', mtime: 0, size: 0 });
    expect(notes.children.map((e) => e.path)).toEqual(['Notes/x.md']);
    const h = await F.tree({ hidden: true });
    expect(h.children.map((e) => e.name)).toContain('.hidden');
    expect(h.children.find((e) => e.name === '.trash').children).toEqual([]);
  });

  it('tree: an unreadable folder is readable:false; an unreadable root is io', async () => {
    fsa.fail('entries', 'Notes');
    const t = await F.tree();
    expect(t.children.find((e) => e.name === 'Notes')).toMatchObject({ readable: false, children: [] });
    fsa.loseRoot();
    await expect(F.tree()).rejects.toEqual(coded('io'));
  });

  it('walk: depth first under the rule, and stops when asked', async () => {
    const seen = [];
    expect(await F.walk(false, (p) => { seen.push(p); })).toBe(true);
    expect(seen.sort()).toEqual(['Notes', 'Notes/x.md', 'a10.md', 'a2.md', 'b.md', 'n', 'sub', 'sub/ose.exe']);
    let n = 0;
    expect(await F.walk(false, () => (++n === 2 ? false : undefined))).toBe(false);
  });

  it('stat: hidden, sniff of text, binary, windows-1252 and UTF-16', async () => {
    fsa.seed({
      'bin.dat': new Uint8Array([0, 1, 2]), 'w.txt': new Uint8Array([0x63, 0xe9]), 'u.txt': new Uint8Array([0xff, 0xfe, 0x61, 0]),
      'cut.md': new Uint8Array([...new Uint8Array(8191).fill(0x61), 0xc3, 0xa9]),
    });
    expect(await F.stat('.env')).toMatchObject({ exists: true, kind: 'file', hidden: true, size: 1 });
    expect(await F.stat('b.md', { sniff: true })).toMatchObject({ text: true, encoding: 'UTF-8' });
    expect(await F.stat('bin.dat', { sniff: true })).toMatchObject({ text: false });
    expect((await F.stat('bin.dat', { sniff: true })).encoding).toBeUndefined();
    expect(await F.stat('w.txt', { sniff: true })).toMatchObject({ text: true, encoding: 'windows-1252' });
    expect(await F.stat('u.txt', { sniff: true })).toMatchObject({ text: true, encoding: 'UTF-16LE' });
    expect(await F.stat('cut.md', { sniff: true })).toMatchObject({ text: true, encoding: 'UTF-8' });
  });
});

describe('search', () => {
  beforeEach(() => {
    setup({
      files: {
        'philosophy/kant.md': '# Kant\nThe critique of pure reason.\n  Pure reason again\n',
        'notes/reason.txt': 'nothing here\n',
        'notes/other.md': 'unrelated\n',
        'img/reason.png': 'binary',
        '.hidden/secret.md': 'pure reason hidden\n',
        '.ose/x.md': 'pure reason\n',
        '.trash/1-old.md': 'pure reason trashed\n',
        'many.md': Array.from({ length: 30 }, () => 'term').join('\n'),
      },
    });
  });

  it('terms ANDed over text or path, name hits first, col and 20 lines per file', async () => {
    const r = await F.search('pure reason');
    expect(r.stale).toBe(false);
    expect(r.hits.map((h) => h.path)).toEqual(['philosophy/kant.md', 'philosophy/kant.md']);
    expect(r.hits[0]).toEqual({ path: 'philosophy/kant.md', line: 2, col: 17, text: 'The critique of pure reason.', kind: 'file' });
    expect(r.hits[1]).toMatchObject({ line: 3, col: 1, text: 'Pure reason again' });
    const k = await F.search('kant');
    expect(k.hits[0]).toEqual({ path: 'philosophy/kant.md', line: 0, col: 0, text: 'philosophy/kant.md', kind: 'file' });
    expect(k.hits[1]).toMatchObject({ line: 1, col: 3, text: '# Kant' });
    // A term found in the path counts: `philosophy critique` finds the page in that folder.
    expect((await F.search('philosophy critique')).hits.map((h) => h.line)).toEqual([2]);
    const n = await F.search('reason');
    expect(n.hits.filter((h) => h.line === 0).map((h) => h.path).sort()).toEqual(['img/reason.png', 'notes/reason.txt']);
    const m = await F.search('term');
    expect(m.hits).toHaveLength(20);
    expect(m.total).toBe(1);
  });

  it('quoted phrases, path: and file: filters, hidden only when asked, never .ose or .trash', async () => {
    expect((await F.search('"reason again"')).hits.map((h) => h.line)).toEqual([3]);
    expect((await F.search('reason path:notes')).hits.map((h) => h.path)).toEqual(['notes/reason.txt']);
    expect((await F.search('file:kant')).hits.map((h) => h.path)).toEqual([]);
    expect((await F.search('pure file:kant')).files).toBe(1);
    expect((await F.search('hidden')).total).toBe(0);
    const h = await F.search('trashed', { hidden: true });
    expect(h.total).toBe(0);
    expect((await F.search('pure hidden', { hidden: true })).hits.map((x) => x.path)).toEqual(['.hidden/secret.md']);
    expect(await F.search('   ')).toEqual({ hits: [], files: 0, total: 0, capped: false, stale: false });
  });

  it('limit counts files, 0 is no cap; a newer query on the channel makes the older stale', async () => {
    const r = await F.search('reason', { limit: 1 });
    expect(r).toMatchObject({ files: 1, capped: true });
    expect(r.total).toBeGreaterThan(1);
    expect((await F.search('reason', { limit: 0 })).capped).toBe(false);
    const first = F.search('reason', { chan: 'c' });
    const second = F.search('reason', { chan: 'c' });
    expect((await first).stale).toBe(true);
    expect((await second).stale).toBe(false);
  });
});

describe('rename', () => {
  it('moves a file, never overwrites, missing is not_found, same path is null', async () => {
    fsa.seed({ 'a.md': 'a', 'b.md': 'b' });
    await expect(F.rename('a.md', 'b.md')).rejects.toEqual(coded('exists'));
    await expect(F.rename('zz.md', 'y.md')).rejects.toEqual(coded('not_found'));
    expect(await F.rename('a.md', 'a.md')).toBe(null);
    expect(await F.rename('a.md', 'deep/c.md')).toBe(null);
    expect(tree()).toEqual(['b.md', 'deep/', 'deep/c.md']);
    expect(fsa.readText('deep/c.md')).toBe('a');
    expect(renames).toEqual([['a.md', 'deep/c.md']]);
  });

  it("moves the file's versions; a folder rename moves everything under it", async () => {
    fsa.seed({ 'd/a.md': 'one\n' });
    await F.saveFile('d/a.md', 'two\n', { expectedHash: hash('one\n') });
    await F.rename('d/a.md', 'd/b.md');
    expect(await F.versionList('d/a.md')).toEqual([]);
    expect(await F.versionList('d/b.md')).toHaveLength(1);
    await F.rename('d', 'e');
    expect(await F.versionList('e/b.md')).toHaveLength(1);
    expect(history().every((p) => p.startsWith('e/b.md/'))).toBe(true);
    expect(renames).toEqual([['d/a.md', 'd/b.md'], ['d', 'e']]);
  });

  it('a history already at the new path is merged, a taken id moved aside', async () => {
    fsa.seed({ '.ose/history/a.md/2026-01-01-000000.save.md': 'x', '.ose/history/b.md/2026-01-01-000000.save.md': 'y', 'a.md': 'a' });
    await F.rename('a.md', 'b.md');
    expect(history().sort()).toEqual(['b.md/2026-01-01-000000-1.save.md', 'b.md/2026-01-01-000000.save.md']);
  });

  it('a case-only rename on a folding disk goes through a temporary name', async () => {
    setup({ foldCase: true, files: { 'note.md': 'n', 'Dir/x.md': 'x' } });
    await F.rename('note.md', 'Note.md');
    expect(tree()).toEqual(['Dir/', 'Dir/x.md', 'Note.md']);
    await F.rename('Dir', 'dir');
    expect(tree()).toEqual(['Note.md', 'dir/', 'dir/x.md']);
    await expect(F.rename('Note.md', 'dir/X.md')).rejects.toEqual(coded('exists'));
  });

  it('a case-only rename on a case-sensitive disk is a plain move', async () => {
    fsa.seed({ 'note.md': 'n' });
    await F.rename('note.md', 'Note.md');
    expect(tree()).toEqual(['Note.md']);
  });

  it('a folder Chrome will not move is copied whole, then the original removed', async () => {
    setup({ dirMove: false, files: { 'd/a.md': 'a', 'd/s/b.bin': new Uint8Array([1, 2]) } });
    await F.rename('d', 'e/f');
    expect(tree()).toEqual(['e/', 'e/f/', 'e/f/a.md', 'e/f/s/', 'e/f/s/b.bin']);
  });

  it('a copy that fails halfway leaves the original and no half copy', async () => {
    setup({ dirMove: false, files: { 'd/a.md': 'a', 'd/b.md': 'b' } });
    fsa.fail('getFile', 'd/b.md');
    await expect(F.rename('d', 'e')).rejects.toBeTruthy();
    expect(tree()).toEqual(['d/', 'd/a.md', 'd/b.md']);
  });

  it('a folder cannot move into itself', async () => {
    fsa.seed({ 'd/a.md': 'a' });
    await expect(F.rename('d', 'd/e')).rejects.toEqual(coded('bad_arg'));
  });

  it('followRename moves the history and tells the drafts', async () => {
    fsa.seed({ '.ose/history/x.md/2026-01-01-000000.save.md': 'x' });
    await F.followRename('x.md', 'y.md');
    expect(history()).toEqual(['y.md/2026-01-01-000000.save.md']);
    expect(renames).toEqual([['x.md', 'y.md']]);
  });
});

describe('copyPath', () => {
  it('copies a whole folder, bytes, create-only', async () => {
    fsa.seed({ 'd/a.md': 'a', 'd/s/b.bin': new Uint8Array([1, 2]) });
    expect(await F.copyPath('d', 'e')).toEqual({ path: 'e', files: 2 });
    expect([...fsa.read('e/s/b.bin')]).toEqual([1, 2]);
    await expect(F.copyPath('d', 'e')).rejects.toEqual(coded('exists'));
    await expect(F.copyPath('d', 'd/inner')).rejects.toEqual(coded('bad_arg'));
    await expect(F.copyPath('d', '')).rejects.toEqual(coded('bad_name'));
    await expect(F.copyPath('nope', 'x')).rejects.toEqual(coded('not_found'));
  });

  it('copies one file', async () => {
    fsa.seed({ 'a.md': 'a' });
    expect(await F.copyPath('a.md', 'x/b.md')).toEqual({ path: 'x/b.md', files: 1 });
    expect(fsa.readText('x/b.md')).toBe('a');
  });

  it('a half copy is removed', async () => {
    fsa.seed({ 'd/a.md': 'a', 'd/b.md': 'b' });
    fsa.fail('getFile', 'd/b.md');
    await expect(F.copyPath('d', 'e')).rejects.toBeTruthy();
    expect(fsa.exists('e')).toBe(false);
  });
});

describe('the vault bin', () => {
  it('a trash answers an id, is listed with its sidecar, and restores', async () => {
    fsa.seed({ 'notes/a.md': 'hello' });
    const r = await F.trash('notes/a.md');
    expect(r.where).toBe('vault');
    expect(r.id).toMatch(/^vault:\d+-a\.md$/);
    expect(fsa.exists('notes/a.md')).toBe(false);
    const entry = r.id.slice(6);
    expect(JSON.parse(/** @type {string} */ (fsa.readText(`.trash/.info/${entry}.json`)))).toMatchObject({ v: 1, original: 'notes/a.md', kind: 'file' });
    const list = await F.trashList();
    expect(list).toEqual([{ id: r.id, name: 'a.md', original: 'notes/a.md', deletedAt: expect.any(Number), kind: 'file', size: 5, where: 'vault' }]);
    expect(await F.trashRestore([r.id])).toEqual({ restored: [{ id: r.id, path: 'notes/a.md' }], failed: [] });
    expect(fsa.readText('notes/a.md')).toBe('hello');
    expect(fsa.exists(`.trash/.info/${entry}.json`)).toBe(false);
    expect(await F.trashList()).toEqual([]);
  });

  it('a folder goes in whole, its size summed; a taken name gets a counter', async () => {
    setup({ dirMove: false, files: { 'd/a.md': 'aa', 'd/s/b.md': 'bbb', 'x.md': '1' } });
    const r = await F.trash('d');
    const list = await F.trashList();
    expect(list[0]).toMatchObject({ id: r.id, kind: 'dir', size: 5, original: 'd' });
    const now = 1_800_000_000_000;
    setup({ files: { [`.trash/${now}-x.md`]: '1', 'x.md': '2' } }, { now: () => now });
    const b = await F.trash('x.md');
    expect(b.id).toBe(`vault:${now}-2-x.md`);
  });

  it('a restore never overwrites, makes missing folders, and reports each id', async () => {
    fsa.seed({ 'a/b/c.md': 'c' });
    const r = await F.trash('a/b/c.md');
    fsa.seed({ 'x.md': 'x' });
    const r2 = await F.trash('x.md');
    fsa.seed({ 'x.md': 'new' });
    fsa.remove('a');
    const out = await F.trashRestore([r.id, r2.id, 'vault:nope', 'bad', 'vault:../x']);
    expect(out.restored).toEqual([{ id: r.id, path: 'a/b/c.md' }]);
    expect(out.failed.map((f) => [f.id, f.error.slice(0, f.error.indexOf(']') + 1)])).toEqual([
      [r2.id, '[exists]'], ['vault:nope', '[not_found]'], ['bad', '[bad_arg]'], ['vault:../x', '[bad_arg]'],
    ]);
    expect(fsa.readText('x.md')).toBe('new');
  });

  it('an entry with no sidecar is known:false and restores at the root', async () => {
    fsa.seed({ '.trash/123-lost.md': 'l' });
    const [item] = await F.trashList();
    expect(item).toMatchObject({ id: 'vault:123-lost.md', name: 'lost.md', original: 'lost.md', known: false, deletedAt: 123 });
    await F.trashRestore(item.id);
    expect(fsa.readText('lost.md')).toBe('l');
  });

  it('the root is bad_arg, a missing path not_found; trashWhere is always the vault', async () => {
    await expect(F.trash('')).rejects.toEqual(coded('bad_arg'));
    await expect(F.trash('nope.md')).rejects.toEqual(coded('not_found'));
    expect(await F.trashWhere('a.md', { mode: 'system' })).toEqual({ where: 'vault' });
    await expect(F.trashWhere('../a')).rejects.toEqual(coded('escapes_vault'));
  });

  it('a trash leaves the history where it is', async () => {
    fsa.seed({ 'a.md': 'one\n' });
    await F.saveFile('a.md', 'two\n', { expectedHash: hash('one\n') });
    await F.trash('a.md');
    expect(await F.versionList('a.md')).toHaveLength(1);
  });
});

describe('versions', () => {
  it('versionKeep: identical to the newest is not kept; forced within a minute is; bad reason', async () => {
    expect(await F.versionKeep('a.md', 'x')).toMatchObject({ kept: true });
    expect(await F.versionKeep('a.md', 'x', { force: true })).toEqual({ kept: false, id: null });
    expect(await F.versionKeep('a.md', 'y')).toEqual({ kept: false, id: null });
    const k = await F.versionKeep('a.md', 'y', { force: true, reason: 'reload' });
    expect(k.kept).toBe(true);
    expect(k.id).not.toBe((await F.versionList('a.md'))[1].id);
    expect((await F.versionList('a.md')).map((v) => v.reason)).toEqual(['reload', 'save']);
    await expect(F.versionKeep('a.md', 'z', { reason: 'whim' })).rejects.toEqual(coded('bad_arg'));
    expect(await F.versionKeep('a.md', '')).toEqual({ kept: false, id: null });
  });

  it('versionRead and versionRestore: a bad id, a missing one; the current bytes kept', async () => {
    fsa.seed({ 'a.md': 'one\n' });
    await F.saveFile('a.md', 'two\n', { expectedHash: hash('one\n') });
    const [v] = await F.versionList('a.md');
    await expect(F.versionRead('a.md', 'x/y')).rejects.toEqual(coded('bad_arg'));
    await expect(F.versionRead('a.md', '2000-01-01-000000')).rejects.toEqual(coded('not_found'));
    const r = await F.versionRestore('a.md', v.id);
    expect(r).toMatchObject({ kept: true, hash: hash('one\n') });
    expect(fsa.readText('a.md')).toBe('one\n');
    const list = await F.versionList('a.md');
    expect(list.map((x) => x.reason)).toEqual(['restore', 'save']);
    expect(await F.versionRead('a.md', list[0].id)).toBe('two\n');
  });

  it('versions of a file outside the vault are unsupported', async () => {
    await expect(F.versionKeep('abs:/web/o/a.md', 'x')).rejects.toEqual(coded('unsupported'));
    await expect(F.versionList('abs:/web/o/a.md')).rejects.toEqual(coded('unsupported'));
    await expect(F.versionRead('abs:/web/o/a.md', '1')).rejects.toEqual(coded('unsupported'));
    await expect(F.versionRestore('abs:/web/o/a.md', '1')).rejects.toEqual(coded('unsupported'));
  });

  it('an old .ose/versions becomes .ose/history, old ids still valid', async () => {
    fsa.seed({ '.ose/versions/a.md/2025-01-01-120000.md': 'old' });
    const list = await F.versionList('a.md');
    expect(list).toEqual([{ id: '2025-01-01-120000', at: Date.UTC(2025, 0, 1, 12), bytes: 3, reason: 'save', session: false }]);
    expect(fsa.exists('.ose/versions')).toBe(false);
    expect(await F.versionRead('a.md', '2025-01-01-120000')).toBe('old');
  });

  it('pruning: the tiers of survivors, as versions.rs', () => {
    const now = Date.UTC(2026, 0, 31);
    const H = 3600_000;
    const list = [
      { at: now - 10, session: false, reason: 'save' },
      { at: now - 2 * H + 120_000, session: false, reason: 'save' },
      { at: now - 2 * H + 60_000, session: false, reason: 'save' },
      { at: now - 40 * 24 * H, session: false, reason: 'save' },
      { at: now - 3 * 24 * H, session: false, reason: 'conflict' },
    ];
    expect(survivors(list, now)).toEqual([true, true, false, false, true]);
  });
});

describe('files outside the vault', () => {
  it('stat, exists, readFile, readText, readBinary and saveFile on a registered abs: path; no version', async () => {
    const h = fsa.outsideFile('.notes.md', 'one\n');
    outside.set('abs:/web/o1/.notes.md', h);
    expect(await F.exists('abs:/web/o1/.notes.md')).toBe(true);
    expect(await F.stat('abs:/web/o1/.notes.md', { sniff: true })).toMatchObject({ exists: true, kind: 'file', size: 4, hidden: true, text: true });
    const r = await F.readFile('abs:/web/o1/.notes.md');
    expect(r).toMatchObject({ text: 'one\n', encoding: 'UTF-8' });
    expect(await F.readText('abs:/web/o1/.notes.md')).toBe('one\n');
    expect(await F.readBinary('abs:/web/o1/.notes.md')).toBe(toBase64(enc.encode('one\n')));
    expect(await F.saveFile('abs:/web/o1/.notes.md', 'two\n', { expectedHash: r.hash })).toMatchObject({ status: 'saved' });
    expect(await (await h.getFile()).text()).toBe('two\n');
    expect(history()).toEqual([]);
    expect(await F.saveFile('abs:/web/o1/.notes.md', 'x\n', { expectedHash: r.hash })).toMatchObject({ status: 'conflict' });
  });

  it('an unregistered abs: path is not_registered; vault-only commands refuse abs:', async () => {
    await expect(F.stat('abs:/web/zz/a.md')).rejects.toEqual(coded('not_registered'));
    await expect(F.readText('abs:/web/zz/a.md')).rejects.toEqual(coded('not_registered'));
    await expect(F.rename('abs:/web/zz/a.md', 'b.md')).rejects.toEqual(coded('escapes_vault'));
    await expect(F.trash('abs:/web/zz/a.md')).rejects.toEqual(coded('escapes_vault'));
    await expect(F.list('abs:/web/zz')).rejects.toEqual(coded('escapes_vault'));
    await expect(F.writeText('abs:/web/zz/a.md', 'x')).rejects.toEqual(coded('escapes_vault'));
  });
});

