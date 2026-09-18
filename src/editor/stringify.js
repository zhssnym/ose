// remark-stringify configuration, the canonical clean-up of what it produces, and the pass
// that reconciles that canonical output with the file already on disk.
//
// Milkdown feeds STRINGIFY_OPTIONS straight into remark-stringify (see @milkdown/core `init`:
// the options are read once, after ConfigReady, to build the remark instance behind the parser
// and the serializer). They also seed the default `marker` attribute of the emphasis and strong
// marks, so `emphasis: '_'` is what a NEW italic gets; existing ones keep the marker they were
// written with, because the commonmark preset's remarkMarker plugin records it per node at
// parse time. That is why the vault's mix of `_x_` and `*x*` survives untouched.

import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { remarkGFMPlugin } from '@milkdown/kit/preset/gfm';
import { lineRuns, opensDisplay } from './math.js';
import { spaceJoin } from './space.js';

/** The exact options. Every one of these is answerable to a real file in the vault. */
export const STRINGIFY_OPTIONS = {
  bullet: '-',            // Hassan's files use '-' everywhere
  bulletOther: '*',       // must differ from `bullet`; only used for adjacent sibling lists
  bulletOrdered: '.',     // `1.` not `1)`
  emphasis: '_',          // default marker for new emphasis
  strong: '*',            // doubled -> `**strong**`
  rule: '-',              // `---` thematic break
  ruleRepetition: 3,
  ruleSpaces: false,      // `---`, not `- - -`
  fence: '`',
  fences: true,           // never indent-style code blocks
  listItemIndent: 'one',  // `- item`, continuation indented by 2
  incrementListMarker: true,
  quote: '"',             // link titles
  resourceLink: false,    // a bare url stays an autolink `<...>`
  setext: false,          // ATX headings only
  tightDefinitions: true,
  handlers: HANDLERS(),
  // What an empty paragraph costs in blank lines (space.js). mdast reads `join` back to front,
  // so this one is asked before its own rules and nothing below it can widen a gap again.
  join: [spaceJoin],
};

/**
 * The one mdast handler we replace (D7, E33, L17, M3).
 *
 * A hard break is written `\` then a newline by `mdast-util-to-markdown`, and a visible
 * trailing backslash is unlike anything in the vault; where a newline is not allowed at all —
 * inside a table row — it is written as a *space*, so the break is silently lost. Obsidian
 * writes a bare newline in a paragraph and a literal `<br>` in a cell, and so do we. The
 * matching read is already there: `remarkLineBreak` turns a soft newline inside a paragraph
 * into a hard break, and a `<br>` in a cell is an inline html node.
 */
function HANDLERS() {
  return {
    break: (_node, _parent, state) =>
      (state.stack.includes('tableCell') || state.stack.includes('headingAtx') ? '<br>' : '\n'),
  };
}

/**
 * remark-gfm options. Tables are what matters: by default mdast pads every cell so the pipes
 * line up, which rewrites all 747 table rows in the vault. `tablePipeAlign: false` stops that.
 * `singleTilde: false` keeps `~2017` and `~10 months` as plain text instead of reading a lone
 * pair of tildes as strikethrough — the vault uses `~` for "about", never for strikethrough.
 */
export const GFM_OPTIONS = {
  tablePipeAlign: false,
  tableCellPadding: true,
  singleTilde: false,
};

/** Apply both option sets to a Milkdown editor. Must be called before `create()`. */
export function configureStringify(editor) {
  editor.config((ctx) => {
    // `handlers` and `join` are merged, not replaced: mdast keeps a map of handlers and a list
    // of join rules and Milkdown puts its own in each. Milkdown's handlers for emphasis, strong
    // and text are what keep the vault's mix of `_x_` and `*x*` as it was written.
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({
      ...prev,
      ...STRINGIFY_OPTIONS,
      handlers: { ...(prev?.handlers || {}), ...STRINGIFY_OPTIONS.handlers },
      join: [...(prev?.join || []), ...STRINGIFY_OPTIONS.join],
    }));
    ctx.update(remarkGFMPlugin.options.key, (prev) => ({ ...(prev || {}), ...GFM_OPTIONS }));
  });
  return editor;
}

