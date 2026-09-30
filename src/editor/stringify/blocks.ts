// Part of the serializer (../stringify.ts). The block engine: the file and the output matched
// block by block, so a block nobody touched keeps its bytes.

import { lineRuns } from '../math-rule.ts';
import { CONTAINER_PREFIX, fenceTracker, verbatimRuns } from './cleanup.ts';
import { align, lineKey, units } from './reconcile.ts';
import { applyStyle, detectStyle, keepSetext } from './markers.ts';
import { restoreTableIn } from './tables.ts';

// ---------------------------------------------------------------------------
// The block engine (batch 12).
//
// A line is the wrong unit. remark does not rewrite lines, it rewrites blocks: a paragraph
// followed by `---` comes back as `## text`, a four-space nested list comes back indented by
// two, a table comes back reflowed. Compared line by line none of those match, so the old pass
// gave up and the whole file was rewritten because of one construct it could not follow (M5).
//
// So the unit is the block. `blocks()` cuts both texts at blank lines — which is where every
// top-level markdown block ends, fenced code excepted — and each original block is keyed by
// what the editor would write for it *on its own*. A block whose key equals the canonical
// block is the same block, however differently it is spelled: it keeps its original bytes,
// exactly. A block that does not match is the one the user edited: it is written from the
// canonical text with the line pass applied inside it, and verified on its own. Nothing that
// happens to one block can reach another.

// A `---` on a line of its own is two different things. After a paragraph line it is the
// underline of a setext heading and belongs to it; anywhere else it is a thematic break, which
// is a block of its own even with no blank line around it. Both have to be cut correctly or
// the two block lists stop lining up.
const BREAK_LINE = /^\s{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const OPENS_BLOCK = /^\s{0,3}(?:#{1,6}[ \t]|>|[-*+][ \t]|\d+[.)][ \t]|\||`{3,}|~{3,})/;
const isParagraphLine = (l) => !!l && !!l.trim() && !BREAK_LINE.test(l) && !OPENS_BLOCK.test(l);

/** How many columns of indent a line has, a tab reaching the next multiple of four. */
function indentCols(line) {
  let c = 0;
  for (const ch of String(line)) {
    if (ch === ' ') c++;
    else if (ch === '\t') c += 4 - (c % 4);
    else break;
  }
  return c;
}

const LIST_OR_NOTE = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|^\[\^[^\]]+\]:/;

/**
 * Is a list item or a footnote still open after this block, so that an indented block under a
 * blank line is its content and not code? Asked of the lines at the left margin only: a list
 * marker opens one, any other block start (a heading, a quote, a fence, a rule, a table, html)
 * ends it, and a paragraph line is a lazy continuation and changes nothing. In doubt it answers
 * yes, which only ever means an indented code block is cut at its blank lines, as it always was.
 */
function leavesContainer(block, open) {
  if (indentCols(block.lines[0]) >= 4) return open;
  const fence = fenceTracker();
  for (const line of block.lines) {
    const inFence = fence(line);
    if (indentCols(line) >= 4) continue;
    const bare = line.replace(/^[ \t]+/, '');
    if (BREAK_LINE.test(line)) open = false;
    else if (LIST_OR_NOTE.test(bare)) open = true;
    else if (inFence || OPENS_BLOCK.test(line) || /^\s{0,3}</.test(line)) open = false;
  }
  return open;
}

/**
 * Top-level blocks: maximal runs of non-blank lines, fenced code kept whole, and an indented
 * code block kept whole too. Its blank lines are inside it: `    a\n\n    b` is one code block,
 * and cut in two at the blank line neither half was what the editor writes for it (a fence),
 * so a save that never touched the block wrote it anew.
 */
export function blocks(text) {
  const lines = String(text).split('\n');
  const fence = fenceTracker();
  const list: any[] = [];
  const gaps: any[] = [];
  const gapLines: any[] = [];      // the blank lines themselves, spaces and all (L1)
  let gap = 0;
  let blank: string[] = [];
  let cur: { start: number; end: number; lines: string[]; code: boolean; } | null = null;
  let container = false;    // a list item or a footnote is still open above
  const close = () => { if (cur) { container = leavesContainer(cur, container); list.push(cur); cur = null; } };
  /** The next line with text in it after `i` is indented as code. */
  const codeGoesOn = (i) => {
    let k = i + 1;
    while (k < lines.length && !lines[k]?.trim()) k++;
    return k < lines.length && indentCols(lines[k]) >= 4;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const inFence = fence(line);
    if (!inFence && !line.trim()) {
      if (cur && cur.code && codeGoesOn(i)) { cur.lines.push(line); cur.end = i; continue; }
      close(); gap++; blank.push(line); continue;
    }
    const rule = !inFence && BREAK_LINE.test(line);
    if (rule && !isParagraphLine(lines[i - 1])) close();   // a thematic break, not an underline
    if (!cur) {
      cur = { start: i, end: i, lines: [] as any[], code: !inFence && !container && indentCols(line) >= 4 };
      gaps.push(gap); gapLines.push(blank); gap = 0; blank = [];
    }
    if (cur.code && (inFence || indentCols(line) < 4)) cur.code = false;
    cur.lines.push(line);
    cur.end = i;
    if (rule) close();                                     // and nothing follows it in its block
  }
  close();
  gaps.push(gap);
  gapLines.push(blank);
  for (const b of list) b.text = b.lines.join('\n');
  return { list, gaps, gapLines };
}

/**
 * A run of blank lines as the file wrote it: a line of spaces the file has is not rewritten as
 * an empty one where nothing around it changed (L1). `first` is the run above the first block,
 * `last` the one after the last block, which the final newline ends.
 */
function spellGap(lines, first, last) {
  if (last) return lines.length ? `\n${lines.join('\n')}` : '';
  return (first ? '' : '\n') + lines.map((l) => `${l}\n`).join('');
}

const ORDERED_ITEM = /^[ \t]*\d{1,9}[.)][ \t]/m;
const ORDERED_ITEM_LINE = /^[ \t]*\d{1,9}[.)](?:[ \t]|$)/;
/** Every ordered-list number set to 1. */
const renumber = (text) => String(text).replace(/^([ \t]*)\d{1,9}([.)])/gm, (_m, ind, d) => `${ind}1${d}`);
/** The number of the first ordered item in a text, or null. */
const firstNumber = (text) => {
  const m = /^[ \t]*(\d{1,9})[.)]/m.exec(String(text));
  return m ? Number(m[1]) : null;
};

