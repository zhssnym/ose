// Part of the serializer (../stringify.ts). Reconciliation: the canonical output brought back to
// the file already on disk.

import { fenceTracker } from './cleanup.ts';
import { reconcileBlocks } from './blocks.ts';
import { restoreTables } from './tables.ts';

// ---------------------------------------------------------------------------
// Reconciliation against the file on disk.
//
// remark writes one canonical shape: exactly one blank line between blocks, tables reflowed,
// list continuations indented by two, escapes wherever they might conceivably be needed.
// Hassan's files are written densely and inconsistently, and App/CLAUDE.md is explicit that a
// user edit must not reformat the rest of the file. So after serialising we walk the canonical
// output alongside the original and put back every line whose *content* did not change.
//
// This is a heuristic and it is not trusted on its own: the write guard (guard.ts) parses the
// reconciled text and only writes it if it gives back the document on screen, node for node.
// If it does not, the canonical output is tried, and then the serializer's own.

/**
 * Everything the comparison should ignore, because remark may legitimately change it without
 * changing the document: backslash escapes (including `\\text{}` written by hand), entity
 * spaces, whitespace runs, and the three interchangeable spellings of an email or url link
 * (`x@y`, `<x@y>`, `[x@y](mailto:x@y)` all parse to the same thing under GFM autolinks).
 */
export const lineKey = (l) =>
  l.replace(/\\/g, '')
    .replace(/&#x20;/g, ' ')
    .replace(/\[([^\]]+)\]\(mailto:[^)]+\)/g, '$1')
    .replace(/<(?:mailto:)?([^\s<>]+@[^\s<>]+)>/g, '$1')
    .replace(/<(https?:\/\/[^\s<>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Split into content lines plus the blank-line gap in front of each. Lines inside a fenced
 * code block all count as content, blank ones included, so code is never re-spaced.
 */
export function units(text) {
  const items: any[] = [];
  const gaps: any[] = [];
  let gap = 0;
  const fence = fenceTracker();
  for (const line of String(text).split('\n')) {
    const inFence = fence(line);
    if (!inFence && !line.trim()) { gap++; continue; }
    gaps.push(gap);
    items.push(line);
    gap = 0;
  }
  gaps.push(gap);
  return { items, gaps };
}

/**
 * Greedy alignment with bounded resynchronisation. The two sequences are nearly identical, so
 * a two-pointer walk with a lookahead window beats an O(n*m) LCS and cannot blow up on a long
 * file. Returns map[b] = index into a, or -1 for an unmatched line.
 */
export function align(a, b, window = 80) {
  const map = new Int32Array(b.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { map[j] = i; i++; j++; continue; }
    // One line replaced by one line: the pair after it lines up again. Taking that in
    // preference to a longer jump is what keeps an edited line from handing its identity to a
    // repeated line further down — two list items with the same continuation under them, and
    // the second one is put back where the first belonged.
    if (i + 1 < a.length && j + 1 < b.length && a[i + 1] === b[j + 1]) { i++; j++; continue; }
    let found = false;
    for (let d = 1; d <= window && !found; d++) {
      if (i + d < a.length && a[i + d] === b[j]) { i += d; found = true; }
      else if (j + d < b.length && a[i] === b[j + d]) { j += d; found = true; }
    }
    if (!found) { i++; j++; }
  }
  return map;
}

/**
 * @param out       canonical output of postProcess()
 * @param original  the file as it is on disk
 * @param opt.canon  parse-and-serialise, from the editor. When it is
 *        given, reconciliation is block by block (the batch-12 engine); without it the old
 *        line-only pass runs, which no caller in the app uses any more.
 * @param opt.lines line pass only: restore lines that differ only in escaping
 * @returns a candidate the caller must verify by re-parsing
 */
export function reconcile(out: string, original: string, opt: { canon?: (md: string) => string; lines?: boolean; } = {}): string {
  if (!original) return out;
  if (typeof opt.canon === 'function') return reconcileBlocks(out, original, opt.canon);
  return reconcileLines(out, original, opt);
}

function reconcileLines(out, original, opt: any = {}) {
  const restoreLines = opt.lines !== false;

  const text = restoreTables(out, original);
  const A = units(original);
  const B = units(text);
  if (!B.items.length || !A.items.length) return text;

  const map = align(A.items.map(lineKey), B.items.map(lineKey));

  let result = '';
  for (let j = 0; j < B.items.length; j++) {
    const i = map[j] ?? -1;
    // The original's spacing only describes this boundary when both sides of it survived and
    // were adjacent in the original; anywhere the user inserted something, keep remark's.
    // `map[j - 1]` is -1 for an inserted line, and -1 === i - 1 when i is 0: an insert above
    // the first line would take the first line's leading gap as its own (C11). Both sides survive.
    const keepsBoundary = i >= 0 && (j === 0 ? i === 0 : (map[j - 1] ?? -1) >= 0 && map[j - 1] === i - 1);
    const gap = (keepsBoundary ? A.gaps[i] : B.gaps[j]) ?? 0;
    result += '\n'.repeat(j === 0 ? gap : gap + 1);
    result += i >= 0 && restoreLines ? A.items[i] : B.items[j];
  }
  const last = map[B.items.length - 1];
  const tail = (last === A.items.length - 1 ? A.gaps[A.gaps.length - 1] : B.gaps[B.gaps.length - 1]) ?? 0;
  return result + '\n'.repeat(tail);
}
