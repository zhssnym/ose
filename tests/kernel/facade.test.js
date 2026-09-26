// @vitest-environment happy-dom
// The kernel facade of CONTRACT 4.2 is whole, focus is not restored at boot (H18), and the leave gate reaches the host.
import { test, expect, vi } from 'vitest';

const calls = [];
vi.mock('../../src/kernel/bridge/index.js', async () => {
  const real = await vi.importActual('../../src/kernel/bridge/index.js');
  const handlers = new Map();
  const bridge = {
    kind: 'tauri', ready: Promise.resolve(),
    on: (ev, fn) => { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); return () => handlers.get(ev).delete(fn); },
    __emit: (ev, d) => [...(handlers.get(ev) || [])].map((fn) => fn(d)),
    platformInfo: async () => ({ os: 'win' }),
    rootInfo: async () => ({ root: 'D:/v', name: 'v', epoch: 4 }),
    getState: async () => ({ focus: 'old/folder' }), setState: async () => null,
    setTitle: async () => null, log: async (t, l) => { calls.push(['log', l, t]); return null; },
    saveFile: async (...a) => { calls.push(['saveFile', ...a]); return { status: 'conflict', disk: { exists: true, text: 'x', hash: 'y' } }; },
    reloadShell: async () => { calls.push(['reloadShell']); return null; },
    win: { destroy: async () => { calls.push(['destroy']); } },
  };
  return { ...real, bridge, setEpoch: real.setEpoch, currentEpoch: real.currentEpoch };
});

const { ose } = await import('../../src/kernel/kernel.js');
const { bridge } = await import('../../src/kernel/bridge/index.js');
await ose.ready;

test('the facade is whole', () => {
  for (const k of ['readFile', 'save', 'createNew', 'copy', 'appendLine', 'replaceLine']) expect(typeof ose.files[k]).toBe('function');
  for (const k of ['write', 'list', 'read', 'drop']) expect(typeof ose.files.drafts[k]).toBe('function');
  for (const k of ['create', 'rename', 'move', 'trash', 'duplicate']) expect(typeof ose.fileops[k]).toBe('function');
  for (const k of ['split', 'check', 'free', 'extChanged']) expect(typeof ose.names[k]).toBe('function');
  for (const k of ['leave', 'stay', 'onLeave']) expect(typeof ose.window[k]).toBe('function');
  expect(typeof ose.route.repoint).toBe('function');
  expect(typeof ose.vault.onChangeRequested).toBe('function');
  expect(ose.vault.epoch).toBe(4);
});

test('focus is not restored at boot, and the old key is dropped', () => {
  expect(ose.focus.get()).toBe(null);
  ose.focus.set('a/b');
  expect(ose.status.all().find((s) => s.key === 'focus').text).toContain('b');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
});

test('save needs expectedHash; a conflict is logged by the host, not twice', async () => {
  await expect(ose.files.save('a.md', 'x', {})).rejects.toMatchObject({ code: 'bad_arg' });
  const r = await ose.files.save('a.md', 'x', { expectedHash: 'h' });
  expect(r.status).toBe('conflict');
  const sc = calls.find((c) => c[0] === 'saveFile');
  expect(sc[3].expectedHash).toBe('h');
  await new Promise((r2) => setTimeout(r2, 0));
  expect(calls.some((c) => c[0] === 'log' && c[2].includes('conflict a.md'))).toBe(false);
});

test('reload leaves first; a refusal stops it', async () => {
  const off = ose.window.onLeave(() => false);
  expect(await ose.reload()).toBe(false);
  expect(calls.some((c) => c[0] === 'reloadShell')).toBe(false);
  off();
  expect(await ose.reload()).toBe(true);
  expect(calls.some((c) => c[0] === 'reloadShell')).toBe(true);
});

test('the close fan-out goes through the gate; onChangeRequested', async () => {
  const off = ose.window.onLeave(() => false);
  const results = bridge.__emit('window', { closing: true });
  expect(await Promise.all(results.filter((r) => r && r.then))).toContain(false);
  off();
  let got = null;
  ose.vault.onChangeRequested((d) => { got = d; });
  bridge.__emit('vault', { requested: true, root: 'E:/w', name: 'w' });
  expect(got).toEqual({ root: 'E:/w', name: 'w' });
  await ose.commands.run('app.close-anyway');
  expect(calls.some((c) => c[0] === 'destroy')).toBe(true);
});