/** Does a fence (or a display formula) opened in this text run past its end? */
function openAtEnd(text) {
  const fence = fenceTracker();
  for (const line of String(text).split('\n')) fence(line);
  return fence('x');
}

// How far apart two block sequences may drift before the walk gives up and pairs by position.
// Blocks are coarse: a dozen is a whole screen of prose.
const BLOCK_WINDOW = 12;
// How many blocks of each list the walk looks over to find where they line up again.
const RESYNC_SPAN = 2 * BLOCK_WINDOW;

// How many canonical blocks one original block may turn into. Hassan writes densely — a
// paragraph and the list under it with no blank line between them is one block in the file and
// two after remark, which puts a blank line between every pair of blocks.
const GROUP_MAX = 8;

/** Runs of blank lines removed: what two texts that differ only in looseness have in common. */
const squeeze = (s) => s.replace(/\n{2,}/g, '\n');

/**
 * Walk the two block lists together. For each canonical block j the walk records
 *   from[j]  the original block it corresponds to, or -1 when there is none,
 *   span[j]  how many further canonical blocks that same original block accounts for,
 *   same[j]  whether it is the *same block* — unchanged, and so restorable byte for byte.
 *
 * Two blocks are the same when they are the same bytes, or when the editor writes the original
 * as the canonical one. That second test costs a parse, so it is only asked when the first
 * fails, and the answer is remembered: most blocks of most saves come back byte for byte and
 * cost nothing at all. Where it fails, the walk still advances both sides by one block, which
 * is the pairing: everything around the block the user edited is anchored, so the one in the
 * middle can only be the one in the middle.
 */
