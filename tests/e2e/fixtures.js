// The synthetic pages the scenarios type into, written by prepare.mjs into `<vault>/e2e/` (and,
// for the files outside the vault, into `<base>/outside/`). Synthetic on purpose: the repository
// is public and no real note is ever copied into it. One file per scenario, so a scenario that
// fails leaves nothing behind for the next one. LF endings, `-` bullets, one blank line between
// blocks: Hassan's conventions, except where a scenario is about another shape (CRLF, a BOM).

/** The body every page starts with: a heading and paragraphs a caret can land in. */
const page = (title, lines) => `# ${title}\n\n${lines.join('\n\n')}\n`;

/** Nine paragraphs, far enough apart that an edit on the first and one on the last never overlap. */
const long = (title) => page(title, [
  'Line one of the page.', 'Line two stays.', 'Line three stays.', 'Line four stays.',
  'Line five stays.', 'Line six stays.', 'Line seven stays.', 'Line eight stays.', 'Line nine at the end.',
]);

/** Everything Live draws differently off the caret, in one file (live.spec.js L1). */
const WALK = [
  '---',
  'title: Walk',
  'tags: [a, b]',
  '---',
  '# Live walk',
  '',
  'Some _emphasis_, **strong**, `code`, a [link](https://example.com) and [[other|a wikilink]].',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '| 3 | 4 |',
  '',
  '$$',
  'x^2 + y^2',
  '$$',
  '',
  '> [!note] A callout',
  '> with a body',
  '',
  '- [ ] open task',
  '- [x] done task',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  'The last line.',
  '',
].join('\n');

export const FILES = {
  'e2e/close.md': page('Close', ['The first paragraph.']),
  'e2e/fail.md': page('Fail', ['The first paragraph.']),
  'e2e/conflict.md': page('Conflict', ['The shared line.']),
  'e2e/other.md': page('Other', ['Somewhere else to go.']),
  'e2e/rename.md': page('Rename', ['The first paragraph.']),
  'e2e/reload.md': page('Reload', ['The first paragraph.']),
  'e2e/undo-a.md': page('Undo A', ['The first paragraph.']),
  'e2e/undo-b.md': page('Undo B', ['The other page.']),
  'e2e/session-a.md': page('Session A', ['The first paragraph.']),
  'e2e/session-b.md': page('Session B', ['The second page.']),
  'e2e/merge.md': long('Merge'),
  'e2e/merge-undo.md': long('Merge undo'),
  'e2e/discard.md': page('Discard', ['The first paragraph.']),
  'e2e/race.md': page('Race', ['The first paragraph.']),
  'e2e/race-fail.md': page('Race fail', ['The first paragraph.']),
  'e2e/folder/inside.md': page('Inside', ['A page in a folder.']),

  // Live (live.spec.js), one file per scenario.
  'e2e/live-walk.md': WALK,
  'e2e/live-heading.md': page('Live heading', ['A paragraph under it.']),
  'e2e/live-task.md': page('Live task', ['- [ ] the first task\n- [ ] the second task']),
  'e2e/live-crlf.md': '﻿# Live CRLF\r\n\r\nThe first line.\r\n\r\n- a bullet\r\n',
  'e2e/live-fail.md': page('Live fail', ['The first paragraph.']),
  'e2e/live-switch.md': page('Live switch', ['Rich line.', 'Live line.', 'Source line.']),
  'e2e/live-tab-a.md': page('Live tab A', ['The first paragraph.']),
  'e2e/live-tab-b.md': page('Live tab B', ['The other page.']),
  'e2e/live-merge.md': long('Live merge'),
  'e2e/live-paste.md': page('Live paste', ['Paste below.', 'The end.']),
  'e2e/live-table.md': page('Live table', ['Before the table.', '| a | b |\n| --- | --- |\n| 1 | 2 |', 'After the table.']),
  'e2e/live-default.md': page('Live default', ['Never opened before.']),
  'e2e/live-remembered.md': page('Live remembered', ['Left in source.']),
  'e2e/live-read.md': page('Live read', ['A [link to other](other.md) and more.', 'The typed line.']),
};

/** Files outside the vault (outside.spec.js), under `<base>/outside/`. */
export const OUTSIDE_FILES = {
  'notes/outside.md': page('Outside', ['The outside line.']),
  'notes/change.md': long('Outside change'),
  'notes/copy-me.md': '﻿# Copy me\r\n\r\nCafé, naïve, 日本語.\r\n',
};
