// H6: link destinations are found with the editor's parser, so code, comments and maths are never touched.
import { linkSpans } from '../../src/kernel/links.js';
import { test, expect } from 'vitest';
const hrefs = async (t) => (await linkSpans(t)).map((s) => t.slice(s.start, s.end));
test('only real links', async () => {
  const t = "Use `[x](old.md)` literally.\n\n    [y](old.md) indented code\n\n<!-- [z](old.md) -->\n\n[a](old.md) and ![i](img/p.png \"t\") and [b](<my file.md>)\n\n[r]: old.md \"title\"\n\n```\n[f](old.md)\n```\n\n$[m](old.md)$ [c](a(b).md#h) [`]`](k.md)\n";
  expect(await hrefs(t)).toEqual(['old.md', 'img/p.png', 'my file.md', 'old.md', 'a(b).md#h', 'k.md']);
});
test('crlf and tails', async () => {
  const t = "[a](x.md#frag)\r\n\r\n[b]:\r\n  <y.md>\r\n";
  const s = await linkSpans(t);
  expect(s.map((x) => [x.href, x.tail])).toEqual([['x.md', '#frag'], ['y.md', '']]);
  expect(t.slice(s[1].start, s[1].end)).toBe('y.md');
});