// ---------------------------------------------------------------------------
// Canonical clean-up.
//
// mdast-util-to-markdown escapes conservatively: it backslashes any character that *could*
// open a construct at that position, even when the surrounding text makes that impossible.
// Milkdown adds two quirks of its own. Each rule below undoes exactly one of those and is
// anchored so it cannot fire on anything else. Fenced code and code spans are never touched.

/**
 * Depends on nothing but `md`, so the result is the same for a given ProseMirror document
 * however that document was reached. This is the text the reconcile pass is verified against.
 */
export function postProcess(md) {
  let out = String(md ?? '');

  // Two rules that were here are gone in batch 12, and both were deletions:
  //
  //   the `<br />` sweep — an empty paragraph, an empty table cell and an empty list item were
  //   all written as `<br />` by `remark-preserve-empty-line` and swept up again here, which
  //   also swept up a `<br>` the file itself contained (M3, L1). The plugin is left out of the
  //   editor now (crepe.js), so none of those markers is ever written and a `<br>` is a
  //   `<br>`;
  //   the `![1.00](` strip — Milkdown's image-block node used to keep an aspect ratio in the
  //   markdown alt slot. Its runners write `![alt|width](src)` now (image.js, M7), so the alt
  //   slot is text and nothing here may touch it.

  const src = out.split('\n');
  const lines = [];
  const fence = fenceTracker();
  for (let i = 0; i < src.length; i++) {
    if (fence(src[i])) { lines.push(src[i]); continue; }
    // A run of blank lines is left exactly as the serializer wrote it: the second one and every
    // one after it is an empty paragraph the document holds, not noise to be squeezed out
    // (space.js). The rule that used to stand here collapsed them, which is why a gap made with
    // Enter came back a second later without one.
    lines.push(unescapeLine(src[i], isDelimiterRow(src[i + 1] || '')));
  }

  // 4. mdast writes the shortest legal delimiter row, `| - |`. Every table in the vault is
  //    written `| --- |` or `|---|`, and so is every table Obsidian makes, so a table the
  //    editor creates should look like the ones around it (L20). Alignment colons are kept.
  widenDelimiters(lines);
  return lines.join('\n');
}

/** `| - | :- |` -> `| --- | :--- |`, in place, for every delimiter row outside a fence. */
function widenDelimiters(lines) {
  const fence = fenceTracker();
  for (let i = 0; i < lines.length; i++) {
    const inFence = fence(lines[i]);
    if (inFence || i === 0) continue;
    if (!isDelimiterRow(lines[i]) || !isTableRow(lines[i - 1])) continue;
    lines[i] = lines[i].replace(/(\|\s*)(:?)-+(:?)(\s*(?=\|))/g, (m, a, l, r, b) => a + l + '---' + r + b);
  }
}

/** A `$$` on a line of its own: the fence a multi-line display formula opens and closes with. */
const BARE_DISPLAY = /^ {0,3}\$\$[ \t]*$/;
/** `$$ ... $$` on one line: a display formula that opens and closes where it stands. */
const ONE_LINE_DISPLAY = /^ {0,3}\$\$[\s\S]*\$\$[ \t]*$/;

/**
 * Stateful fence detector: true for a fence marker line and for every line inside a fence.
 *
 * A display formula is a fence like any other. Its lines are TeX and not markdown, so nothing
 * in this file may unescape inside one, restyle one, or cut a block at a blank line in one.
 */
function fenceTracker() {
  let inFence = false;
  let mark = '';
  return (line) => {
    if (inFence) {
      if (mark === '$') { if (/\$\$[ \t]*$/.test(line)) { inFence = false; mark = ''; } return true; }
      const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (m && m[1][0] === mark) { inFence = false; mark = ''; }
      return true;
    }
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (m) { inFence = true; mark = m[1][0]; return true; }
    if (!opensDisplay(line)) return false;
    if (ONE_LINE_DISPLAY.test(line)) return true;          // opens and closes where it stands
    // Only a bare `$$` opens a formula that runs on: a line that merely starts with `$$` and
    // never closes would otherwise swallow the rest of the file.
    if (!BARE_DISPLAY.test(line)) return false;
    inFence = true;
    mark = '$';
    return true;
  };
}

/**
 * The formulas and the code spans of one line, by their start index: everything in them is
 * kept byte for byte, because none of it is markdown. A `\&` or a `\_` inside `$...$` is TeX
 * the user wrote and the serializer never put it there.
 */
function verbatimRuns(runs) {
  const skip = new Map();
  for (const r of runs) if (r.kind !== 'text') skip.set(r.start, r.end);
  return skip;
}

