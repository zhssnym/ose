// The bridge facade (CONTRACT 4.2): one method per host command, the epoch added to every
// mutating call, and every refusal turned into an Error with `.code` and `.cmd`. For the new
// commands a `null` answer is never a success: a host that does not know `saveFile` must not
// read as a save that worked.
//
// The adapter under the facade is replaced by one that answers what each test scripts.
//
// Depends on: kernel (src/kernel/bridge/index.js).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const seen = [];
let answer = async () => null;

vi.mock('../../src/kernel/bridge/http.js', () => ({
  create: async () => ({
    invoke: (cmd, args) => { seen.push([cmd, args]); return answer(cmd, args); },
    subscribe: () => {},
  }),
}));

const B = await import('../../src/kernel/bridge/index.js');

beforeEach(() => {
  seen.length = 0;
  answer = async () => null;
  B.setEpoch(null);
});

describe('errors', () => {
  it('[code] message becomes an Error with message, code and cmd', async () => {
    answer = async () => { throw '[stale_vault] this page belongs to another vault'; };
    const e = await B.bridge.saveFile('a.md', 'x', { expectedHash: null }).catch((err) => err);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('this page belongs to another vault');
    expect(e.code).toBe('stale_vault');
    expect(e.cmd).toBe('saveFile');
  });

  it('a refusal with no code is io', async () => {
    answer = async () => { throw new Error('disk on fire'); };
    const e = await B.bridge.readFile('a.md').catch((err) => err);
    expect(e.code).toBe('io');
    expect(e.message).toBe('disk on fire');
  });

  it.each([
    ['readFile', ['a.md']],
    ['saveFile', ['a.md', 'x', { expectedHash: null }]],
    ['createNew', ['a.md', '']],
    ['copyFile', ['a.md', 'b.md']],
    ['appendLine', ['a.log', 'x']],
    ['replaceLine', ['a.md', 0, 'a', 'b']],
    ['draftWrite', ['a.md', { text: 'x' }]],
    ['draftList', []],
    ['draftDrop', ['a.md', {}]],
  ])('%s answering null is unknown_command, never a success', async (cmd, args) => {
    answer = async () => null;
    const e = await B.bridge[cmd](...args).then(() => null, (err) => err);
    expect(e && e.code).toBe('unknown_command');
    expect(e.cmd).toBe(cmd);
  });

  it('draftRead answering null is "no draft", not an error', async () => {
    answer = async () => null;
    await expect(B.bridge.draftRead('a.md')).resolves.toBe(null);
  });
});

describe('the epoch', () => {
  it('is added to the options of every mutating call', async () => {
    B.setEpoch(3);
    answer = async () => ({ status: 'saved', hash: 'h', mtime: 0 });
    await B.bridge.saveFile('a.md', 'x', { expectedHash: null });
    await B.bridge.createNew('b.md', '');
    await B.bridge.appendLine('c.log', 'x');
    await B.bridge.replaceLine('d.md', 0, 'a', 'b');
    await B.bridge.copyFile('a.md', 'e.md');
    await B.bridge.writeText('f.md', 'x');
    await B.bridge.rename('f.md', 'g.md');
    for (const [cmd, args] of seen) {
      expect(args.at(-1), cmd).toMatchObject({ epoch: 3 });
    }
    expect(seen.find(([c]) => c === 'saveFile')[1]).toEqual(['a.md', 'x', { expectedHash: null, epoch: 3 }]);
  });

  it('an epoch the caller names is kept', async () => {
    B.setEpoch(3);
    answer = async () => ({ path: 'a.md', hash: 'h' });
    await B.bridge.createNew('a.md', '', { epoch: 1 });
    expect(seen[0][1].at(-1)).toEqual({ epoch: 1 });
  });

  it('no epoch known: nothing is added', async () => {
    answer = async () => ({ path: 'a.md', hash: 'h' });
    await B.bridge.createNew('a.md', '');
    expect(seen[0][1].at(-1)).toEqual({});
  });
});
