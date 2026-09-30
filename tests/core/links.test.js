// H6: the inbound link rewrite reads with readFile, writes with save({expectedHash}), and a conflict lands in failed.
import { test, expect, vi } from 'vitest';

const saved = new Map();
vi.mock('../../src/core/bridge/index.ts', () => {
  const files = new Map([
    ['old.md', '# Old\n'],
    ['x.md', "See [o](old.md), `[c](old.md)`, <!-- [h](old.md) -->\r\n\r\n    [i](old.md)\r\n\r\n[r]: old.md\r\n"],
    ['y.md', '[o](old.md#top)\n'],
    ['z.txt', '[o](old.md)\n'],
  ]);
  const bridge = {
    kind: 'http', ready: Promise.resolve(), on: () => () => {},
    log: async () => null,
    search: async () => ({ hits: [...files.keys()].map((path) => ({ path })) }),
    readText: async (p) => files.get(p),
    readFile: async (p) => ({ text: files.get(p), hash: 'h:' + p }),
    saveFile: async (p, text, opts) => {
      if (p === 'y.md') return { status: 'conflict', disk: { exists: true, text: 'other', hash: 'zz' } };
      saved.set(p, { text, opts });
      return { status: 'saved', hash: 'n' };
    },
    versionKeep: async () => ({ kept: true }),
  };
  return { bridge, setEpoch() {}, currentEpoch: () => 1, HostError: Error, hostError: (_c, e) => e };
});

const { rewriteInboundMany, findInbound, planRewrite } = await import('../../src/core/links.ts');

test('rewrite touches only real links, keeps CRLF, conflicts land in failed', async () => {
  const r = await rewriteInboundMany([{ from: 'old.md', to: 'sub/new.md' }]);
  expect(r.failed).toEqual(['y.md']);
  expect(r.files).toBe(1);
  expect(r.links).toBe(2);
  const x = saved.get('x.md');
  expect(x.opts.expectedHash).toBe('h:x.md');
  expect(x.text).toBe("See [o](sub/new.md), `[c](old.md)`, <!-- [h](old.md) -->\r\n\r\n    [i](old.md)\r\n\r\n[r]: sub/new.md\r\n");
  expect(saved.has('z.txt')).toBe(false);
});

test('findInbound counts real links only', async () => {
  const r = await findInbound('old.md');
  const x = r.find((e) => e.path === 'x.md');
  expect(x.lines.map((l) => l.line)).toEqual([1, 5]);
});

test('planRewrite is async and plans the same splices, offsets into the text (H5)', async () => {
  const text = 'See [o](old.md) and `[c](old.md)`.\n';
  const pending = planRewrite(text, 'a.md', [{ from: 'old.md', to: 'sub/new.md' }]);
  expect(pending).toBeInstanceOf(Promise);
  const splices = await pending;
  expect(splices).toEqual([{ from: 8, to: 14, insert: 'sub/new.md' }]);
});

test('planRewrite with settled does not treat the file as moved (the second pass)', async () => {
  // The file itself moved from notes/a.md to a.md: its own relative href is re-pointed ...
  const moved = await planRewrite('[b](b.md)\n', 'a.md', [{ from: 'notes/a.md', to: 'a.md' }]);
  expect(moved).toEqual([{ from: 4, to: 8, insert: 'notes/b.md' }]);
  // ... unless its own hrefs were already rewritten: then nothing moves.
  const settled = await planRewrite('[b](notes/b.md)\n', 'a.md', [{ from: 'notes/a.md', to: 'a.md' }], { settled: true });
  expect(settled).toEqual([]);
});
