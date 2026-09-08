// Mapping a source line onto the document (C7, the editor half of "open at a line").
//
// The search overlay knows file lines; ProseMirror knows positions. The body markdown the
// page was parsed from is walked alongside the canonical markdown of each top-level block
// (crepe.js blockMarkdown): the block's first content line is looked for in the original,
// forward from where the previous block was found, compared on the key stringify.js uses to
// reconcile a save (escapes, spaces and autolink spellings ignored), then once more with all
// whitespace dropped so a table the vault wrote tight still matches. Inside a block that has
// textblocks of its own (a list, a quote) the same walk refines the target to the item.
//
// A block whose first line cannot be found claims no lines: a target inside it lands on the
// block before — early, never late (CONTRACT.md batch 9, C7).

import { blockMarkdown } from './crepe.js';
import { lineKey } from './stringify.js';

const count = (s, ch) => { let n = 0; for (const c of s) if (c === ch) n++; return n; };
/** Letters and digits only, lowercased: enough to recognise a list item's line. */
const alnum = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const tight = (k) => k.replace(/\s+/g, '');

/** File line (1-based) of the first body line, from what doc.js kept around the body. */
export function bodyStartLine(doc) {
  const prefix = doc.frontmatterRaw + doc.preTitle + (doc.titleLine !== null ? doc.titleLine + doc.gap : '');
  return 1 + count(prefix, '\n');
}

/** File line (1-based) of the title, or 0 when the file has no title line. */
export function titleLineNo(doc) {
  return doc.titleLine === null ? 0 : 1 + count(doc.frontmatterRaw + doc.preTitle, '\n');
}

/** Index of the first line at or after `from` whose key is `key`, or -1. */
function findLine(keys, tightKeys, key, from) {
  if (!key) return -1;
  for (let i = from; i < keys.length; i++) if (keys[i] === key) return i;
  const t = tight(key);
  for (let i = from; i < keys.length; i++) if (tightKeys[i] === t) return i;
  return -1;
}

/**
 * Document position to put the caret at for `line` (1-based, 1 = the body's first line):
 * inside the block, or the list item / quoted paragraph, that starts on the last found line
 * at or before it. The start of the body when nothing was found.
 */
export function posForBodyLine(crepe, view, body, line) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const keys = lines.map(lineKey);
  const tightKeys = keys.map(tight);
  const target = Math.max(1, Math.floor(Number(line) || 1)) - 1;   // 0-based like `lines`
  const doc = view.state.doc;
  let cursor = 0;
  let best = 1;
  let past = false;

  doc.forEach((node, offset) => {
    if (past) return;
    let md = '';
    try { md = blockMarkdown(crepe, node); } catch { /* an unserialisable block claims nothing */ }
    const first = md.split('\n').find((l) => l.trim()) || '';
    const start = findLine(keys, tightKeys, lineKey(first), cursor);
    if (start < 0) return;
    if (start > target) { past = true; return; }
    best = offset + 1;
    cursor = start + 1;
    // Items inside: the first line of each textblock, on letters and digits only, looked
    // for from where the previous item was found. A short line is too easy to find by
    // accident; once an item lies past the target the ones after it do too; and the first
    // textblock found on a line keeps it (a table row lands in its first cell).
    let stop = false;
    let bestLine = start;
    node.descendants((child, cpos) => {
      if (stop) return false;
      if (!child.isTextblock) return true;
      const k = alnum(child.textContent.split('\n')[0]).slice(0, 24);
      if (k.length < 3) return false;
      for (let i = cursor - 1; i < lines.length; i++) {
        if (!alnum(lines[i]).includes(k)) continue;
        if (i > target) stop = true;
        else if (i > bestLine) { best = offset + 1 + cpos + 1; bestLine = i; cursor = Math.max(cursor, i + 1); }
        break;
      }
      return false;
    });
  });
  return best;
}