/**
 * May every `\$` on this line lose its backslash?
 *
 * The serializer escapes every `$` in running text, without exception, because deciding one at
 * a time needs to know what the `$` three words further on will do. Here the whole line is in
 * hand, so the question can be asked properly: build the line with the backslashes taken off,
 * and keep them only if that would make, unmake or change a formula. `Un prix de 5 $ puis de
 * 10 $` gets its dollars back; `\$x\$` keeps them, because `$x$` is a formula and the file
 * said it was text.
 */
function dollarsSafe(line, runs) {
  if (!line.includes('\\$')) return true;
  let candidate = '';
  for (const r of runs) {
    const text = line.slice(r.start, r.end);
    candidate += r.kind === 'text' ? text.replace(/\\\$/g, '$') : text;
  }
  return mathShape(candidate) === mathShape(line);
}

/** What the maths of a line is: the display fence, then every formula, in order. */
const mathShape = (line) =>
  (opensDisplay(line) ? 'D ' : '')
  + lineRuns(line).filter((r) => r.kind === 'math').map((r) => line.slice(r.start, r.end)).join(' ');

/**
 * Walk one line outside code spans and formulas and undo the over-escapes.
 * `opensTable` says the next line is a delimiter row, which is the one place where an
 * unescaped `|` would turn this line into a table header.
 */
