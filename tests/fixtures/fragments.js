// Lines the generated documents are built from: the fragment soup of the audit's parse fuzzer
// (work/audit/roundtrip/parsefuzz.mjs). Each is one line (or a short run of lines) of markdown
// a note could hold; a document is a few of them joined with newlines, so they meet in every
// order: a table under a heading, a fence inside a quote, a footnote before an html line.

export const FRAGMENTS = [
  'para text', 'second line', '- item', '  - nested', '    - deep', '* star', '1. one', '2) two', '- [ ] task',
  '- [x] done', '> quote', '>> frame', '> - q item', '# H1', '## H2', '###### H6', 'Setext', '===', '---', '***',
  '| a | b |', '|---|---|', '| 1 | 2 |', '|:-|-:|', '```', '```js', '~~~', '    code', '$$', '$x$', '$$ y $$',
  '\\begin{aligned}', '<div>', '</div>', '<br>', '<!-- c -->', '[ref]: http://x.y', '[x][ref]', '![img](a.png)',
  '![a|200](b.png "t")', 'Text[^1]', '[^1]: note', '[^n]:', 'http://auto.link', '<a@b.c>', '_em_', '**strong**',
  '~~del~~', '`code`', '\\', 'line  ', 'end\\', '', '', '', '', '&nbsp;', '&#x20; x', '\t- tab', '- ', '1.', '+',
  '[[wiki]]', '[[wiki|alias]]', '- a\n\n  para in item', '| x |', '- | t |', '> ```', '> code', ':::', '[!note]',
  '<details>', '<summary>s</summary>', '</details>', '---\ntitle: x\n---', '* * *', '- - -', '1. a\n   - b',
  '<https://x.y>', '![](x.png)', 'x<br>y', 'snake\\_case and 2\\*3', '\\[not a link\\](x)', 'a_b_c', 'price 5 $ puis 10 $',
];

/**
 * Whole blocks, the way notes are written, for documents whose blocks are separated by a blank
 * line: every fence and display-maths block is closed, every list is one a person would type.
 * The degenerate openers of the soup above (a lone `1.`, `+` or `- `, an unclosed fence) are
 * left out on purpose: they are covered by the safety properties, and what a save does to their
 * spelling is a finding of its own, not what the fidelity properties measure.
 */
export const BLOCK_FRAGMENTS = [
  'para text', 'Second paragraph with _em_, **strong**, `code` and ~~del~~.', 'A line  \nwith a hard break',
  'snake\\_case and 2\\*3 and \\[not a link\\](x)', 'price 5 $ puis 10 $, and $x^2$ inline', 'a_b_c and x<br>y',
  '- item\n- item two\n  - nested', '* star\n* star two', '1. one\n2. two\n3. three', '2) two\n3) three',
  '- [ ] task\n- [x] done', '- a\n\n  para in item', '1. a\n   - b',
  '> quote\n> more', '> [!note] Title\n> - a\n> - b', '> ```py\n> x = "\\[a\\]"\n> ```',
  '# H1', '## H2 with `code`', '###### H6', 'Setext\n======', 'Sub\n---',
  '---', '***', '* * *',
  '| a | b |\n|---|---|\n| 1 | 2 |', '| name | value |\n|:-----|------:|\n| alpha | 1 |',
  '```\ncode\n```', '```js\nconst a = "\\[x\\]";\n```', '~~~\ntilde\n~~~', '    indented code\n    more',
  '$$\nx^2\n$$', '$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$',
  '<div>\nhtml block\n</div>', '<!-- c -->', '<details>\n<summary>s</summary>\nbody\n</details>',
  '[ref]: http://x.y', 'See [x][ref] and [ref].', '![img](a.png)', '![a|200](b.png "t")',
  'Text[^1] with a note.', '[^1]: note', 'Go <https://x.y> or http://auto.link.', 'Mail <a@b.c>.',
  '[[wiki]] and [[wiki|alias]]', '&nbsp;&nbsp;two nbsp', '---\ntitle: x\n---',
];

