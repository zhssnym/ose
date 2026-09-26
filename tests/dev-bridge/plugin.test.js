// The dev bridge's HTTP surface (dev/bridge-plugin.mjs): the same answers as the host for what
// a page cannot see in dev/files.mjs alone. A command nobody implements fails with
// `[unknown_command] <cmd>` (CONTRACT 3.1), a retired one still answers null, a failure keeps
// its `[code]`, and the new commands answer through the same door. The plugin is driven the way
// Vite drives it, with a stand-in server, over a temp vault and a temp app-data folder.
//
// Depends on: host (dev/bridge-plugin.mjs).

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let base;
let root;
let middleware;
let http;

/** One bridge call, the way src/kernel/bridge/http.js makes it: POST /__bridge/<cmd> {args}. */
async function call(cmd, ...args) {
  const body = JSON.stringify({ args });
  const req = {
    url: `/__bridge/${cmd}`,
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield body; },
  };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(text) { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } },
    };
    middleware(req, res, () => reject(new Error(`not a bridge call: ${cmd}`)));
  });
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'ose-plugin-'));
  root = join(base, 'vault');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.md'), 'one\n');
  process.env.OSE_ROOT = root;
  process.env.OSE_DEV_APPDATA = join(base, 'appdata');
  const { bridgePlugin } = await import('../../dev/bridge-plugin.mjs');
  const plugin = bridgePlugin();
  http = new EventEmitter();
  plugin.configureServer({ httpServer: http, middlewares: { use: (fn) => { middleware = fn; } } });
});

afterAll(() => {
  http.emit('close');
  delete process.env.OSE_ROOT;
  delete process.env.OSE_DEV_APPDATA;
  rmSync(base, { recursive: true, force: true });
});

describe('the dev bridge over HTTP', () => {
  it('a command nobody implements is [unknown_command]', async () => {
    expect(await call('noSuchCommand', 1)).toEqual({ ok: false, error: '[unknown_command] noSuchCommand' });
  });

  it('a retired command still answers null', async () => {
    expect(await call('riceInfo')).toEqual({ ok: true, result: null });
  });

  it('readFile and saveFile answer the host\'s shapes', async () => {
    const r = await call('readFile', 'a.md');
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ text: 'one\n', hash: expect.stringMatching(/^[0-9a-f]{16}$/), size: 4 });
    const s = await call('saveFile', 'a.md', 'two\n', { expectedHash: r.result.hash });
    expect(s.result).toMatchObject({ status: 'saved' });
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('two\n');
    const c = await call('saveFile', 'a.md', 'three\n', { expectedHash: r.result.hash });
    expect(c.result).toMatchObject({ status: 'conflict', disk: { exists: true, text: 'two\n' } });
  });

  it('a failure keeps its [code]', async () => {
    expect(await call('readFile', 'missing.md')).toMatchObject({ ok: false, error: expect.stringMatching(/^\[not_found\] /) });
    expect(await call('createNew', 'a.md', 'x')).toMatchObject({ ok: false, error: expect.stringMatching(/^\[exists\] /) });
    expect(await call('saveFile', 'a.md', 'x', { expectedHash: null, epoch: 99 })).toMatchObject({ ok: false, error: expect.stringMatching(/^\[stale_vault\] /) });
  });

  it('rootInfo and vaultInfo carry the epoch, platform the log path', async () => {
    expect((await call('rootInfo')).result).toMatchObject({ epoch: expect.any(Number) });
    expect((await call('vaultInfo')).result).toMatchObject({ epoch: expect.any(Number) });
    expect((await call('platform')).result).toMatchObject({ logPath: expect.any(String) });
  });

  it('pickVault with adopt:false only chooses', async () => {
    const r = await call('pickVault', { adopt: false });
    expect(r.ok).toBe(true);
  });

  it('drafts go to the app-data folder named by OSE_DEV_APPDATA', async () => {
    const w = await call('draftWrite', 'a.md', { text: 'buffer', baselineHash: null, mode: 'rich', exact: true, rev: 1 });
    expect(w.result).toMatchObject({ at: expect.any(Number) });
    expect((await call('draftList')).result.map((d) => d.path)).toEqual(['a.md']);
    expect((await call('draftDrop', 'a.md')).result).toEqual({ dropped: true });
  });
});
