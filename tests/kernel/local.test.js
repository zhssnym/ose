// ose.local's debounced write (src/kernel/local.js, W5). A write reads the disk first and lays
// the keys this window changed over it; a key set while that read is out must survive it, in
// the cache and on disk. This was the "session save, seen once" of the wave-2 integration: the
// recent list's write read the disk while the session's flush set 'session', and the merge put
// the disk's older session back.

import { test, expect, vi } from 'vitest';
let disk = { session: 'OLD' };
const pending = [];
vi.mock('../../src/kernel/bridge/index.js', () => ({
  bridge: {
    localGet: () => new Promise((res) => pending.push(() => res(JSON.parse(JSON.stringify(disk))))),
    localSet: async (_n, v) => { disk = JSON.parse(JSON.stringify(v)); return null; },
  },
}));
vi.mock('../../src/kernel/log.js', () => ({ logLine: () => {} }));
test('a key set while a write reads the disk is not lost', async () => {
  vi.useFakeTimers();
  const L = await import('../../src/kernel/local.js');
  const p0 = L.loadLocal(); pending.shift()(); pending.shift()(); await p0;
  L.local('recent').set(['a.md']);
  const w1 = L.local('recent').flush();        // first write: awaiting localGet
  await Promise.resolve(); await Promise.resolve();
  L.local('session').set('NEW');               // set while the read is in flight
  const w2 = L.local('session').flush();
  while (pending.length === 0) await Promise.resolve();
  pending.shift()();                           // first read answers
  await w1;
  while (pending.length === 0) await Promise.resolve();
  pending.shift()();
  await w2;
  expect(L.local('session').get()).toBe('NEW');
  expect(disk.session).toBe('NEW');
});
