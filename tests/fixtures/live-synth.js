// Synthetic whole files for the Live property tests (tests/live/properties.test.js): markdown
// made of the constructs Live draws differently off the caret (frontmatter, headings, emphasis,
// links and wikilinks, lists and tasks, quotes and callouts, tables, maths, fences, images, HTML,
// rules), written with every line ending a file can have (LF, CRLF, CR and a mix of them), with
// or without a byte-order mark and a final line break. Nothing here comes from a real note.
//
// Deterministic: the same seed gives the same files, so a red run is a change in the code, not
// a new draw. `rng(seed)` is the generator the tests also use for their edits and selections.

/**
 * mulberry32: a small seeded generator of numbers in [0, 1).
 * @param {number} seed
 * @returns {{ next: () => number, int: (n: number) => number, pick: <T>(a: readonly T[]) => T, chance: (p: number) => boolean }}
 */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  return { next, int, pick: (arr) => arr[int(arr.length)], chance: (p) => next() < p };
}

/** Inline pieces: text a line is made of. */
export const INLINE = [
  'plain words', 'café et thé', 'naïve résumé', '日本語のテキスト', 'emoji 🙂 here', 'tab\there',
  '_emphasis_', '*star emphasis*', '**strong**', '__strong too__', '~~struck~~', '`code span`', '``a ` b``',
  '[a link](https://example.com)', '[titled](https://example.com "Title")', '<https://example.com>',
  'https://bare.example.com/path', '[[Page]]', '[[Page|alias]]', '[[Folder/Page#Heading]]', '[[missing note]]',
  '$x^2$', '$\\frac{a}{b}$', '5 $ puis 10 $', '\\$5', '![img](pic.png)', '![alt|200](pic.png)', '![[pic.png]]',
  '![[pic.png|300]]', '<b>html</b>', '<!-- note -->', 'a \\* escaped', 'snake_case_name', 'trailing  ',
  'x < y > z & w', '#not-a-heading', 'end with backslash\\', '1. not a list mid-line', '[ ] bracket',
];

/** Whole blocks, as arrays of lines (no line endings). */
const BLOCKS = [
  (r) => [`# ${r.pick(INLINE)}`],
  (r) => [`${'#'.repeat(2 + r.int(5))} ${r.pick(INLINE)}`],
  (r) => [`${r.pick(INLINE)} ${r.pick(INLINE)}`, r.pick(INLINE)],
  (r) => [r.pick(INLINE)],
  (r) => ['- one', `- ${r.pick(INLINE)}`, '  - nested', '- three'],
  (r) => ['* star', '+ plus', `- ${r.pick(INLINE)}`],
  (r) => ['1. first', `2. ${r.pick(INLINE)}`, '10) tenth'],
  (r) => ['- [ ] open task', `- [x] done ${r.pick(INLINE)}`, '- [X] done upper', '  - [ ] nested task'],
  (r) => [`* [ ] ${r.pick(INLINE)}`, '1. [ ] numbered task'],
  (r) => [`> ${r.pick(INLINE)}`, '> second line', '>', '> > nested'],
  (r) => [`> [!${r.pick(['note', 'tip', 'info', 'warning', 'danger', 'caution', 'quote', 'custom'])}] ${r.pick(INLINE)}`, `> ${r.pick(INLINE)}`, '> - [ ] task in a callout'],
  () => [`> [!warning]- Folded`, '> body'],
  (r) => ['| a | b |', '| --- | :-: |', `| ${r.pick(INLINE)} | 2 |`, '| x \\| y | `|` |'],
  () => ['|x|y|', '|-|-|', '|1|2|'],
  () => ['| only header |', '| --- |'],
  () => ['$$', '\\begin{aligned}', 'a &= b \\\\', 'c &= d', '\\end{aligned}', '$$'],
  (r) => [`$$${r.pick(['x', 'e^{i\\pi}+1=0', '\\sum_i i'])}$$`],
  (r) => ['```js', 'const a = 1;', '', `// ${r.pick(INLINE)}`, '```'],
  () => ['~~~python', 'print("hi")', '~~~'],
  (r) => ['```', 'unclosed fence', r.pick(INLINE)],
  () => ['    indented code', '    more'],
  (r) => ['<div>', `html ${r.pick(INLINE)}`, '</div>'],
  () => ['<!--', 'a comment', '-->'],
  (r) => [r.pick(['---', '***', '___', '- - -'])],
  (r) => [`![${r.pick(['alt', 'a|300', ''])}](${r.pick(['pic.png', 'sub/p.jpg', 'https://example.com/i.png', 'missing.png'])})`],
  (r) => ['Setext title', r.pick(['===', '---'])],
  (r) => ['[ref]: https://example.com "T"', `See [ref] and ${r.pick(INLINE)}`],
  () => ['Text[^1].', '', '[^1]: The note.'],
  () => ['   '],
  () => [''],
];

const FRONTMATTER = [
  ['---', 'title: A title', 'tags: [a, b]', '---'],
  ['---', 'date: 2026-09-26', 'aliases:', '  - one', '  - two', '...'],
  ['---', '---'],
  ['---', 'unclosed: true'],
];

const ENDINGS = ['lf', 'crlf', 'cr', 'mixed'];

/**
 * One synthetic file.
 * @param {ReturnType<typeof rng>} r
 * @returns {{ text: string, shape: string }}
 */
function one(r) {
  const lines = [];
  const fm = r.chance(0.35);
  if (fm) lines.push(...r.pick(FRONTMATTER));
  if (r.chance(0.5)) lines.push(`# ${r.pick(INLINE)}`);
  const n = 1 + r.int(9);
  for (let i = 0; i < n; i++) {
    if (lines.length) for (let k = r.chance(0.8) ? 1 : r.int(4); k > 0; k--) lines.push('');
    lines.push(...r.pick(BLOCKS)(r));
  }
  const ending = r.pick(ENDINGS);
  const sep = () => (ending === 'lf' ? '\n' : ending === 'crlf' ? '\r\n' : ending === 'cr' ? '\r' : r.pick(['\n', '\r\n', '\r']));
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    text += lines[i];
    if (i < lines.length - 1) text += sep();
  }
  const finalBreak = r.chance(0.75);
  if (finalBreak) text += sep();
  const bom = r.chance(0.2);
  if (bom) text = `﻿${text}`;
  return { text, shape: `${ending}${bom ? '+bom' : ''}${fm ? '+fm' : ''}${finalBreak ? '' : '+noeol'}` };
}

/**
 * `count` synthetic files from `seed`, plus a handful of fixed shapes every run has.
 * @param {number} count
 * @param {number} seed
 * @returns {Array<{ name: string, text: string }>}
 */
export function liveSynth(count, seed) {
  const r = rng(seed);
  const out = [
    { name: 'fixed/empty', text: '' },
    { name: 'fixed/bom-only', text: '﻿' },
    { name: 'fixed/crlf-bom-tasks', text: '﻿# Tasks\r\n\r\n- [ ] one\r\n- [x] two\r\n' },
    { name: 'fixed/cr-only', text: '# T\r\rpara\r- [ ] a\r' },
    { name: 'fixed/mixed', text: '---\r\na: 1\n---\r# T\n\r\n| a | b |\r|---|---|\n| 1 | 2 |\r\n$$\rx\n$$\r\n> [!note] N\r> [[Page|p]]\n' },
    { name: 'fixed/lone-cr-in-crlf', text: 'a\r\nb\rc\r\nd' },
  ];
  for (let i = 0; i < count; i++) {
    const { text, shape } = one(r);
    out.push({ name: `synth/${i}-${shape}`, text });
  }
  return out;
}