function matchBlocks(A, B, canon, bLines, tailsAgree = true) {
  const from = new Int32Array(B.length).fill(-1);
  const span = new Int32Array(B.length);
  const unchanged = new Uint8Array(B.length);
  const swapped = new Uint8Array(B.length);
  const keys = new Array(A.length);
  const key = (i) => (keys[i] === undefined ? (keys[i] = canon(A[i].text)) : keys[i]);
  /** How many canonical blocks this original block turns into. */
  const width = (i) => Math.max(1, blocks(key(i)).list.length);

  /** -1 when they are not the same block, else how many extra canonical blocks it swallows. */
  const sameText = (i, j) => {
    if (A[i].text === B[j].text) return 0;
    const k0 = key(i);
    if (k0 === B[j].text) return 0;
    // Looseness is a property of the whole list, not of the four items that happen to sit in
    // one block: `- a\n- b` on its own is a tight list, and the same two items in a list that
    // has a blank line further down come back with a blank line between them. So the run is
    // also compared with its blank lines taken out, which is the only thing that can differ.
    // Not two blank lines, though: that is an empty paragraph, space the user put between the
    // blocks (space.ts), and a heading and the paragraph under it with space added between
    // them are not the heading and paragraph the file wrote touching.
    const s0 = squeeze(k0);
    for (let k = 1; k <= GROUP_MAX && j + k < B.length; k++) {
      const text = bLines.slice(B[j].start, B[j + k].end + 1).join('\n');
      if (text.length > k0.length + 2 * k) break;
      if (text === k0 || (squeeze(text) === s0 && !/\n[ \t]*\n[ \t]*\n/.test(text))) return k;
    }
    // The numbers of an ordered list after its first item say nothing: `2) two` under `3) three`
    // is the fourth item of the list, and the editor writes it `4.`. So a block of the file that
    // carries on a list above it is the same block whatever its numbers, and a block that starts
    // one is the same if it starts at the same number. The guard reads the result back.
    if (ORDERED_ITEM.test(k0) && (firstNumber(k0) === firstNumber(B[j].text) || continuesList(j))) {
      const n0 = renumber(k0);
      for (let k = 0; k <= GROUP_MAX && j + k < B.length; k++) {
        const text = bLines.slice(B[j].start, B[j + k].end + 1).join('\n');
        if (text.length > k0.length + 12 * (k + 1)) break;
        const r = renumber(text);
        if (r === n0 || (squeeze(r) === squeeze(n0) && !/\n[ \t]*\n[ \t]*\n/.test(text))) return k;
      }
    }
    // A bullet list written with `*` where the file has `-`: mdast gives a list the other marker
    // when a list of the same kind comes right before it, with nothing or only space between,
    // because blank lines alone do not end a list. The block is the file's all the same; which
    // of the two lists gives way is decided in `reconcileBlocks` (`swapped`).
    if (TOP_BULLET.test(k0) && TOP_BULLET.test(B[j].text) && bulletOf(B[j].text) !== bulletOf(k0)) {
      const b0 = debullet(k0);
      for (let k = 0; k <= GROUP_MAX && j + k < B.length; k++) {
        const text = bLines.slice(B[j].start, B[j + k].end + 1).join('\n');
        if (text.length > k0.length + 2 * k) break;
        const r = debullet(text);
        if (r === b0 || (squeeze(r) === squeeze(b0) && !/\n[ \t]*\n[ \t]*\n/.test(text))) { viaBullet.add(`${i},${j}`); return k; }
      }
    }
    return -1;
  };
  const viaBullet = new Set<any>();
  /** The canonical block before `j` holds an item of an ordered list at the indent `j` starts at. */
  const continuesList = (j) => {
    if (j < 1) return false;
    const ind = (/^[ \t]*/.exec(B[j].lines[0] || '') || [''])[0];
    return B[j - 1].lines.some((l) => ORDERED_ITEM_LINE.test(l) && (/^[ \t]*/.exec(l) || [''])[0] === ind);
  };
  const same = (i, j) => {
    const k = sameText(i, j);
    // A fence the file never closes runs to the end of the file. Its bytes can only go back
    // where they still end the file, with nothing after them that the fence would swallow;
    // anywhere else the edited-block path closes it (L1).
    if (k >= 0 && openAtEnd(A[i].text) && !(i === A.length - 1 && j + k === B.length - 1 && tailsAgree)) return -1;
    return k;
  };

  // Resynchronising needs two blocks in a row, not one. A file with `---` between its sections
  // has a dozen blocks that are all the same block, and one of them matching further down is no
  // evidence at all — following it would orphan everything in between.
  const confirmed = (ai, bj) => {
    // `claim` asks about the canonical block just past the edited run, which is past the end
    // when the edit is the last thing on the page: no block there confirms anything.
    if (ai >= A.length || bj >= B.length) return -1;
    const k = same(ai, bj);
    if (k < 0) return -1;
    if (ai + 1 >= A.length) return k;          // the last block of the file: nothing to confirm
    // There is another original block but no canonical block left to hold it, or the next
    // pair differs: following this match could orphan the rest of the file. The last block of a
    // page is very often the same one line as an earlier block (`- None this month` twice under
    // two headings), which is exactly the evidence `confirmed` exists to refuse.
    if (bj + k + 1 < B.length && same(ai + 1, bj + k + 1) >= 0) return k;
    // Unless the match is the only one either way: no other block of the file is this block,
    // and no other block being written is either. Then it is itself whatever happened around it:
    // a setext heading keeps its underline when the block under it is edited or deleted.
    return unique(ai, bj) ? k : -1;
  };
  // Counted once, by bytes, so asking costs nothing: canonicalising every block of a long file
  // to ask whether any of them is the same block would make a save as slow as the file is long.
  const countBy = (list) => {
    const m = new Map();
    for (const b of list) m.set(b.text, (m.get(b.text) || 0) + 1);
    return m;
  };
  const aCount = countBy(A);
  const bCount = countBy(B);
  const unique = (ai, bj) => aCount.get(A[ai].text) === 1 && bCount.get(B[bj].text) === 1
    && (key(ai) === B[bj].text || !bCount.has(key(ai)));

  /**
   * How many canonical blocks the block the user edited accounts for. Its own canonical width is
   * the first guess and usually right — a paragraph and the list under it are one block in the
   * file and two after remark. But an edit can change that width: a list that is loose because
   * of a blank line further down comes back as one canonical block per item, and taking one
   * block for it leaves the other items unclaimed, each written out with the blank line remark
   * put in front of it (D3). The next original block, which did not change, says where this one
   * ends, and it has to be confirmed by the one after it like every other resynchronisation.
   * `bound` is where the walk already knows the lists line up again: nothing past it is this
   * block's, however much a canonical block there looks like its own.
   */
  const claim = (i, j, bound = Infinity) => {
    const w0 = Math.min(Math.max(1, width(i)), B.length - j, bound);
    const limit = Math.min(GROUP_MAX, B.length - j, bound);
    if (i + 1 < A.length) {
      if (confirmed(i + 1, j + w0) >= 0) return w0;
      for (let w = 1; w <= limit; w++) if (w !== w0 && confirmed(i + 1, j + w) >= 0) return w;
    }
    // Nothing after it says where it ends (it is the last block, or what followed it is gone).
    // It still ends after the last of its own canonical blocks: a heading and the table under
    // it, with a paragraph typed between them, are three canonical blocks and all of them are
    // this block's, or the table is written as if it were new.
    // The edit may be in one of those blocks — the heading made a paragraph and split — and then
    // it is not there to be found; the rest are, in order, and the last of them says where the
    // block ends.
    const own = blocks(key(i)).list.map((b) => b.text);
    let at = 0;
    let end = 0;
    for (let o = 0; o < own.length; o++) {
      let w = at;
      while (w < limit && B[j + w].text !== own[o]) w++;
      if (w >= limit) { end = 0; continue; }
      at = w + 1;
      end = at;
    }
    return end > w0 ? end : w0;
  };

  /** `same`, asked once per pair: the search below asks the same pairs from many places. */
  const sameMemo = new Map();
  const sameAt = (a, b) => {
    const at = a * (B.length + 1) + b;
    let k = sameMemo.get(at);
    if (k === undefined) { k = same(a, b); sameMemo.set(at, k); }
    return k;
  };
  /**
   * Where the two lists line up again after (i, j), which do not: the first pair of the longest
   * common run of same blocks over the next RESYNC_SPAN blocks of each, found the way a diff
   * finds it. It can be past deleted blocks, past inserted ones, or past both at once.
   *
   * Taking simply the nearest pair that matches is what let a copy of a block further down take
   * a block's place. A page with `para text` four times, a paragraph typed at the top and the
   * next one quoted: the nearest `para text` two blocks on lines up two blocks and leaves the
   * indented code block under them with nothing to match, and it was written as new. And a pair
   * the file happens to repeat (two identical code blocks, a heading edited between them) is
   * only the right one when what follows it lines up too, which is what the longest run says.
   * Of equal alignments the one that drops original blocks first, as the walk always did.
   */
  const resync = (i, j) => {
    const na = Math.min(A.length - i, RESYNC_SPAN);
    const nb = Math.min(B.length - j, RESYNC_SPAN);
    const L = Array.from({ length: na + 1 }, () => new Int32Array(nb + 1));
    /** A cell of the table; every index the walk reads is inside it. */
    const at = (a, b) => L[a]?.[b] ?? 0;
    const after = (a, b, k) => (b + k + 1 <= nb ? at(a + 1, b + k + 1) : 0);
    for (let a = na - 1; a >= 0; a--) {
      const row = (L[a] as Int32Array);
      for (let b = nb - 1; b >= 0; b--) {
        let v = Math.max(at(a + 1, b), at(a, b + 1));
        const k = sameAt(i + a, j + b);
        if (k >= 0) v = Math.max(v, 1 + after(a, b, k));
        row[b] = v;
      }
    }
    if (!at(0, 0)) return null;
    let a = 0;
    let b = 0;
    while (a < na && b < nb) {
      const k = sameAt(i + a, j + b);
      if (k >= 0 && (a || b) && 1 + after(a, b, k) === at(a, b)) return { di: a, dj: b };
      if (at(a + 1, b) >= at(a, b + 1)) a++;
      else b++;
    }
    return null;
  };
  /**
   * Blocks were edited AND blocks inserted or deleted around them: `di` original blocks became
   * `dj` canonical ones. The edit is the first pair of them that shares a line, container
   * markers aside (a paragraph quoted is still its line); the original blocks before it were
   * deleted and the canonical ones before it typed above it. Nothing shared leaves it at the
   * first of each, which is where the edited block was always taken to start.
   */
  const startOfEdit = (i, j, di, dj) => {
    const bare = (l) => lineKey(String(l).replace(CONTAINER_PREFIX, ''));
    for (let a = i; a < i + di; a++) {
      const own = new Set(A[a].lines.map(bare).filter(Boolean));
      // Only as many canonical blocks can have been typed above it as are left over once it has
      // its own: a heading edited above the table glued under it is two canonical blocks, and
      // the table sharing its rows does not make the heading new.
      const room = Math.max(0, dj - width(a));
      for (let s = 0; s <= room && s < dj; s++) if (B[j + s].lines.some((l) => own.has(bare(l)))) return { a, b: j + s };
    }
    return { a: i, b: j };
  };

  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    let k = same(i, j);
    // One block replaced by one block: the pair after it lines up again, and this pair is the
    // edit. Taking that before a longer jump is what keeps a file of repeated blocks (the same
    // paragraph three times, `---` between sections) from pairing the edited block with a copy
    // of itself further down and orphaning everything in between. `align` does the same by line.
    const replaced = k < 0 && i + 1 < A.length && j + 1 < B.length && same(i + 1, j + 1) >= 0
      && (i + 2 >= A.length || j + 2 >= B.length || same(i + 2, j + 2) >= 0);
    // Otherwise the walk jumps to where the two line up again: past deleted blocks, past
    // inserted ones, or past an edit with either around it, in which case the edited block is
    // found in between and `claim` says how many canonical blocks it accounts for.
    // The edited block then ends where the lists line up again, whatever it looks like after.
    const at = k < 0 && !replaced ? resync(i, j) : null;
    let bound = Infinity;
    if (at && (at.di === 0 || at.dj === 0)) { i += at.di; j += at.dj; k = same(i, j); }
    else if (at) {
      const end = j + at.dj;
      ({ a: i, b: j } = startOfEdit(i, j, at.di, at.dj));
      bound = end - j;
    }
    // The block the user edited still accounts for every canonical block its original turns
    // into: a paragraph and the list under it, written with no blank line between them, are
    // one block in the file and two after remark, and editing the paragraph must not put a
    // blank line in. So it claims that whole run and is reconciled against it as one piece.
    const w = k >= 0 ? k + 1 : claim(i, j, bound);
    from[j] = i;
    span[j] = w - 1;
    if (k >= 0) {
      unchanged[j] = 1;
      if (viaBullet.has(`${i},${j}`)) swapped[j] = 1;
      for (let x = 1; x < w; x++) from[j + x] = i;
    }
    i++;
    j += w;
  }
  return { from, span, unchanged, swapped };
}

