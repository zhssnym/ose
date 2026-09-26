// The dev bridge's wave-2 commands (CONTRACT §3.1 to §3.3), over HTTP as the page makes them,
// against a temp vault: the one hide rule (Excluded, Hidden, Shown), `stat` with a content
// sniff, `copyPath`, the trash with an id and its restore, the per-machine store, the fault
// switch the no-loss suite uses, and `run` gone. The host's Rust twin is tested by `cargo test`
// (src-tauri/src/hide.rs and friends); this is the Node side, which must answer the same.
//
// A command the bridge does not have yet answers `[unknown_command]`; its tests are skipped
// until it does, so `npm test` stays green while the wave is built.
//
// Depends on: host (dev/bridge-plugin.mjs, dev/files.mjs).

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const base = mkdtempSync(join(tmpdir(), 'ose-wave2-'));
const root = join(base, 'vault');
const appdata = join(base, 'appdata');

/** Write `{ rel: text }` under the vault (a Buffer is written as bytes). */
function seed(files) {
  for (const [rel, body] of Object.entries(files)) {
    const f = join(root, ...rel.split('/'));
    mkdirSync(join(f, '..'), { recursive: true });
    if (rel.endsWith('/')) mkdirSync(f, { recursive: true }); else writeFileSync(f, body);
  }
}

seed({
  'a.md': 'one\n',
  'app/page.md': '# app\n',
  'App2/x.md': 'x\n',
  'node_modules/m.txt': 'a needle in a package\n',
  '_Archive/old.md': 'old\n',
  'dist/out.txt': 'out\n',
  '.git/HEAD': 'needle\n',
  '.ose/state.json': '{}\n',
  '.env': 'SECRET=needle\n',
  '.config/tool.json': '{}\n',
  '.notes/secret.md': 'a hidden needle\n',
  'ose.exe': 'MZ',
  'ose.pdb': 'x',
  'sub/ose.exe': 'MZ',
  'sub/note.md': 'a needle in a note\n',
  '.a.md.4242.1.tmp': 'temp\n',
  '~$report.docx': 'owner\n',
  '.~lock.sheet.ods#': 'lock\n',
  'note.unsaved-20260926-101010.md': 'kept text\n',
  'bin.dat': Buffer.from([0x89, 0x50, 0x00, 0x47, 0x00, 0x01]),
  'bom.txt': Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]),
  'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
  'README': 'no extension\n',
  'copyme/one.md': '1\n',
  'copyme/deep/two.md': '2\n',
  'trashme.md': 'bye\n',
  'trashdir/in.md': 'in\n',
});

// Links: a junction on Windows needs no privilege; a symlink elsewhere. Where neither can be
// made, the link tests are skipped.
let links = false;
try {
  symlinkSync(join(root, 'sub'), join(root, 'lnk'), 'junction');
  symlinkSync(join(root, 'sub'), join(root, 'sub', 'loop'), 'junction');
  links = true;
} catch { /* no links on this machine */ }

process.env.OSE_ROOT = root;
process.env.OSE_APPDATA = appdata;
process.env.OSE_DEV_APPDATA = appdata;
process.env.OSE_DEV_FAULTS = '1';
const { bridgePlugin } = await import('../../dev/bridge-plugin.mjs');
const plugin = bridgePlugin();
const http = new EventEmitter();
let middleware;
plugin.configureServer({ httpServer: http, middlewares: { use: (fn) => { middleware = fn; } } });

/** One bridge call: POST /__bridge/<cmd> {args} -> { ok, result } | { ok: false, error }. */
function call(cmd, ...args) {
  const body = JSON.stringify({ args });
  const req = { url: `/__bridge/${cmd}`, method: 'POST', async *[Symbol.asyncIterator]() { yield body; } };
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, setHeader() {}, end(text) { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } } };
    middleware(req, res, () => reject(new Error(`not a bridge call: ${cmd}`)));
  });
}

/** The result of a call that must succeed. */
async function ok(cmd, ...args) {
  const r = await call(cmd, ...args);
  if (!r.ok) throw new Error(`${cmd}: ${r.error}`);
  return r.result;
}

