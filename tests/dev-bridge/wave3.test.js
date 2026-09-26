// The dev bridge's wave-3 commands (CONTRACT §3.7, §4.1), over HTTP as the page makes them,
// against a temp vault and a temp folder beside it: `createNewBinary`, `importOutside`,
// `outsideOpen` and the `abs:` paths it registers, `takeOpens`, `pickFile` and
// `openVaultWindow`, text in UTF-16 and windows-1252 read and saved back in its own encoding,
// `/vault/` with Range requests and `/vault/~abs/`, and a change to an outside file reported
// with its `abs:` path. The host's Rust twin is tested by `cargo test`; this is the Node side,
// which must answer the same.
//
// Depends on: build-tests (dev/bridge-plugin.mjs, dev/files.mjs).

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { hash } from '../../dev/files.mjs';

const base = mkdtempSync(join(tmpdir(), 'ose-wave3-'));
const root = join(base, 'vault');
const outside = join(base, 'outside');
const elsewhere = join(base, 'elsewhere');
const appdata = join(base, 'appdata');

/** Write `{ rel: text | Buffer }` under `dir`. */
function seed(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const f = join(dir, ...rel.split('/'));
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, body);
  }
}

// windows-1252: "café – 5 €\r\n" (é = E9, – = 96, € = 80).
const CP1252 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x35, 0x20, 0x80, 0x0d, 0x0a]);
const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf16be = (s) => { const b = Buffer.from(s, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), b]); };

seed(root, {
  'a.md': 'one\n',
  'bom.md': Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x61, 0x0a]),
  'latin.txt': CP1252,
  'le.txt': utf16le('line one\r\nligne deux é\r\n'),
  'be.txt': utf16be('big end\n'),
  'odd.txt': Buffer.concat([utf16le('ab'), Buffer.from([0x41])]),
  'media.bin': Buffer.from(Array.from({ length: 100 }, (_, i) => i)),
  'sub/note.md': 'in a folder\n',
});
seed(outside, {
  'todo.md': 'outside text\n',
  'pics/p.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  'bytes.bin': Buffer.from([0, 1, 2, 250, 251]),
});
seed(elsewhere, { 'secret.md': 'not for the page\n' });

process.env.OSE_ROOT = root;
process.env.OSE_APPDATA = appdata;
process.env.OSE_E2E_OUTSIDE = outside;
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

/** The `[code]` of a call that must fail. */
async function code(cmd, ...args) {
  const r = await call(cmd, ...args);
  if (r.ok) throw new Error(`${cmd} succeeded: ${JSON.stringify(r.result)}`);
  return (/^\[([a-z0-9_]+)\]/.exec(r.error) || [])[1];
}

/** A GET of the media origin: `{ status, headers, body }`. */
function media(url, range) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const headers = {};
    const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    res.statusCode = 200;
    res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
    const done = () => resolve({ status: res.statusCode, headers, body: Buffer.concat(chunks) });
    res.on('finish', done);
    const origEnd = res.end.bind(res);
    res.end = (...a) => origEnd(...a);
    const req = { url, method: 'GET', headers: range ? { range } : {} };
    middleware(req, res, () => reject(new Error(`not a media request: ${url}`)));
  });
}

/** The events the bridge streams, collected from a fake SSE client. */
const events = [];
{
  const req = new EventEmitter();
  req.url = '/__bridge/events';
  req.socket = { setTimeout() {}, setNoDelay() {}, setKeepAlive() {} };
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode: 200,
    setHeader() {},
    flushHeaders() {},
    end() {},
    write(frame) {
      const m = /^data: (.*)$/m.exec(String(frame));
      if (m) events.push(JSON.parse(m[1]));
      return true;
    },
  });
  middleware(req, res, () => {});
}