/** A bullet list item at the start of a text, at the top level. */
const TOP_BULLET = /^[-*+][ \t]/;
const bulletOf = (text) => String(text)[0];
/** Every bullet marker of a text as `-`. */
const debullet = (text) => String(text).replace(/^([ \t]*)[-*+]([ \t])/gm, '$1-$2');

/**
 * The top-level bullets of a list block, `marker` everywhere, keeping the rest of each line.
 * Only lines indented like the first one: a nested list keeps its own markers.
 */
function rebullet(text, marker) {
  const ind = (/^[ \t]*/.exec(text) || [''])[0];
  return text.split('\n').map((l) => (l.startsWith(ind) && /^[-*+][ \t]/.test(l.slice(ind.length))
    ? ind + marker + l.slice(ind.length + 1) : l)).join('\n');
}

export function reconcileBlocks(out, original, rawCanon) {
  // A serialisation always ends in a newline and a block never does, so every comparison in
  // here goes through this: what the editor writes for a block, as a block.
  const canon = (text) => rawCanon(text).replace(/^\n+|\n+$/g, '');
  const A = blocks(original);
  const B = blocks(out);
  if (!A.list.length || !B.list.length) return out;

  const bLines = out.split('\n');
  const tailsAgree = keepsGap(true, A.gaps[A.gaps.length - 1], B.gaps[B.gaps.length - 1], false);
  const { from, span, unchanged, swapped } = matchBlocks(A.list, B.list, canon, bLines, tailsAgree);
  const style = detectStyle(original);

  let result = '';
  let prev = -1;      // the original block the last piece of output came from
  let first = true;
  let last: { at: number; text: string; restored: boolean; next: string; } | null = null;    // the last piece written: { at, text, restored }
  for (let j = 0; j < B.list.length; j += (span[j] ?? 0) + 1) {
    const p = from[j] ?? -1;
    // The original's blank lines describe this boundary only when both sides of it survived
    // and were adjacent in the original; anywhere the user inserted something, keep remark's.
    // `prev` is -1 after an inserted block, and -1 === p - 1 when p is 0: a paragraph typed
    // above the first one took block 0's leading gap of none, fused with it, failed the check and
    // had the whole file rewritten in remark's house style (C11). Both sides have to be the file's.
    const keepsBoundary = p >= 0 && (first ? p === 0 : prev >= 0 && prev === p - 1);
    if (keepsGap(keepsBoundary, A.gaps[p], B.gaps[j], first)) result += spellGap(A.gapLines[p], first, false);
    else result += '\n'.repeat(first ? (B.gaps[j] ?? 0) : (B.gaps[j] ?? 0) + 1);
    const next = bLines.slice(B.list[j].start, B.list[j + (span[j] ?? 0)].end + 1).join('\n');
    let restored = p >= 0 && unchanged[j] === 1;
    if (restored && swapped[j]) {
      // This list is the file's own, and mdast gave it the other marker only to keep it apart
      // from the list written just before it. When that one is the list the user was editing,
      // it is the one that gives way: it takes the other marker and this one keeps its bytes.
      // When it is not, this block is written the way the serializer wrote it.
      const mine = bulletOf(A.list[p].text);
      const clash = !!last && TOP_BULLET.test(last.text) && bulletOf(last.text) === mine;
      if (clash && last && !last.restored) {
        const other = mine === '-' ? '*' : '-';
        const moved = rebullet(last.text, other);
        result = result.slice(0, last.at) + moved + result.slice(last.at + last.text.length);
        last.text = moved;
      } else if (clash) restored = false;
    }
    const at = result.length;
    // What the canonical text has right before this block, for a block that only means what it
    // means under the one before it: a paragraph that carries on a list item above a blank line.
    // Back to the block that starts the construct: the indented blocks before this one are the
    // rest of the same list, and the list starts at the first one that is not indented.
    let c = j - 1;
    while (c > 0 && /^[ \t]/.test(B.list[c].lines[0] || '')) c--;
    const context = j > 0 ? `${bLines.slice(B.list[c].start, B.list[j].start).join('\n')}\n` : '';
    let text = restored ? A.list[p].text : editedBlock(next, p >= 0 ? A.list[p].text : null, canon, style, context);
    // The other half of `swapped`. The canonical text keeps this list apart from the list just
    // written by giving the two different markers; if they are written with the same one they
    // are one list when the file is read again. That happens when the list before gave way to
    // the one before it and so took this one's marker, or when both are the file's. Then this
    // one gives way too, and takes the other marker.
    if (last && TOP_BULLET.test(text) && TOP_BULLET.test(last.text) && bulletOf(text) === bulletOf(last.text)
      && TOP_BULLET.test(next) && TOP_BULLET.test(last.next) && bulletOf(next) !== bulletOf(last.next)) {
      text = rebullet(text, bulletOf(last.text) === '-' ? '*' : '-');
      restored = false;
    }
    result += text;
    last = { at, text, restored, next };
    prev = p;
    first = false;
  }
  const aTail = A.gaps[A.gaps.length - 1];
  const bTail = B.gaps[B.gaps.length - 1];
  return result + (keepsGap(true, aTail, bTail, false)
    ? spellGap(A.gapLines[A.gapLines.length - 1], false, true)
    : '\n'.repeat(bTail ?? 0));
}

