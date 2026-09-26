// @vitest-environment happy-dom
// The Tauri adapter on the typed commands (CONTRACT X5, §4.1.3), under Tauri's own IPC mock:
// the functions tauri-specta generated (src/kernel/bridge/bindings.ts) call `invoke`, the mock
// answers as the host would, and the adapter (src/kernel/bridge/tauri.js) must
//
//   - unwrap a `Result`: `{status:'ok', data}` is the data;
//   - turn the host's `{code, message}` into a HostError with that code;
//   - answer a name that is not a command with `unknown_command`, and so Tauri's own
//     "command … not found";
//   - read Tauri's serde refusal ("invalid args …") as `bad_arg`.
//
// And the bindings themselves: every command of §4.1.2 is there under today's name, the string
// dispatcher is gone, and the dev bridge (dev/bridge-plugin.mjs) answers every name the
// bindings export, so the browser and the app speak the same commands.
//
// Depends on: host (bindings.ts), kernel (bridge/tauri.js), build-tests (the dev bridge).

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const { commands } = await import('../../src/kernel/bridge/bindings.ts');
const T = await import('../../src/kernel/bridge/tauri.js');

/** What the mock host answers, per Rust command name; plugin calls (events, window) answer null. */
let host = {};
const seen = [];

beforeEach(() => {
  host = {};
  seen.length = 0;
  mockWindows('main');
  mockIPC((cmd, payload) => {
    seen.push([cmd, payload]);
    if (cmd.startsWith('plugin:')) return cmd.endsWith('|listen') ? 1 : null;
    const h = host[cmd];
    if (!h) throw `command ${cmd} not found`;
    return h(payload);
  }, { shouldMockEvents: true });
});

afterEach(() => clearMocks());

/** The contract's commands (§4.1.2), by their JS names. */
const NAMES = [
  'rootInfo', 'vaultInfo', 'pickVault', 'openVault', 'openVaultWindow', 'recentVaults', 'forgetVault', 'platform', 'quit', 'log',
  'tree', 'list', 'stat', 'exists', 'search',
  'readText', 'readFile', 'saveFile', 'createNew', 'createNewBinary', 'copyFile', 'importOutside', 'appendLine', 'replaceLine',
  'writeText', 'appendText', 'writeBinary', 'readBinary', 'mkdir', 'rename', 'copyPath',
  'trash', 'trashWhere', 'trashList', 'trashRestore',
  'draftWrite', 'draftList', 'draftRead', 'draftDrop',
  'versionKeep', 'versionList', 'versionRead', 'versionRestore',
  'getState', 'setState', 'localGet', 'localSet',
  'openExternal', 'openPath', 'reveal', 'printToPdf', 'showPrintUI',
  'outsideOpen', 'takeOpens', 'pickFile',
];

describe('the bindings (§4.1.2)', () => {
  it('export every command under today\'s name', () => {
    const missing = NAMES.filter((n) => typeof commands[n] !== 'function');
    expect(missing).toEqual([]);
  });

  it('have no string dispatcher and no retired name', () => {
    for (const n of ['rpc', 'reloadShell', 'reloadRice', 'riceInfo']) expect(commands[n], n).toBeUndefined();
  });
});

describe('the Tauri adapter on the typed commands (§4.1.3)', () => {
  it('unwraps a Result and passes the arguments by name', async () => {
    const file = { text: 'one\n', hash: 'cbf29ce484222325', mtime: 1, size: 4, encoding: 'utf-8', bom: false, lossy: false };
    host.read_file = () => file;
    await expect(T.invoke('readFile', ['a.md'])).resolves.toEqual(file);
    const call = seen.find(([c]) => c === 'read_file');
    expect(call[1]).toMatchObject({ path: 'a.md' });
  });

  it('turns the host\'s {code, message} into a HostError with that code', async () => {
    host.save_file = () => { throw { code: 'stale_vault', message: 'this page belongs to vault epoch 1' }; };
    const e = await T.invoke('saveFile', ['a.md', 'x', { expectedHash: null }]).catch((err) => err);
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ code: 'stale_vault', message: 'this page belongs to vault epoch 1', cmd: 'saveFile' });
  });

  it('keeps a code with a digit in it', async () => {
    host.read_file = () => { throw { code: 'not_utf8', message: 'not valid UTF-8: a.md' }; };
    await expect(T.invoke('readFile', ['a.md'])).rejects.toMatchObject({ code: 'not_utf8' });
  });

  it('a name that is not a command is unknown_command, never a null', async () => {
    await expect(T.invoke('noSuchCommand', [])).rejects.toMatchObject({ code: 'unknown_command', cmd: 'noSuchCommand' });
    await expect(T.invoke('rpc', [])).rejects.toMatchObject({ code: 'unknown_command' });
  });

  it('Tauri\'s own "command not found" is unknown_command', async () => {
    // The bindings name it, the host does not register it (an old host).
    const e = await T.invoke('readFile', ['a.md']).catch((err) => err);
    expect(e).toMatchObject({ code: 'unknown_command' });
  });

  it('a serde argument error is bad_arg', async () => {
    host.save_file = () => { throw 'invalid args `opts` for command `save_file`: missing field `expectedHash`'; };
    const e = await T.invoke('saveFile', ['a.md', 'x', {}]).catch((err) => err);
    expect(e).toMatchObject({ code: 'bad_arg', cmd: 'saveFile' });
  });

  it('create() gives an adapter whose invoke is the same', async () => {
    host.root_info = () => ({ root: 'D:/v', name: 'v', epoch: 3 });
    const a = await T.create();
    expect(typeof a.invoke).toBe('function');
    expect(typeof a.subscribe).toBe('function');
    await expect(a.invoke('rootInfo', [])).resolves.toEqual({ root: 'D:/v', name: 'v', epoch: 3 });
  });
});

describe('the dev bridge answers every command the bindings export', () => {
  const base = mkdtempSync(join(tmpdir(), 'ose-typed-'));
  const root = join(base, 'vault');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.md'), 'one\n');
  const http = new EventEmitter();
  let middleware;

  afterAll(() => {
    http.emit('close');
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  });

  it('with no [unknown_command]', async () => {
    process.env.OSE_ROOT = root;
    process.env.OSE_APPDATA = join(base, 'appdata');
    const { bridgePlugin } = await import('../../dev/bridge-plugin.mjs');
    bridgePlugin().configureServer({ httpServer: http, middlewares: { use: (fn) => { middleware = fn; } } });
    const call = (cmd, args) => new Promise((resolve, reject) => {
      const body = JSON.stringify({ args });
      const req = { url: `/__bridge/${cmd}`, method: 'POST', async *[Symbol.asyncIterator]() { yield body; } };
      const res = { statusCode: 200, setHeader() {}, end(text) { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } } };
      middleware(req, res, () => reject(new Error(`not a bridge call: ${cmd}`)));
    });
    // No arguments, except for the three that would start a program: they get an outside path
    // this bridge never registered, which each refuses before it spawns anything.
    const REFUSED = { openPath: ['abs:/nowhere'], reveal: ['abs:/nowhere'], openExternal: ['abs:/nowhere'] };
    const unknown = [];
    for (const name of Object.keys(commands)) {
      const r = await call(name, REFUSED[name] || []);
      if (!r.ok && /^\[unknown_command\]/.test(r.error)) unknown.push(name);
    }
    expect(unknown).toEqual([]);
    delete process.env.OSE_ROOT;
    delete process.env.OSE_APPDATA;
  });
});