/** Whether the bridge has a command yet (a probe with harmless arguments). */
async function hasCmd(cmd, ...probe) {
  const r = await call(cmd, ...probe);
  return !(r.ok === false && /^\[unknown_command\]/.test(r.error || ''));
}

const HAS = {
  hide: (await call('list', '')).ok && (await ok('list', '')).every((e) => 'hidden' in e),
  stat: (await call('stat', 'a.md', { sniff: true })).ok && 'text' in ((await ok('stat', 'a.md', { sniff: true })) || {}),
  copyPath: await hasCmd('copyPath', 'no-such', 'nowhere'),
  trashList: await hasCmd('trashList'),
  trashRestore: await hasCmd('trashRestore', [], {}),
  trashWhere: await hasCmd('trashWhere', 'a.md'),
  local: await hasCmd('localGet', 'app'),
  devFault: await hasCmd('devFault', null),
};

afterAll(() => {
  http.emit('close');
  for (const k of ['OSE_ROOT', 'OSE_APPDATA', 'OSE_DEV_APPDATA', 'OSE_DEV_FAULTS']) delete process.env[k];
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

const names = (list) => list.map((e) => e.name);

describe.skipIf(!HAS.hide)('the one hide rule (CONTRACT §3.3)', () => {
  it('shows every ordinary folder, whatever its name', async () => {
    const got = names(await ok('list', ''));
    for (const n of ['app', 'App2', 'node_modules', '_Archive', 'dist', 'sub', 'a.md', 'README', 'note.unsaved-20260926-101010.md']) expect(got).toContain(n);
  });

  it('never lists what is Excluded, even with hidden items shown', async () => {
    for (const opts of [undefined, { hidden: true }]) {
      const got = names(await ok('list', '', opts));
      for (const n of ['.git', '.ose', 'ose.exe', 'ose.pdb', '.a.md.4242.1.tmp', '~$report.docx', '.~lock.sheet.ods#']) expect(got, `${n} ${JSON.stringify(opts)}`).not.toContain(n);
    }
  });

  it('lists a dotfile only with {hidden:true}, and says it is hidden', async () => {
    expect(names(await ok('list', ''))).not.toContain('.env');
    const all = await ok('list', '', { hidden: true });
    const env = all.find((e) => e.name === '.env');
    expect(env).toMatchObject({ kind: 'file', hidden: true });
    expect(all.find((e) => e.name === '.config')).toMatchObject({ kind: 'dir', hidden: true });
    expect(all.find((e) => e.name === 'a.md')).toMatchObject({ hidden: false });
  });

  it('excludes the executable at the vault root only', async () => {
    expect(names(await ok('list', 'sub'))).toContain('ose.exe');
  });

  it('sorts folders first, then names naturally', async () => {
    const list = await ok('list', '');
    const firstFile = list.findIndex((e) => e.kind === 'file');
    expect(list.slice(firstFile).every((e) => e.kind === 'file')).toBe(true);
    expect(list[0]).toMatchObject({ name: expect.any(String), path: expect.any(String), ext: expect.any(String), mtime: expect.any(Number), size: expect.any(Number) });
  });

  it('the tree is rooted at the vault name and follows the same rule', async () => {
    const t = await ok('tree');
    expect(t).toMatchObject({ name: basename(root), path: '', kind: 'dir' });
    const top = names(t.children);
    expect(top).toContain('node_modules');
    expect(top).not.toContain('.git');
    expect(top).not.toContain('.env');
    expect(names((await ok('tree', { hidden: true })).children)).toContain('.env');
  });

  it('search never looks into an Excluded folder, and into a hidden one only when asked', async () => {
    const hits = async (opts) => {
      const r = await ok('search', 'needle', { limit: 50, chan: 't', ...opts });
      return (r.hits || []).map((h) => h.path);
    };
    const shown = await hits({});
    expect(shown).toContain('sub/note.md');
    expect(shown).toContain('node_modules/m.txt');
    expect(shown.some((p) => p.startsWith('.git'))).toBe(false);
    expect(shown).not.toContain('.notes/secret.md');
    const all = await hits({ hidden: true });
    expect(all).toContain('.notes/secret.md');
    expect(all.some((p) => p.startsWith('.git'))).toBe(false);
  });

  it.skipIf(!links)('a linked folder is badged, and a link to its own ancestor is a loop never walked', async () => {
    const top = await ok('list', '');
    expect(top.find((e) => e.name === 'lnk')).toMatchObject({ kind: 'dir', link: 'dir' });
    const inSub = await ok('list', 'sub');
    expect(inSub.find((e) => e.name === 'loop')).toMatchObject({ link: 'loop' });
    const t = await ok('tree');
    const lnk = t.children.find((e) => e.name === 'lnk');
    expect(lnk.children).toBeUndefined();
  });
});

describe.skipIf(!HAS.stat)('stat with a sniff (H17)', () => {
  it('knows text from binary by content, a BOM allowed', async () => {
    expect(await ok('stat', 'README', { sniff: true })).toMatchObject({ exists: true, kind: 'file', text: true });
    expect(await ok('stat', 'bom.txt', { sniff: true })).toMatchObject({ text: true });
    expect(await ok('stat', 'bin.dat', { sniff: true })).toMatchObject({ text: false });
    expect(await ok('stat', 'latin1.txt', { sniff: true })).toMatchObject({ text: false });
    expect(await ok('stat', '.env')).toMatchObject({ exists: true, hidden: true });
    expect(await ok('stat', 'missing.md')).toMatchObject({ exists: false });
  });
});

describe.skipIf(!HAS.copyPath)('copyPath', () => {
  it('copies a whole folder, bytes, create-only', async () => {
    expect(await ok('copyPath', 'copyme', 'copied/here')).toEqual({ path: 'copied/here', files: 2 });
    expect(readFileSync(join(root, 'copied', 'here', 'deep', 'two.md'), 'utf8')).toBe('2\n');
    expect(readFileSync(join(root, 'copyme', 'one.md'), 'utf8')).toBe('1\n');
    const again = await call('copyPath', 'copyme', 'copied/here');
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/^\[exists\] /) });
    expect(await call('copyPath', 'nope', 'x')).toMatchObject({ ok: false, error: expect.stringMatching(/^\[not_found\] /) });
  });

  it('copies one file', async () => {
    expect(await ok('copyPath', 'a.md', 'a copy.md')).toEqual({ path: 'a copy.md', files: 1 });
    expect(readFileSync(join(root, 'a copy.md'), 'utf8')).toBe('one\n');
  });
});