/**
 * How many empty paragraphs a run of blank lines holds (space.ts): the first one is the
 * separator markdown needs and the rest is space. At the top of the file there is nothing to
 * separate, so every one of them is space.
 */
const spaceIn = (gap, first) => Math.max(0, first ? gap : gap - 1);

/**
 * Does this boundary keep the file's own blank lines?
 *
 * Two things live in the same run of newlines. How the boundary is SPELLED is the file's: two
 * blocks the file wrote with no blank line between them — a heading and its table, a `---` and
 * the paragraph under it — stay touching, although remark would put a line in. How much SPACE
 * is in it is the document's: an empty paragraph the user added or deleted is content and has
 * to be written. So the file's bytes are kept exactly while the two agree on the space, and the
 * document wins the moment they do not.
 */
const keepsGap = (keeps, a, b, first) =>
  keeps && a !== undefined && spaceIn(a, first) === spaceIn(b, first);

/**
 * The one block the user changed, written from the canonical text but keeping everything of
 * the original that still says the same thing: the untouched rows of a table, the untouched
 * lines of a list, the underline of a setext heading, the spelling of a link, and never a
 * backslash the file did not have. Verified on its own, so a block that cannot be put back
 * costs nothing but itself.
 */
function editedBlock(next, prev, canon, style, context = '') {
  // The style pass goes first, on the canonical text alone: after it the block is spelled the
  // way the file is, and the lines the user did not touch can be matched and put back on top.
  let candidate = applyStyle(next, style);
  if (prev) {
    // A table is restored row by row wherever it sits in the block — a heading and the table
    // under it with no blank line between them is one block, and the table inside it is still
    // a table (D1). Everything around it goes through the line pass.
    const table = restoreTableIn(candidate, prev);
    candidate = table !== null ? table : restoreLinesIn(candidate, prev);
    candidate = keepSetext(candidate, prev);
    // The original was one block, so it had no blank lines in it: any that remain are ones
    // remark put between the several canonical blocks it turns into. The file did not have
    // them and editing a line of it is no reason to gain them. A bare `>` is the same thing
    // one level in: the blank line between two blocks of a blockquote, which is how a callout
    // with a list under its title gains a line (M21). Unless the edit is what needs one: a
    // heading turned into a paragraph cannot touch the table under it any more, so the blank
    // lines stay when the block says something else without them.
    for (const shaped of [dropBlanks(candidate, prev), candidate]) {
      let c = keepMailto(shaped, prev);
      c = dropEscapes(c, prev, canon, next, context);
      if (c !== next && says(c, next, canon, context)) return c;
    }
    return next;
  }
  return candidate !== next && says(candidate, next, canon, context) ? candidate : next;
}

