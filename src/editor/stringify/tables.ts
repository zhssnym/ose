// Part of the serializer (../stringify.ts). Tables, kept in the shape the file wrote them in.

import { fenceTracker } from './cleanup.ts';
import { align, lineKey } from './reconcile.ts';
import { restoreLinesIn } from './blocks.ts';

// ---------------------------------------------------------------------------
// Tables.
//
// remark rewrites every table into one canonical shape. The vault uses several (`|---|---|`,
// `| --- | --- |`, `| - | - |`, padded columns), so a page edited anywhere would have all of
// its tables reflowed. Any table whose cell content came back unchanged is put back exactly as
// it was written; a table the user actually edited no longer matches and gets the canonical
// shape, which is the right trade.

export const isTableRow = (l) => /^\s*\|/.test(l);
export const isDelimiterRow = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(l);

/**
 * Where the table inside these lines starts and ends, or null. A table is a row followed by a
 * delimiter row and then every row under it, and it does not have to be the first line of its
 * block: Hassan writes `### Head` and the table with no blank line between them, which is one
 * block in the file. Asking only about line 0 is what left twenty tables in seven `PROFILE.md`
 * files reflowed on every edit (D1).
 */
function tableSpan(lines) {
  const fence = fenceTracker();
  const inFence = lines.map((l) => fence(l));
  for (let i = 0; i + 1 < lines.length; i++) {
    if (inFence[i] || inFence[i + 1]) continue;
    if (!isTableRow(lines[i]) || !isDelimiterRow(lines[i + 1])) continue;
    let j = i + 1;
    while (j + 1 < lines.length && !inFence[j + 1] && isTableRow(lines[j + 1])) j++;
    return { start: i, end: j };
  }
  return null;
}

/**
 * One edited block that contains a table: the table is restored row by row and whatever sits
 * above or below it goes through the ordinary line pass. Null when either side has no table,
 * which is every other block.
 */
export function restoreTableIn(next, prev) {
  const b = next.split('\n');
  const a = prev.split('\n');
  const nb = tableSpan(b);
  const pb = tableSpan(a);
  if (!nb || !pb) return null;
  const seg = (l, from, to) => l.slice(from, to).join('\n');
  // The blank lines between the table and what is around it are the canonical text's: the
  // file had none, so its lines have nothing to say about them. `dropBlanks` takes them out
  // again where the block still means the same without them; where it does not (a heading made
  // a paragraph cannot touch the table under it), they are what keeps the two apart.
  const trailing = (t) => (/\n*$/.exec(t) || [''])[0];
  const leading = (t) => (/^\n*/.exec(t) || [''])[0];
  const parts: any[] = [];
  if (nb.start) {
    const head = seg(b, 0, nb.start);
    parts.push(pb.start ? restoreLinesIn(head, seg(a, 0, pb.start)).replace(/\n*$/, '') + trailing(head) : head);
  }
  parts.push(restoreRows(seg(b, nb.start, nb.end + 1), seg(a, pb.start, pb.end + 1)));
  if (nb.end + 1 < b.length) {
    const tail = seg(b, nb.end + 1, b.length);
    parts.push(pb.end + 1 < a.length ? leading(tail) + restoreLinesIn(tail, seg(a, pb.end + 1, a.length)).replace(/^\n*/, '') : tail);
  }
  return parts.join('\n');
}

/** Column alignments of a delimiter row, as one string per table: `l`, `r`, `c` or `-`. */
const alignments = (row) =>
  splitCells(row).map((c) => {
    const t = c.trim();
    return (t.startsWith(':') ? 'l' : '') + (t.endsWith(':') ? 'r' : '') || '-';
  }).join(',');

/**
 * One edited table, row by row (M1). Every row whose cells did not change keeps its own
 * padding; only the row the user was in is rewritten. The delimiter row is markup, not
 * content, so it is kept exactly as written whenever the columns and their alignments are
 * unchanged — that is the whole of it, because a cell edit changes neither.
 */
function restoreRows(next, prev) {
  const b = next.split('\n');
  const a = prev.split('\n');
  const out = new Array(b.length);
  out[0] = lineKey(b[0]) === lineKey(a[0]) ? a[0] : repad(b[0], a[0]);
  out[1] = alignments(b[1]) === alignments(a[1]) ? a[1] : b[1];
  const bk = b.slice(2).map(lineKey);
  const ak = a.slice(2).map(lineKey);
  const map = align(ak, bk, 200);
  for (let j = 0; j < bk.length; j++) {
    const mj = map[j] ?? -1;
    out[j + 2] = mj >= 0 ? a[mj + 2]
      : repad(b[j + 2], a[Math.min(j, ak.length - 1) + 2] || a[2]);
  }
  return out.join('\n');
}

/**
 * The row the user was in, in the column widths the table is written with. remark writes every
 * cell padded by one space; a row like that dropped into a table whose columns are aligned by
 * hand looks broken, and the padding is not content — it does not change what the row says.
 *
 * A cell that was empty is all padding, and a text typed into it goes where the text of every
 * other cell is: after one space, with the rest of the padding after it, so the column keeps
 * its width. Taken as left padding, the whole of it went in front of the text and the text sat
 * against the closing pipe (`|         x|` for `| x       |`).
 */
function repad(next, prev) {
  if (!prev || !isTableRow(prev)) return next;
  const nc = splitCells(next);
  const pc = splitCells(prev);
  if (nc.length !== pc.length) return next;
  const indent = (/^\s*/.exec(prev) || [''])[0];
  const cells = pc.map((old, k) => {
    // Always matches; the fallback only tells the checker so.
    const m = /^([ \t]*)[\s\S]*?([ \t]*)$/.exec(old) || ['', '', ''];
    const body = nc[k].trim();
    // An empty cell is all padding: one space on each side, as in the cells around it, and
    // none at all in a table written without any (`||`).
    const blank = !old.trim();
    const left = blank ? (old.length ? ' ' : '') : m[1] || ' ';
    const right = blank ? left : (m[2] ? ' ' : '');
    const pad = old.length - left.length - body.length;
    return left + body + (pad > 0 ? ' '.repeat(pad) : right);
  });
  return `${indent}|${cells.join('|')}|`;
}

export const splitCells = (row) =>
  row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