describe.skipIf(!HAS.trashList || !HAS.trashRestore)('the trash, with an id and a restore (M18)', () => {
  it('a vault trash answers an id, is listed, and restores', async () => {
    const t = await ok('trash', 'trashme.md', { mode: 'vault' });
    expect(t).toMatchObject({ id: expect.any(String), where: 'vault' });
    expect(existsSync(join(root, 'trashme.md'))).toBe(false);
    const item = (await ok('trashList')).find((x) => x.id === t.id);
    expect(item).toMatchObject({ name: 'trashme.md', original: 'trashme.md', kind: 'file', where: 'vault', deletedAt: expect.any(Number) });
    // `.trash` is an ordinary dot folder: Hidden, listed only with hidden items shown.
    expect(names(await ok('list', ''))).not.toContain('.trash');
    expect(names(await ok('list', '', { hidden: true }))).toContain('.trash');
    const r = await ok('trashRestore', [t.id], {});
    expect(r).toEqual({ restored: [{ id: t.id, path: 'trashme.md' }], failed: [] });
    expect(readFileSync(join(root, 'trashme.md'), 'utf8')).toBe('bye\n');
  });

  it('a restore never overwrites: a taken path is refused with [exists]', async () => {
    const t = await ok('trash', 'trashdir', { mode: 'vault' });
    seed({ 'trashdir/in.md': 'a new one\n' });
    const r = await ok('trashRestore', [t.id], {});
    expect(r.restored).toEqual([]);
    expect(r.failed).toEqual([{ id: t.id, error: expect.stringMatching(/^\[exists\] /) }]);
    expect(readFileSync(join(root, 'trashdir', 'in.md'), 'utf8')).toBe('a new one\n');
  });

  it('a missing parent folder is made again', async () => {
    seed({ 'gone/child.md': 'c\n' });
    const t = await ok('trash', 'gone/child.md', { mode: 'vault' });
    rmSync(join(root, 'gone'), { recursive: true, force: true });
    expect((await ok('trashRestore', [t.id], {})).restored).toEqual([{ id: t.id, path: 'gone/child.md' }]);
    expect(readFileSync(join(root, 'gone', 'child.md'), 'utf8')).toBe('c\n');
  });
});