/**
 * Does this candidate say exactly what the editor is writing?
 *
 * Re-serialising it has to give back the canonical block, with one difference allowed: the
 * blank lines between the items of one list. Whether a list is loose is a property of the whole
 * list and not of the four items that happen to sit in one block — `- a\n- b` with a blank line
 * and one more bullet further down is *one* loose list, so the canonical text puts a blank line
 * between every item and the file has none. Writing the block tight keeps the file as it was
 * and the list as loose as it was, because the blank line further down is still there; the
 * whole-file check in guard.ts is what proves that, and it is the reason this is safe here.
 * Nothing else may differ: the candidate itself must have no blank line left in it, and every
 * blank line of the canonical block must sit between two items of a list.
 */
function says(candidate, next, canon, context = '') {
  const k = canon(candidate);
  if (k === next) return true;
  if (!/\n[ \t]*\n/.test(candidate) && blanksAreListGaps(next) && squeeze(k) === squeeze(next)) return true;
  // A block that carries on the one before it (a paragraph of a list item, under a blank line)
  // means nothing on its own: it is asked in the company of the canonical block before it.
  return !!context && canon(context + candidate) === canon(context + next);
}

const isItemLine = (l) => /^[ \t]*(?:[-*+]|\d+[.)])(?:[ \t]|$)/.test(l);