const abs = (native) => `abs:${native.replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`)}`;
const disk = (dir, rel) => readFileSync(join(dir, ...rel.split('/')));

afterAll(() => {
  http.emit('close');
  for (const k of ['OSE_ROOT', 'OSE_APPDATA', 'OSE_E2E_OUTSIDE', 'OSE_DEV_FAULTS']) delete process.env[k];
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

describe('createNewBinary', () => {
  it('creates the file with its bytes, in one call', async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 0xef, 0xbb, 0xbf, 7]);
    const r = await ok('createNewBinary', 'drop/blob.bin', bytes.toString('base64'));
    expect(r).toEqual({ path: 'drop/blob.bin', hash: hash(bytes) });
    expect(disk(root, 'drop/blob.bin').equals(bytes)).toBe(true);
  });

  it('never overwrites, refuses a bad name and anything but base64 text', async () => {
    expect(await code('createNewBinary', 'a.md', Buffer.from('x').toString('base64'))).toBe('exists');
    expect(disk(root, 'a.md').toString()).toBe('one\n');
    expect(await code('createNewBinary', 'bad?.bin', '')).toBe('bad_name');
    expect(await code('createNewBinary', 'x.bin', 42)).toBe('bad_arg');
    expect(existsSync(join(root, 'x.bin'))).toBe(false);
  });

  it('carries the epoch like every mutating call', async () => {
    expect(await code('createNewBinary', 'e.bin', '', { epoch: 99 })).toBe('stale_vault');
  });
});

describe('outsideOpen and abs: paths (CONTRACT §5.2)', () => {
  const todo = join(outside, 'todo.md');

  it('an unregistered abs: path is not_registered, a relative one is not absolute', async () => {
    expect(await code('readFile', abs(todo))).toBe('not_registered');
    expect(await code('outsideOpen', 'todo.md')).toBe('bad_arg');
  });

  it('a path inside the vault answers the vault path and registers nothing', async () => {
    const r = await ok('outsideOpen', join(root, 'sub', 'note.md'));
    expect(r).toMatchObject({ path: 'sub/note.md', inside: true, name: 'note.md', exists: true, kind: 'file' });
  });

  it('a path outside the folders the bridge may open is refused', async () => {
    expect(await code('outsideOpen', join(elsewhere, 'secret.md'))).toBe('unsupported');
    expect(await code('readFile', abs(join(elsewhere, 'secret.md')))).toBe('not_registered');
  });

  it('registers an outside file and answers its abs: form', async () => {
    const r = await ok('outsideOpen', todo);
    expect(r).toEqual({ path: abs(todo), inside: false, name: 'todo.md', exists: true, kind: 'file' });
    // Idempotent, and the abs: form itself opens too.
    expect(await ok('outsideOpen', abs(todo))).toEqual(r);
  });

  it('reads, stats, saves and drafts a registered file; no version is kept', async () => {
    const p = abs(todo);
    const f = await ok('readFile', p);
    expect(f).toMatchObject({ text: 'outside text\n', hash: hash('outside text\n'), encoding: 'utf-8', bom: false, lossy: false });
    expect(await ok('stat', p, { sniff: true })).toMatchObject({ exists: true, kind: 'file', text: true });
    expect(await ok('exists', p)).toBe(true);
    expect(await ok('readText', p)).toBe('outside text\n');
    const s = await ok('saveFile', p, 'outside text, edited\n', { expectedHash: f.hash });
    expect(s).toMatchObject({ status: 'saved', hash: hash('outside text, edited\n') });
    expect(readFileSync(todo, 'utf8')).toBe('outside text, edited\n');
    expect(existsSync(join(root, '.ose', 'history'))).toBe(false);
    const c = await ok('saveFile', p, 'late\n', { expectedHash: f.hash });
    expect(c).toMatchObject({ status: 'conflict', disk: { exists: true, text: 'outside text, edited\n' } });

    await ok('draftWrite', p, { text: 'draft text', baselineHash: s.hash, mode: 'live', exact: true, rev: 2 });
    expect(await ok('draftRead', p)).toMatchObject({ path: p, text: 'draft text', mode: 'live', rev: 2 });
    expect((await ok('draftList')).map((d) => d.path)).toContain(p);
    expect(await ok('draftDrop', p, { ifRev: 2 })).toEqual({ dropped: true });
  });

  it('refuses versions, rename, trash, listing and links on an abs: path', async () => {
    const p = abs(todo);
    for (const cmd of ['versionList', 'versionKeep']) expect(await code(cmd, p, 'x'), cmd).toBe('unsupported');
    expect(await code('rename', p, 'x.md')).toBe('escapes_vault');
    expect(await code('trash', p, { mode: 'vault' })).toBe('escapes_vault');
    expect(await code('list', p)).toBe('escapes_vault');
    expect(await code('createNew', p, 'x')).toBe('escapes_vault');
    expect(readFileSync(todo, 'utf8')).toBe('outside text, edited\n');
  });

  it('importOutside copies the bytes in, create-only', async () => {
    const bin = join(outside, 'bytes.bin');
    expect(await code('importOutside', abs(bin), 'in/bytes.bin')).toBe('not_registered');
    await ok('outsideOpen', bin);
    const r = await ok('importOutside', abs(bin), 'in/bytes.bin');
    expect(r).toEqual({ path: 'in/bytes.bin', hash: hash(disk(outside, 'bytes.bin')) });
    expect(disk(root, 'in/bytes.bin').equals(disk(outside, 'bytes.bin'))).toBe(true);
    expect(await code('importOutside', abs(bin), 'in/bytes.bin')).toBe('exists');
    expect(await code('importOutside', 'a.md', 'in/a.md')).toBe('bad_arg');
  });
});

describe('the other new commands', () => {
  it('takeOpens is empty; pickFile and openVaultWindow need the app', async () => {
    expect(await ok('takeOpens')).toEqual([]);
    expect(await code('pickFile')).toBe('unsupported');
    expect(await code('openVaultWindow')).toBe('unsupported');
    expect(await code('openVaultWindow', root)).toBe('unsupported');
  });

  it('openVault adopts, platform has no drag icon, reloadShell is gone', async () => {
    expect(await ok('openVault', root)).toMatchObject({ status: 'adopted', epoch: expect.any(Number) });
    expect(await ok('platform')).toMatchObject({ dragIcon: null });
    expect(await code('reloadShell')).toBe('unknown_command');
  });
});

describe('encodings (X10)', () => {
  it('UTF-8 keeps its byte-order mark in the text', async () => {
    const r = await ok('readFile', 'bom.md');
    expect(r).toMatchObject({ text: '﻿# a\n', encoding: 'utf-8', bom: true, lossy: false });
    await ok('saveFile', 'bom.md', '﻿# ab\n', { expectedHash: r.hash });
    expect(disk(root, 'bom.md').equals(Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x61, 0x62, 0x0a]))).toBe(true);
  });

  it('windows-1252 is detected, and one edit keeps every other byte', async () => {
    expect(await ok('stat', 'latin.txt', { sniff: true })).toMatchObject({ text: true, encoding: 'windows-1252' });
    const r = await ok('readFile', 'latin.txt');
    expect(r).toMatchObject({ text: 'café – 5 €\r\n', encoding: 'windows-1252', bom: false, lossy: false, hash: hash(CP1252) });
    await ok('saveFile', 'latin.txt', 'cafés – 5 €\r\n', { expectedHash: r.hash, encoding: r.encoding });
    const want = Buffer.concat([CP1252.subarray(0, 4), Buffer.from([0x73]), CP1252.subarray(4)]);
    expect(disk(root, 'latin.txt').equals(want)).toBe(true);
  });

  it('a character windows-1252 cannot hold is unencodable, and nothing is written', async () => {
    const r = await ok('readFile', 'latin.txt');
    expect(await code('saveFile', 'latin.txt', 'café 漢\r\n', { expectedHash: r.hash, encoding: 'windows-1252' })).toBe('unencodable');
    expect(hash(disk(root, 'latin.txt'))).toBe(r.hash);
  });

  it('a forced UTF-8 that is not UTF-8 is not_utf8; an unknown label is unsupported', async () => {
    expect(await code('readFile', 'latin.txt', { encoding: 'utf-8' })).toBe('not_utf8');
    expect(await code('readFile', 'latin.txt', { encoding: 'klingon' })).toBe('unsupported');
    expect(await ok('readFile', 'a.md', { encoding: 'latin1' })).toMatchObject({ text: 'one\n', encoding: 'windows-1252' });
  });

  it('UTF-16LE with a BOM round-trips, CRLF and all', async () => {
    expect(await ok('stat', 'le.txt', { sniff: true })).toMatchObject({ text: true, encoding: 'utf-16le' });
    const r = await ok('readFile', 'le.txt');
    expect(r).toMatchObject({ text: '﻿line one\r\nligne deux é\r\n', encoding: 'utf-16le', bom: true, lossy: false });
    await ok('saveFile', 'le.txt', r.text.replace('one', 'uno'), { expectedHash: r.hash, encoding: 'utf-16le' });
    expect(disk(root, 'le.txt').equals(utf16le('line uno\r\nligne deux é\r\n'))).toBe(true);
  });

  it('UTF-16BE with a BOM round-trips', async () => {
    const r = await ok('readFile', 'be.txt');
    expect(r).toMatchObject({ text: '﻿big end\n', encoding: 'utf-16be', bom: true, lossy: false });
    await ok('saveFile', 'be.txt', '﻿big ends\n', { expectedHash: r.hash, encoding: 'utf-16be' });
    expect(disk(root, 'be.txt').equals(utf16be('big ends\n'))).toBe(true);
  });

  it('a decode that does not round-trip is lossy, and its save is refused', async () => {
    const r = await ok('readFile', 'odd.txt');
    expect(r).toMatchObject({ encoding: 'utf-16le', lossy: true });
    const before = disk(root, 'odd.txt');
    expect(await code('saveFile', 'odd.txt', r.text, { expectedHash: r.hash, encoding: 'utf-16le' })).toBe('lossy');
    expect(disk(root, 'odd.txt').equals(before)).toBe(true);
  });
});

describe('the media origin: Range and ~abs', () => {
  it('answers the whole file with Accept-Ranges', async () => {
    const r = await media('/vault/media.bin');
    expect(r.status).toBe(200);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.body.length).toBe(100);
  });

  it('answers a slice with 206 and Content-Range', async () => {
    const r = await media('/vault/media.bin', 'bytes=10-19');
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 10-19/100');
    expect([...r.body]).toEqual(Array.from({ length: 10 }, (_, i) => 10 + i));
  });

  it('an open end and a suffix', async () => {
    const open = await media('/vault/media.bin', 'bytes=95-');
    expect(open.status).toBe(206);
    expect([...open.body]).toEqual([95, 96, 97, 98, 99]);
    const suffix = await media('/vault/media.bin', 'bytes=-3');
    expect(suffix.headers['content-range']).toBe('bytes 97-99/100');
    expect([...suffix.body]).toEqual([97, 98, 99]);
  });

  it('a range past the end is 416', async () => {
    const r = await media('/vault/media.bin', 'bytes=100-200');
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */100');
  });

  it('serves media beside a registered outside file, and nothing else', async () => {
    await ok('outsideOpen', join(outside, 'todo.md'));
    const url = (native) => `/vault/~abs/${native.replace(/\\/g, '/').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;
    const r = await media(url(join(outside, 'pics', 'p.png')));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.body.equals(disk(outside, 'pics/p.png'))).toBe(true);
    expect((await media(url(join(elsewhere, 'secret.md')))).status).toBe(404);
  });
});

describe('the watch of an outside folder', () => {
  it('reports a change to a registered file with its abs: path', async () => {
    const todo = join(outside, 'todo.md');
    await ok('outsideOpen', todo);
    await new Promise((r) => setTimeout(r, 100));
    events.length = 0;
    writeFileSync(todo, 'changed outside\n');
    const deadline = Date.now() + 5000;
    let hit = null;
    while (!hit && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      hit = events.find((e) => e.event === 'fs' && e.data.changes.some((c) => c.path === abs(todo)));
    }
    expect(hit, JSON.stringify(events)).toBeTruthy();
    expect(hit.data.changes.find((c) => c.path === abs(todo)).kind).toBe('modify');
  });
});
