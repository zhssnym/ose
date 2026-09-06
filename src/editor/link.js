// Linking one page to another.
//
// CONTRACT.md batch 5, "Link a page": the slash item `Link` and the command `page.link` both
// open `pickPage`, then insert a markdown link whose text is the target's title (its first H1,
// else the file name without `.md`) and whose href is the target path relative to the folder of
// the page being edited, with `%20` for spaces. Cancelling inserts nothing.
//
// The module knows nothing about which file is open: `index.js` binds a getter at init, so this
// file never imports the editor back (slash.js -> link.js -> index.js would be a cycle, and the
// round-trip harness would pull the whole shell in with it).

import { bridge } from '../bridge/index.js';
import { pickPage } from './deps.js';
import * as P from './paths.js';
import { TextSelection } from '@milkdown/kit/prose/state';

/** @type {() => string|null} */
let pagePath = () => null;

/** `index.js` calls this once: `bindPagePath(() => page ? page.path : null)`. */
export function bindPagePath(fn) {
  pagePath = typeof fn === 'function' ? fn : () => null;
}

/**
 * The first H1 of a markdown text, skipping YAML frontmatter and fenced code. `doc.js` only
 * reports an H1 that is the very first block; a link wants the first one wherever it is.
 */
export function firstH1(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  if (/^---[ \t]*$/.test(lines[0] || '')) {
    i = 1;
    while (i < lines.length && !/^---[ \t]*$/.test(lines[i])) i++;
    i++;
  }
  let fence = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = /^[ \t]{0,3}(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (h && h[1].trim()) return h[1].replace(/\s+/g, ' ').trim();
  }
  return '';
}

/** The title to show for a page: its first H1, else the file name without `.md`. */
export async function pageTitle(path) {
  try {
    const title = firstH1(await bridge.readText(path));
    if (title) return title;
  } catch { /* unreadable: fall back to the name */ }
  return P.stem(path);
}

/** The href for `target` as written inside the page at `from`. */
export function hrefFor(from, target) {
  return P.relativeHref(from || '', target) || P.basename(target);
}

/**
 * Replace `range` (the selection by default) with `text` carrying a link mark. The caret lands
 * after the link and the mark is dropped from the stored marks, so typing on does not extend it.
 *
 * The range is passed in because the picker is a modal: while it is open the editor is blurred,
 * and ProseMirror re-reads the DOM selection when it comes back — which is how a link asked for
 * at the end of a paragraph ended up at the top of the document.
 */
export function insertLink(view, text, href, range, lead) {
  if (!view) return false;
  const { state } = view;
  const mark = state.schema.marks.link;
  const label = String(text || href || '').trim() || href;
  try {
    const node = state.schema.text(label, mark ? [mark.create({ href })] : []);
    const nodes = lead ? [state.schema.text(lead), node] : [node];
    const size = state.doc.content.size;
    const from = Math.max(0, Math.min(range ? range.from : state.selection.from, size));
    const to = Math.max(from, Math.min(range ? range.to : state.selection.to, size));
    const tr = state.tr.replaceWith(from, to, nodes);
    const end = from + nodes.reduce((n, x) => n + x.nodeSize, 0);
    tr.setSelection(TextSelection.create(tr.doc, Math.min(end, tr.doc.content.size)));
    if (mark) tr.removeStoredMark(mark);
    tr.scrollIntoView();
    view.dispatch(tr);
    view.focus();
    return true;
  } catch (e) {
    console.error('[editor] insert link', e);
    return false;
  }
}

/**
 * Ask for a page and link to it at the caret. Resolves to the chosen path, or null when the
 * picker was cancelled (Esc), in which case the document is left exactly as it was.
 */
export async function insertPageLink(view, opts) {
  if (!view) return null;
  const { from, to } = view.state.selection;         // where the caret was before the modal
  const target = await pickPage({ title: 'Link a page…' });
  if (target === null || target === undefined || target === '') return null;
  const href = hrefFor(pagePath(), target);
  const title = await pageTitle(target);
  // `space` is the space the slash menu swallowed with the `/`: give it back in front of
  // the link, so `note /link` reads `note [Title](…)` and a cancelled pick leaves `note`.
  insertLink(view, title, href, { from, to }, opts && opts.space ? ' ' : '');
  return target;
}