/** Every blank line of `text` sits between the items of one list, and there is at least one. */
function blanksAreListGaps(text) {
  const l = text.split('\n');
  let seen = false;
  for (let i = 0; i < l.length; i++) {
    if (l[i].trim()) continue;
    if (i === 0 || i === l.length - 1) return false;
    if (!isItemLine(l[i + 1])) return false;
    let k = i - 1;
    while (k >= 0 && !l[k].trim()) k--;
    if (k < 0 || !(isItemLine(l[k]) || /^[ \t]+\S/.test(l[k]))) return false;
    seen = true;
  }
  return seen;
}

const isEmptyQuoteLine = (l) => /^[ \t]*>[ \t]*$/.test(l);

/** Blank lines removed, except inside a fence where they are code. */
function dropBlanks(text, prev) {
  const quotes = !/^[ \t]*>[ \t]*$/m.test(prev);
  if (!/\n[ \t]*\n/.test(text) && !(quotes && /^[ \t]*>[ \t]*$/m.test(text))) return text;
  const fence = fenceTracker();
  return text.split('\n')
    .filter((l) => fence(l) || (l.trim() && !(quotes && isEmptyQuoteLine(l))))
    .join('\n');
}

/**
 * Line for line inside one block: a line whose content did not change keeps its bytes, and so
 * does the blank line in front of it. The two texts are one block of one file, so the walk
 * cannot drift the way it could over a whole file.
 *
 * The one line that did change — the one the user was on — is written from the canonical text,
 * but indented the way this file indents. That is not guessed: it is read off the lines that
 * did match. A file that nests with four spaces under a bullet and four under `1.` says so in
 * every other line of the same list, and remark's two and three are translated back.
 */
export function restoreLinesIn(next, prev) {
  const A = units(prev);
  const B = units(next);
  if (!A.items.length || !B.items.length) return next;
  const map = align(A.items.map(lineKey), B.items.map(lineKey), 400);

  const indentOf = (l) => (/^[ \t]*/.exec(l) || [''])[0];
  const widths = new Map();
  for (let j = 0; j < B.items.length; j++) {
    const i = map[j] ?? -1;
    if (i < 0) continue;
    const w = indentOf(B.items[j]).length;
    if (!widths.has(w)) widths.set(w, indentOf(A.items[i]));
  }

  let result = '';
  for (let j = 0; j < B.items.length; j++) {
    const i = map[j] ?? -1;
    // `map[j - 1]` is -1 for an inserted line, and -1 === i - 1 when i is 0: an insert above
    // the first line would take the first line's leading gap as its own (C11). Both sides survive.
    // And the file's spelling of a boundary only stands while it holds the same space
    // (`keepsGap`): an empty paragraph put between a paragraph and the list glued under it is
    // two blank lines the file never had, and taking the file's none for them dropped the
    // paragraph, failed the check and wrote the whole block in remark's spelling.
    const keepsBoundary = i >= 0 && (j === 0 ? i === 0 : (map[j - 1] ?? -1) >= 0 && map[j - 1] === i - 1);
    const gap = (keepsGap(keepsBoundary, A.gaps[i], B.gaps[j], j === 0) ? A.gaps[i] : B.gaps[j]) ?? 0;
    result += '\n'.repeat(j === 0 ? gap : gap + 1);
    if (i >= 0) { result += A.items[i]; continue; }
    const line = B.items[j] ?? '';
    const ind = indentOf(line);
    const want = widths.get(ind.length);
    result += want !== undefined && want !== ind ? want + line.slice(ind.length) : line;
  }
  // The same at the end. A heading glued to the table under it is cut in two by restoreTableIn,
  // and the heading's part ends in the blank lines in front of the table: one is the separator
  // remark writes, which the file does without; two are an empty paragraph, which it keeps.
  const last = map[B.items.length - 1];
  const aTail = A.gaps[A.gaps.length - 1];
  const bTail = B.gaps[B.gaps.length - 1];
  const tail = keepsGap(last === A.items.length - 1, aTail, bTail, false) ? aTail : bTail;
  return result + '\n'.repeat(tail ?? 0);
}

