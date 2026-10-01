// The synthetic pages the scenarios type into, written into the test vault's `e2e/` folder by
// helpers.js boot. Synthetic on purpose: the repository is public and no real note is ever
// copied into it. One file per scenario, so a scenario is about its own file only. LF endings, `-` bullets, one blank line between
// blocks: Hassan's conventions, except where a scenario is about another shape (CRLF, a BOM).

/** The body every page starts with: a heading and paragraphs a caret can land in. */
const page = (title, lines) => `# ${title}\n\n${lines.join('\n\n')}\n`;

/** Nine paragraphs, far enough apart that an edit on the first and one on the last never overlap. */
const long = (title) => page(title, [
  'Line one of the page.', 'Line two stays.', 'Line three stays.', 'Line four stays.',
  'Line five stays.', 'Line six stays.', 'Line seven stays.', 'Line eight stays.', 'Line nine at the end.',
]);

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
};
