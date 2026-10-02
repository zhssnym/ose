// The markdown parser the core reads links with (./links.ts, H6): the same
// mdast-util-from-markdown, GFM and maths that remark-parse runs under Milkdown, so a link is a
// link here exactly when it is one in the editor. It is its own module so that the core
// loads it with a dynamic import the first time a link is looked for (a rename, the backlinks
// list), and a boot that never looks does not pay for the parser.

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import { visit } from 'unist-util-visit';

const OPTIONS = {
  extensions: [gfm(), math()],
  mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
};

/**
 * The mdast tree of `text`, every node with its `position` (offsets into `text`).
 */
export function parse(text: string) {
  return fromMarkdown(String(text ?? ''), OPTIONS);
}

export { visit };