describe.skipIf(!HAS.trashWhere)('trashWhere', () => {
  it('says where a trash would go', async () => {
    expect(await ok('trashWhere', 'a.md')).toEqual({ where: expect.stringMatching(/^(system|vault)$/) });
  });
});

describe.skipIf(!HAS.local)('the per-machine store (W5)', () => {
  it('round-trips both scopes, empty when unset', async () => {
    expect(await ok('localGet', 'vault')).toEqual({});
    // `theme` and `window` in app.json are the host's own (the theme mirror and the window
    // bounds it reads before first paint), so the page's keys are anything else.
    await ok('localSet', 'app', { fontSize: 17, zoom: 1.1 });
    await ok('localSet', 'vault', { session: { v: 1, tabs: [] }, migrated: 1 }, { epoch: 1 });
    expect(await ok('localGet', 'app')).toEqual({ fontSize: 17, zoom: 1.1 });
    expect(await ok('localGet', 'vault')).toEqual({ session: { v: 1, tabs: [] }, migrated: 1 });
  });

  it('lives in the app-data folder, never in the vault', async () => {
    await ok('localSet', 'app', { x: 1 });
    expect(existsSync(join(appdata, 'local', 'app.json'))).toBe(true);
    expect(existsSync(join(root, '.ose', 'local'))).toBe(false);
  });

  it('refuses more than 1 MB, and a stale epoch', async () => {
    const big = { blob: 'x'.repeat(1024 * 1024 + 10) };
    expect(await call('localSet', 'app', big)).toMatchObject({ ok: false, error: expect.stringMatching(/^\[bad_arg\] /) });
    expect(await call('localSet', 'vault', {}, { epoch: 99 })).toMatchObject({ ok: false, error: expect.stringMatching(/^\[stale_vault\] /) });
  });
});

describe.skipIf(!HAS.devFault)('devFault (OSE_DEV_FAULTS=1)', () => {
  it('fails the matching call with [code] message, counts down, and clears', async () => {
    await ok('devFault', { cmd: 'saveFile', path: 'a.md', code: 'write_failed', message: 'the disk is full', times: 1 });
    const h = (await ok('readFile', 'a.md')).hash;
    expect(await call('saveFile', 'a.md', 'two\n', { expectedHash: h })).toEqual({ ok: false, error: '[write_failed] the disk is full' });
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('one\n');
    expect((await ok('saveFile', 'a.md', 'two\n', { expectedHash: h })).status).toBe('saved');

    await ok('devFault', { cmd: 'saveFile', code: 'io' });
    const h2 = (await ok('readFile', 'a.md')).hash;
    expect((await call('saveFile', 'a.md', 'three\n', { expectedHash: h2 })).ok).toBe(false);
    expect((await call('saveFile', 'a.md', 'three\n', { expectedHash: h2 })).ok).toBe(false);
    await ok('devFault', null);
    expect((await ok('saveFile', 'a.md', 'three\n', { expectedHash: h2 })).status).toBe('saved');
  });

  it('only matches its own path', async () => {
    await ok('devFault', { cmd: 'readFile', path: 'other.md', code: 'io' });
    expect((await call('readFile', 'a.md')).ok).toBe(true);
    await ok('devFault', null);
  });
});

describe('the plugin runtime is gone (W2)', () => {
  it.skipIf(!HAS.local)('run and runKill are unknown commands', async () => {
    expect(await call('run', 'x', 'echo', [])).toEqual({ ok: false, error: '[unknown_command] run' });
    expect(await call('runKill', 'x')).toEqual({ ok: false, error: '[unknown_command] runKill' });
  });
});