/** Map a function over the lines of a block, leaving fenced code alone. */
function mapLines(text, fn) {
  const fence = fenceTracker();
  return text.split('\n').map((l) => (fence(l) ? l : fn(l))).join('\n');
}

/**
 * The three spellings of a mailto link parse to the same thing, and `resourceLink: false` makes
 * remark write the shortest of them: `[a@b.com](mailto:a@b.com)` comes back as `<a@b.com>`. On
 * a line the user did not touch the line pass puts the file's own spelling back (`lineKey`
 * ignores the difference); on the line the user was on there is nothing to put back, so the
 * file's own spelling is looked up in the block instead (M23, D4).
 */
function keepMailto(text, prev) {
  if (!/<(?:mailto:)?[^\s<>]+@[^\s<>]+>/.test(text)) return text;
  const forms = new Map();
  for (const m of String(prev).matchAll(/\[([^\]\n]+)\]\(mailto:([^)\s]+)\)/g)) {
    if (m[1] === m[2] || m[1] === 'mailto:' + m[2]) forms.set(m[2], m[0]);
  }
  if (!forms.size) return text;
  return mapLines(text, (l) =>
    l.replace(/<(?:mailto:)?([^\s<>]+@[^\s<>]+)>/g, (m, addr) => forms.get(addr) || m));
}

// An escape mdast writes is always in front of ASCII punctuation, and a `\\` is a backslash the
// user typed: it is one unit and it is never touched.
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/**
 * An edited line never gains a backslash the file did not have (M8).
 *
 * mdast escapes any character that *could* open a construct at that position, and `postProcess`
 * undoes the handful of those it can prove unnecessary from the line alone. Here there is more
 * to go on: the block as the file wrote it. A backslash in front of a character the original
 * block never escaped is a backslash the file did not have, and it is dropped — but only where
 * dropping it leaves the block saying the same thing, which is the same re-serialisation test
 * every other restoration in this file has to pass. `\*\*Rate: 70%\*\*x` becomes
 * `**Rate: 70%**x` because both parse to the same literal text; a `\*` that really is holding
 * emphasis apart parses differently without it and stays.
 *
 * All of them go at once when that verifies, which is the usual case and one parse. When it does
 * not, they are tried one at a time and each is kept only on its own evidence.
 */
function dropEscapes(text, prev, canon, next, context = '') {
  const all = stripEscapes(text, prev, -1);
  if (all === text) return text;
  if (says(all, next, canon, context)) return all;
  let out = text;
  let k = 0;
  for (let guard = 0; guard < 32; guard++) {
    const one = stripEscapes(out, prev, k);
    if (one === out) break;
    if (says(one, next, canon, context)) out = one;
    else k++;
  }
  return out;
}

/**
 * `text` with the added escapes removed: the `only`-th of them, or every one when `only` is -1.
 * "Added" means the original block does not escape that character anywhere, so a hand-written
 * `\_` in the file keeps every `\_` in the block. Code spans are left alone, like everywhere.
 */
function stripEscapes(text, prev, only = -1) {
  const had = new Set<any>();
  for (let i = 0; i < prev.length - 1; i++) {
    if (prev[i] !== '\\') continue;
    had.add(prev[i + 1]);
    i++;                                   // `\\` is one unit: the next char is not an escape
  }
  let n = 0;
  return mapLines(text, (line) => {
    const skip = verbatimRuns(lineRuns(line));
    let out = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      const jump = skip.get(i);
      if (jump !== undefined) { out += line.slice(i, jump); i = jump; continue; }
      const nx = line[i + 1];
      if (ch === '\\' && nx && nx !== '\\' && ESCAPABLE.test(nx) && !had.has(nx)) {
        const drop = only < 0 || only === n;
        n++;
        out += drop ? nx : ch + nx;
        i += 2;
        continue;
      }
      if (ch === '\\' && nx === '\\') { out += '\\\\'; i += 2; continue; }
      out += ch;
      i++;
    }
    return out;
  });
}