function unescapeLine(line, opensTable) {
  // Outside a table a `|` is an ordinary character, and the vault has them in prose and in
  // image widths (`![alt|420](x.png)`). remark escapes them anyway.
  const pipeSafe = !opensTable && !isTableRow(line);
  // A lone `~` cannot open strikethrough; mdast escapes it anyway. Only safe when the line
  // has no `~~` pair at all, so `~~struck~~` keeps its escapes.
  const tildeSafe = !/~~/.test(line.replace(/\\~/g, '~'));
  // `[` only opens a link when `](` or `][` follows it on the line. CommonMark allows no
  // space between the two, so `[cours] (Q1)` is plain text, not a link.
  const bracketSafe = !/\][([]/.test(line);
  const runs = lineRuns(line);
  const skip = verbatimRuns(runs);
  const dollarSafe = dollarsSafe(line, runs);

  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const jump = skip.get(i);
    // A code span or a formula: its bytes are its own.
    if (jump !== undefined) { out += line.slice(i, jump); i = jump; continue; }
    if (ch === '\\' && i + 1 < line.length) {
      const next = line[i + 1];
      // A `*` with whitespace on both sides is neither left- nor right-flanking, so it can
      // never open or close emphasis: `100,000 * 100,000` needs no backslash.
      const loneStar = next === '*'
        && /^\s*$/.test(out.slice(-1))
        && /^\s*$/.test(line[i + 2] || '');
      // `]\(` is the other half of `bracketSafe`: mdast escapes both brackets of a literal
      // `[text](url)` so it stays text, and un-escaping only the `[` leaves the stray
      // backslash of E22. Un-escape the `(` too, which is what the user typed and meant.
      const linkParen = next === '(' && out.endsWith(']');
      // An `_` between two word characters can neither open nor close emphasis (CommonMark
      // 6.2, the intraword rule), so `snake_case_var` needs no backslashes — and gaining a
      // pair of them on a line the user edited is M8.
      const wordUnderscore = next === '_'
        && /\w$/.test(out) && /^\w/.test(line[i + 2] || '');
      // `#` opens a heading only when the run of hashes is followed by a space or ends the
      // line. `#tag` at the start of a line is a paragraph, and its backslash is noise.
      // `&` only starts something when a character reference follows it. remark decodes
      // `AT&amp;T` into `AT&T` at parse and then escapes the `&` on the way out, so a line the
      // user edited came back with a backslash in it that was never in the file (M9).
      const ampersand = next === '&' && !/^(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/.test(line.slice(i + 2));
      let hashTag = false;
      if (next === '#' && !out.trim()) {
        let n = 1;
        while (line[i + 1 + n] === '#') n++;
        const after = line[i + 1 + n];
        hashTag = !!after && !/\s/.test(after);
      }
      if ((next === '~' && tildeSafe) || (next === '[' && bracketSafe) || (next === '|' && pipeSafe)
        || (next === '$' && dollarSafe)
        || loneStar || linkParen || wordUnderscore || hashTag || ampersand) out += next;
      else out += ch + next;
      i += 2;
      continue;
    }
    // A leading space inside a block is written as a character reference. Hassan's files
    // contain real double spaces (`- [ ]  Home Rent: 500`); keep them literal.
    if (ch === '&' && line.startsWith('&#x20;', i) && i + 6 < line.length) {
      out += ' ';
      i += 6;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconciliation against the file on disk.
//
// remark writes one canonical shape: exactly one blank line between blocks, tables reflowed,
// list continuations indented by two, escapes wherever they might conceivably be needed.
// Hassan's files are written densely and inconsistently, and App/CLAUDE.md is explicit that a
// user edit must not reformat the rest of the file. So after serialising we walk the canonical
// output alongside the original and put back every line whose *content* did not change.
//
// This is a heuristic and it is not trusted on its own: the caller (crepe.js) re-parses the
// reconciled text and only writes it if it produces exactly the same document. If it does not,
// the canonical output is written instead.

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
function units(text) {
  const items = [];
  const gaps = [];
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
function align(a, b, window = 80) {
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
 * @param {string} out       canonical output of postProcess()
 * @param {string} original  the file as it is on disk
 * @param {object} [opt]
 * @param {(md:string)=>string} [opt.canon]  parse-and-serialise, from the editor. When it is
 *        given, reconciliation is block by block (the batch-12 engine); without it the old
 *        line-only pass runs, which no caller in the app uses any more.
 * @param {boolean} [opt.lines=true] line pass only: restore lines that differ only in escaping
 * @returns {string} a candidate the caller must verify by re-parsing
 */
export function reconcile(out, original, opt = {}) {
  if (!original) return out;
  if (typeof opt.canon === 'function') return reconcileBlocks(out, original, opt.canon);
  return reconcileLines(out, original, opt);
}

function reconcileLines(out, original, opt = {}) {
  const restoreLines = opt.lines !== false;

  const text = restoreTables(out, original);
  const A = units(original);
  const B = units(text);
  if (!B.items.length || !A.items.length) return text;

  const map = align(A.items.map(lineKey), B.items.map(lineKey));

  let result = '';
  for (let j = 0; j < B.items.length; j++) {
    const i = map[j];
    // The original's spacing only describes this boundary when both sides of it survived and
    // were adjacent in the original; anywhere the user inserted something, keep remark's.
    const keepsBoundary = i >= 0 && (j === 0 ? i === 0 : map[j - 1] === i - 1);
    const gap = keepsBoundary ? A.gaps[i] : B.gaps[j];
    result += '\n'.repeat(j === 0 ? gap : gap + 1);
    result += i >= 0 && restoreLines ? A.items[i] : B.items[j];
  }
  const last = map[B.items.length - 1];
  const tail = last === A.items.length - 1 ? A.gaps[A.gaps.length - 1] : B.gaps[B.gaps.length - 1];
  return result + '\n'.repeat(tail);
}

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

/** Top-level blocks: maximal runs of non-blank lines, fenced code kept whole. */
export function blocks(text) {
  const lines = String(text).split('\n');
  const fence = fenceTracker();
  const list = [];
  const gaps = [];
  let gap = 0;
  let cur = null;
  const close = () => { if (cur) { list.push(cur); cur = null; } };
  for (let i = 0; i < lines.length; i++) {
    const inFence = fence(lines[i]);
    if (!inFence && !lines[i].trim()) { close(); gap++; continue; }
    const rule = !inFence && BREAK_LINE.test(lines[i]);
    if (rule && !isParagraphLine(lines[i - 1])) close();   // a thematic break, not an underline
    if (!cur) { cur = { start: i, end: i, lines: [] }; gaps.push(gap); gap = 0; }
    cur.lines.push(lines[i]);
    cur.end = i;
    if (rule) close();                                     // and nothing follows it in its block
  }
  close();
  gaps.push(gap);
  for (const b of list) b.text = b.lines.join('\n');
  return { list, gaps };
}

// How far apart two block sequences may drift before the walk gives up and pairs by position.
// Blocks are coarse: a dozen is a whole screen of prose.
const BLOCK_WINDOW = 12;

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
function matchBlocks(A, B, canon, bLines) {
  const from = new Int32Array(B.length).fill(-1);
  const span = new Int32Array(B.length);
  const unchanged = new Uint8Array(B.length);
  const keys = new Array(A.length);
  const key = (i) => (keys[i] === undefined ? (keys[i] = canon(A[i].text)) : keys[i]);
  /** How many canonical blocks this original block turns into. */
  const width = (i) => Math.max(1, blocks(key(i)).list.length);

  /** -1 when they are not the same block, else how many extra canonical blocks it swallows. */
  const same = (i, j) => {
    if (A[i].text === B[j].text) return 0;
    const k0 = key(i);
    if (k0 === B[j].text) return 0;
    // Looseness is a property of the whole list, not of the four items that happen to sit in
    // one block: `- a\n- b` on its own is a tight list, and the same two items in a list that
    // has a blank line further down come back with a blank line between them. So the run is
    // also compared with its blank lines taken out, which is the only thing that can differ.
    const s0 = squeeze(k0);
    for (let k = 1; k <= GROUP_MAX && j + k < B.length; k++) {
      const text = bLines.slice(B[j].start, B[j + k].end + 1).join('\n');
      if (text.length > k0.length + 2 * k) break;
      if (text === k0 || squeeze(text) === s0) return k;
    }
    return -1;
  };

  // Resynchronising needs two blocks in a row, not one. A file with `---` between its sections
  // has a dozen blocks that are all the same block, and one of them matching further down is no
  // evidence at all — following it would orphan everything in between.
  const confirmed = (ai, bj) => {
    const k = same(ai, bj);
    if (k < 0) return -1;
    if (ai + 1 >= A.length) return k;          // the last block of the file: nothing to confirm
    // There is another original block but no canonical block left to hold it: following this
    // match would orphan the rest of the file. The last block of a page is very often the same
    // one line as an earlier block (`- None this month` twice under two headings), which is
    // exactly the evidence `confirmed` exists to refuse.
    if (bj + k + 1 >= B.length) return -1;
    return same(ai + 1, bj + k + 1) >= 0 ? k : -1;
  };

  /**
   * How many canonical blocks the block the user edited accounts for. Its own canonical width is
   * the first guess and usually right — a paragraph and the list under it are one block in the
   * file and two after remark. But an edit can change that width: a list that is loose because
   * of a blank line further down comes back as one canonical block per item, and taking one
   * block for it leaves the other items unclaimed, each written out with the blank line remark
   * put in front of it (D3). The next original block, which did not change, says where this one
   * ends, and it has to be confirmed by the one after it like every other resynchronisation.
   */
  const claim = (i, j) => {
    const w0 = Math.min(Math.max(1, width(i)), B.length - j);
    if (i + 1 >= A.length) return w0;
    if (confirmed(i + 1, j + w0) >= 0) return w0;
    const limit = Math.min(GROUP_MAX, B.length - j);
    for (let w = 1; w <= limit; w++) if (w !== w0 && confirmed(i + 1, j + w) >= 0) return w;
    return w0;
  };

  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    let k = same(i, j);
    for (let d = 1; d <= BLOCK_WINDOW && k < 0; d++) {
      if (i + d < A.length && confirmed(i + d, j) >= 0) { i += d; k = same(i, j); }
      else if (j + d < B.length && confirmed(i, j + d) >= 0) { j += d; k = same(i, j); }
    }
    // The block the user edited still accounts for every canonical block its original turns
    // into: a paragraph and the list under it, written with no blank line between them, are
    // one block in the file and two after remark, and editing the paragraph must not put a
    // blank line in. So it claims that whole run and is reconciled against it as one piece.
    const w = k >= 0 ? k + 1 : claim(i, j);
    from[j] = i;
    span[j] = w - 1;
    if (k >= 0) { unchanged[j] = 1; for (let x = 1; x < w; x++) from[j + x] = i; }
    i++;
    j += w;
  }
  return { from, span, unchanged };
}

function reconcileBlocks(out, original, rawCanon) {
  // A serialisation always ends in a newline and a block never does, so every comparison in
  // here goes through this: what the editor writes for a block, as a block.
  const canon = (text) => rawCanon(text).replace(/^\n+|\n+$/g, '');
  const A = blocks(original);
  const B = blocks(out);
  if (!A.list.length || !B.list.length) return out;

  const bLines = out.split('\n');
  const { from, span, unchanged } = matchBlocks(A.list, B.list, canon, bLines);
  const style = detectStyle(original);

  let result = '';
  let prev = -1;      // the original block the last piece of output came from
  let first = true;
  for (let j = 0; j < B.list.length; j += span[j] + 1) {
    const p = from[j];
    // The original's blank lines describe this boundary only when both sides of it survived
    // and were adjacent in the original; anywhere the user inserted something, keep remark's.
    const keepsBoundary = p >= 0 && (first ? p === 0 : prev === p - 1);
    const gap = keepsGap(keepsBoundary, A.gaps[p], B.gaps[j], first) ? A.gaps[p] : B.gaps[j];
    result += '\n'.repeat(first ? gap : gap + 1);
    if (p >= 0 && unchanged[j]) result += A.list[p].text;
    else {
      const next = bLines.slice(B.list[j].start, B.list[j + span[j]].end + 1).join('\n');
      result += editedBlock(next, p >= 0 ? A.list[p].text : null, canon, style);
    }
    prev = p;
    first = false;
  }
  const aTail = A.gaps[A.gaps.length - 1];
  const bTail = B.gaps[B.gaps.length - 1];
  return result + '\n'.repeat(keepsGap(true, aTail, bTail, false) ? aTail : bTail);
}

/**
 * How many empty paragraphs a run of blank lines holds (space.js): the first one is the
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
function editedBlock(next, prev, canon, style) {
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
    // with a list under its title gains a line (M21).
    candidate = dropBlanks(candidate, prev);
    candidate = keepMailto(candidate, prev);
    candidate = dropEscapes(candidate, prev, canon, next);
  }
  return candidate !== next && says(candidate, next, canon) ? candidate : next;
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
 * whole-file check in crepe.js is what proves that, and it is the reason this is safe here.
 * Nothing else may differ: the candidate itself must have no blank line left in it, and every
 * blank line of the canonical block must sit between two items of a list.
 */
function says(candidate, next, canon) {
  const k = canon(candidate);
  if (k === next) return true;
  if (/\n[ \t]*\n/.test(candidate) || !blanksAreListGaps(next)) return false;
  return squeeze(k) === squeeze(next);
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
function restoreLinesIn(next, prev) {
  const A = units(prev);
  const B = units(next);
  if (!A.items.length || !B.items.length) return next;
  const map = align(A.items.map(lineKey), B.items.map(lineKey), 400);

  const indentOf = (l) => (/^[ \t]*/.exec(l) || [''])[0];
  const widths = new Map();
  for (let j = 0; j < B.items.length; j++) {
    if (map[j] < 0) continue;
    const w = indentOf(B.items[j]).length;
    if (!widths.has(w)) widths.set(w, indentOf(A.items[map[j]]));
  }

  let result = '';
  for (let j = 0; j < B.items.length; j++) {
    const i = map[j];
    const keepsBoundary = i >= 0 && (j === 0 ? i === 0 : map[j - 1] === i - 1);
    const gap = keepsBoundary ? A.gaps[i] : B.gaps[j];
    result += '\n'.repeat(j === 0 ? gap : gap + 1);
    if (i >= 0) { result += A.items[i]; continue; }
    const line = B.items[j];
    const ind = indentOf(line);
    const want = widths.get(ind.length);
    result += want !== undefined && want !== ind ? want + line.slice(ind.length) : line;
  }
  const last = map[B.items.length - 1];
  const tail = last === A.items.length - 1 ? A.gaps[A.gaps.length - 1] : B.gaps[B.gaps.length - 1];
  return result + '\n'.repeat(tail);
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
function dropEscapes(text, prev, canon, next) {
  const all = stripEscapes(text, prev, -1);
  if (all === text) return text;
  if (says(all, next, canon)) return all;
  let out = text;
  let k = 0;
  for (let guard = 0; guard < 32; guard++) {
    const one = stripEscapes(out, prev, k);
    if (one === out) break;
    if (says(one, next, canon)) out = one;
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
  const had = new Set();
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

// ---------------------------------------------------------------------------
// The file's own markers (M12).
//
// remark writes one spelling of each construct — `-` bullets, `1.` numbers, `---` rules,
// backtick fences, two-space nesting — and STRINGIFY_OPTIONS picks the spellings Hassan's
// files use. A file written the other way (a `*` list, a `~~~` fence, four-space nesting)
// keeps its own bytes wherever it is untouched, because that is a block that matched; the
// block the user edited is the one that would come back in the house style. So an edited
// block is put back in the style of the file it lives in, and verified like everything else.

const DEFAULT_STYLE = { bullet: '-', ordered: '.', rule: '---', fence: '`', indent: 2, quote: '> >' };

/** The marker run of a quoted line: the indent, then the `>`s and the spaces between them. */
const QUOTE_RUN = /^( {0,3})((?:>[ \t]?)+)/;

/** What this file is written with. Only what the serialiser would otherwise override. */
export function detectStyle(text) {
  const style = { ...DEFAULT_STYLE };
  const lines = String(text).split('\n');
  const fence = fenceTracker();
  let seenBullet = false;
  let seenIndent = false;
  let seenQuote = false;
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const inFence = fence(line);
    if (f) { style.fence = f[1][0]; continue; }
    if (inFence) continue;
    // A frame is `>>` in this vault and `> >` in remark's output (M25). The file decides.
    const quote = QUOTE_RUN.exec(line);
    if (quote && !seenQuote && (quote[2].match(/>/g) || []).length > 1) {
      style.quote = /^>>/.test(quote[2]) ? '>>' : '> >';
      seenQuote = true;
    }
    const rule = /^\s{0,3}((?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.exec(line);
    if (rule) { style.rule = rule[1].trimEnd(); continue; }
    const item = /^([ \t]*)([-*+]|\d+[.)])[ \t]/.exec(line);
    if (!item) continue;
    if (/[-*+]/.test(item[2]) && !seenBullet) { style.bullet = item[2]; seenBullet = true; }
    if (/\d/.test(item[2])) style.ordered = item[2].slice(-1);
    if (item[1] && !seenIndent) { style.indent = item[1].replace(/\t/g, '    ').length; seenIndent = true; }
  }
  return style;
}

const isDefaultStyle = (s) =>
  s.bullet === '-' && s.ordered === '.' && s.rule === '---' && s.fence === '`' && s.indent === 2
  && s.quote === '> >';

/** One block rewritten in `style`. Idempotent on lines that are already in it. */
function applyStyle(text, style) {
  if (!style || isDefaultStyle(style)) return text;
  const fence = fenceTracker();
  return text.split('\n').map((line) => {
    const f = /^\s{0,3}(`{3,})/.exec(line);
    const inFence = fence(line);
    if (f && style.fence === '~') return line.replace(/`/g, '~');
    if (inFence) return line;
    if (/^\s{0,3}-{3,}\s*$/.test(line)) return style.rule;
    let out = line;
    // `>>` is one construct written two ways, and remark writes the other one. A file that
    // frames a theorem with `>>` keeps `>>` on the line the user edited as well (M25).
    if (style.quote === '>>') {
      out = out.replace(QUOTE_RUN, (m, ind, marks) => {
        const n = (marks.match(/>/g) || []).length;
        return n > 1 ? ind + '>'.repeat(n) + (/[ \t]$/.test(marks) ? ' ' : '') : m;
      });
    }
    // Only remark's own two-space nesting is rescaled, and only in a block with no original to
    // read the indent off (`restoreLinesIn` does that better). Three spaces is what an ordered
    // list's continuation gets, and scaling it would land between two levels.
    if (style.indent !== 2) {
      out = out.replace(/^ +/, (m) => (m.length % 2 ? m : ' '.repeat((m.length / 2) * style.indent)));
    }
    if (style.bullet !== '-') out = out.replace(/^([ \t]*)-([ \t])/, `$1${style.bullet}$2`);
    if (style.ordered !== '.') out = out.replace(/^([ \t]*\d+)\.([ \t])/, `$1${style.ordered}$2`);
    return out;
  }).join('\n');
}

/**
 * A heading written `Text` over `-----` is a setext H2, and `setext: false` turns it into
 * `## Text` — deleting a line of the file to gain one it never had (M2). When the block that
 * was a setext heading comes back as an ATX heading of the same level, put it back.
 */
function keepSetext(next, prev) {
  const a = prev.split('\n');
  if (a.length !== 2) return next;
  const rule = a[1].match(/^\s{0,3}(=+|-+)\s*$/);
  if (!rule || /^\s{0,3}(?:#{1,6}\s|[-*+>]\s|\|)/.test(a[0]) || !a[0].trim()) return next;
  const atx = next.match(/^(#{1,6})[ \t]+(.*)$/);
  if (!atx || atx[1].length !== (rule[1][0] === '=' ? 1 : 2)) return next;
  return atx[2] + '\n' + a[1];
}

// ---------------------------------------------------------------------------
// Tables.
//
// remark rewrites every table into one canonical shape. The vault uses several (`|---|---|`,
// `| --- | --- |`, `| - | - |`, padded columns), so a page edited anywhere would have all of
// its tables reflowed. Any table whose cell content came back unchanged is put back exactly as
// it was written; a table the user actually edited no longer matches and gets the canonical
// shape, which is the right trade.

const isTableRow = (l) => /^\s*\|/.test(l);
const isDelimiterRow = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(l);

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
function restoreTableIn(next, prev) {
  const b = next.split('\n');
  const a = prev.split('\n');
  const nb = tableSpan(b);
  const pb = tableSpan(a);
  if (!nb || !pb) return null;
  const seg = (l, from, to) => l.slice(from, to).join('\n');
  const parts = [];
  if (nb.start) {
    const head = seg(b, 0, nb.start);
    parts.push(pb.start ? restoreLinesIn(head, seg(a, 0, pb.start)) : head);
  }
  parts.push(restoreRows(seg(b, nb.start, nb.end + 1), seg(a, pb.start, pb.end + 1)));
  if (nb.end + 1 < b.length) {
    const tail = seg(b, nb.end + 1, b.length);
    parts.push(pb.end + 1 < a.length ? restoreLinesIn(tail, seg(a, pb.end + 1, a.length)) : tail);
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
    out[j + 2] = map[j] >= 0 ? a[map[j] + 2]
      : repad(b[j + 2], a[Math.min(j, ak.length - 1) + 2] || a[2]);
  }
  return out.join('\n');
}

/**
 * The row the user was in, in the column widths the table is written with. remark writes every
 * cell padded by one space; a row like that dropped into a table whose columns are aligned by
 * hand looks broken, and the padding is not content — it does not change what the row says.
 */
function repad(next, prev) {
  if (!prev || !isTableRow(prev)) return next;
  const nc = splitCells(next);
  const pc = splitCells(prev);
  if (nc.length !== pc.length) return next;
  const indent = (/^\s*/.exec(prev) || [''])[0];
  const cells = pc.map((old, k) => {
    const m = /^([ \t]*)[\s\S]*?([ \t]*)$/.exec(old);
    const body = nc[k].trim();
    const left = m[1] || (body ? ' ' : ' ');
    const pad = old.length - left.length - body.length;
    return left + body + (pad > 0 ? ' '.repeat(pad) : (m[2] ? ' ' : ''));
  });
  return `${indent}|${cells.join('|')}|`;
}

function findTables(md) {
  const lines = md.split('\n');
  const fence = fenceTracker();
  const inFence = lines.map((l) => fence(l));
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (!inFence[i] && isTableRow(lines[i]) && isDelimiterRow(lines[i + 1] || '')) {
      let j = i + 1;
      while (j + 1 < lines.length && !inFence[j + 1] && isTableRow(lines[j + 1])) j++;
      blocks.push({ start: i, end: j });
      i = j + 1;
      continue;
    }
    i++;
  }
  return { lines, blocks };
}

const splitCells = (row) =>
  row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);

/** Cell-content signature, ignoring padding, pipe alignment and delimiter dash counts. */
function tableSignature(lines, start, end) {
  const rows = [];
  for (let i = start; i <= end; i++) {
    const cells = splitCells(lines[i]);
    if (i === start + 1) rows.push(cells.map((c) => c.replace(/-+/g, '-').replace(/\s+/g, '')));
    else rows.push(cells.map(lineKey));
  }
  return JSON.stringify(rows);
}

function restoreTables(out, original) {
  const a = findTables(out);
  const b = findTables(original);
  if (!a.blocks.length || a.blocks.length !== b.blocks.length) return out;

  let changed = false;
  const lines = a.lines.slice();
  // Walk backwards so earlier indexes stay valid while splicing.
  for (let k = a.blocks.length - 1; k >= 0; k--) {
    const A = a.blocks[k];
    const B = b.blocks[k];
    if (tableSignature(a.lines, A.start, A.end) !== tableSignature(b.lines, B.start, B.end)) continue;
    lines.splice(A.start, A.end - A.start + 1, ...b.lines.slice(B.start, B.end + 1));
    changed = true;
  }
  return changed ? lines.join('\n') : out;
}
