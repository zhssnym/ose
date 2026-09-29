// @vitest-environment happy-dom
// The kernel facade is whole: the wave-1 calls (CONTRACT 4.2 of wave 1), focus not restored at
// boot (H18), the leave gate reaching the host; and the wave-2 calls (CONTRACT §4) with the
// plugin runtime gone (W2).
import { describe, expect, it, test, vi } from 'vitest';

const calls = [];
vi.mock('../../src/kernel/bridge/index.js', async () => {
  const real = await vi.importActual('../../src/kernel/bridge/index.js');
  const handlers = new Map();
  const bridge = {
    kind: 'web', ready: Promise.resolve(),
    on: (ev, fn) => { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); return () => handlers.get(ev).delete(fn); },
    __emit: (ev, d) => [...(handlers.get(ev) || [])].map((fn) => fn(d)),
    platformInfo: async () => ({ os: 'win' }),
    rootInfo: async () => ({ root: 'D:/v', name: 'v', epoch: 4 }),
    getState: async () => ({ focus: 'old/folder' }), setState: async () => null,
    localGet: async () => ({}), localSet: async () => null,
    setTitle: async () => null, log: async (t, l) => { calls.push(['log', l, t]); return null; },
    saveFile: async (...a) => { calls.push(['saveFile', ...a]); return { status: 'conflict', disk: { exists: true, text: 'x', hash: 'y' } }; },
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

test('reload leaves first; a refusal stops it; the document reloads itself (X4)', async () => {
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  const off = ose.window.onLeave(() => false);
  expect(await ose.reload()).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  off();
  expect(await ose.reload()).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
  reload.mockRestore();
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

describe('the wave-2 facade (CONTRACT §4)', () => {
  it('has tabs, the session, the per-machine store and the new file calls', () => {
    for (const k of ['list', 'active', 'open', 'activate', 'close', 'closeOthers', 'move', 'reopenClosed', 'on']) expect(typeof ose.tabs[k], `tabs.${k}`).toBe('function');
    for (const k of ['snapshot', 'restore']) expect(typeof ose.session[k], `session.${k}`).toBe('function');
    expect(typeof ose.local).toBe('function');
    expect(typeof ose.local.app).toBe('function');
    for (const k of ['get', 'set', 'flush']) expect(typeof ose.local('x')[k], `local().${k}`).toBe('function');
    for (const k of ['list', 'tree', 'stat', 'copyPath', 'trashWhere', 'trashList']) expect(typeof ose.files[k], `files.${k}`).toBe('function');
    for (const k of ['mkdir', 'copy', 'paste', 'restore', 'trashList']) expect(typeof ose.fileops[k], `fileops.${k}`).toBe('function');
    for (const k of ['list', 'canUndo', 'undo', 'on']) expect(typeof ose.fileops.journal[k], `journal.${k}`).toBe('function');
    expect(typeof ose.names.display).toBe('function');
    expect(typeof ose.links.planRewrite).toBe('function');
    expect(typeof ose.route.setHome).toBe('function');
    expect(typeof ose.setFolderHost).toBe('function');
  });

  it('the plugin runtime is gone (W2)', () => {
    for (const k of ['run', 'schedule', 'tiles', 'api']) expect(ose[k], `ose.${k}`).toBeUndefined();
    for (const k of ['own', 'index', 'indexed', 'title']) expect(ose.route[k], `ose.route.${k}`).toBeUndefined();
  });

  it('the settings have their wave-2 keys and defaults (W5, W7, W8)', () => {
    const s = ose.settings.get();
    expect(s).toMatchObject({ showHidden: false, restoreSession: true, hideMdExt: false, titleSync: false, trash: 'system', attachments: 'beside' });
    expect('newPages' in s).toBe(false);
  });

  it('names.display shows the full name; .md is stripped only when asked', () => {
    expect(ose.names.display('notes/a.md')).toBe('a.md');
    expect(ose.names.display('notes/script.py')).toBe('script.py');
    expect(ose.names.display('README')).toBe('README');
  });
});
