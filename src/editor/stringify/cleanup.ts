// Part of the serializer (../stringify.ts). The canonical clean-up of what remark writes: the
// escapes it adds, taken off wherever that provably changes nothing.

import { lineRuns, opensDisplay } from '../math-rule.ts';
import { isDelimiterRow, isTableRow, splitCells } from './tables.ts';

// ---------------------------------------------------------------------------
// Canonical clean-up.
//
// mdast-util-to-markdown escapes conservatively: it backslashes any character that *could*
// open a construct at that position, even when the surrounding text makes that impossible.
// Milkdown adds two quirks of its own. Each rule below undoes exactly one of those and is
// anchored so it cannot fire on anything else. Code, maths and html are never touched.
//
// None of this is trusted. A rule that is wrong about a line can turn text into a link, a
// table or a code block, and that used to be written (C8): the check was the same clean-up
// run twice, which agrees with itself by construction. The write guard (guard.ts) now reads
// every text back and compares it with the document on screen, and when the clean-up changed
// the meaning the serializer's own output is written instead. So the rules here only have to
// be right as often as possible, and every one of them errs on the side of keeping a backslash.

/**
 * Depends on nothing but `md`, so the result is the same for a given ProseMirror document
 * however that document was reached. This is the text the reconcile pass is verified against.
 *
 * @param md   raw serializer output
 * @param opt   the parser's tree of a text (engine.ts
 *   `mdast`). With it, code, maths and block html are found where the parser puts them, in a
 *   quote or a nested list as well as at the top (C9). Without it a line scan finds them, and
 *   errs on the side of calling a line code, which only ever keeps a backslash.
 */
export function postProcess(md: string, opt: { mdast?: (md: string) => any; } = {}): string {
  const text = String(md ?? '');

  // Two rules that were here are gone in batch 12, and both were deletions:
  //
  //   the `<br />` sweep — an empty paragraph, an empty table cell and an empty list item were
  //   all written as `<br />` by `remark-preserve-empty-line` and swept up again here, which
  //   also swept up a `<br>` the file itself contained (M3, L1). The plugin is left out of the
  //   editor now (crepe.ts), so none of those markers is ever written and a `<br>` is a
  //   `<br>`;
  //   the `![1.00](` strip — Milkdown's image-block node used to keep an aspect ratio in the
  //   markdown alt slot. Its runners write `![alt|width](src)` now (image.ts, M7), so the alt
  //   slot is text and nothing here may touch it.

  const src = text.split('\n');
  const tree = parseTree(text, opt.mdast);
  const verbatim = verbatimLines(src, tree);
  // A run of blank lines is left exactly as the serializer wrote it: the second one and every
  // one after it is an empty paragraph the document holds, not noise to be squeezed out
  // (space.ts). The rule that used to stand here collapsed them, which is why a gap made with
  // Enter came back a second later without one.
  const lines = src.map((line, i) => (verbatim[i] ? line : unescapeLine(line, src[i + 1] || '')));

  // mdast writes the shortest legal delimiter row, `| - |`. Every table in the vault is written
  // `| --- |` or `|---|`, and so is every table Obsidian makes, so a table the editor creates
  // should look like the ones around it (L20). Alignment colons are kept. Which rows are
  // delimiter rows is decided on the serializer's output, where a paragraph's pipes are still
  // escaped, and not on the cleaned lines, where `|:-|-:|` in a paragraph looks like one.
  widenDelimiters(lines, delimiterRows(src, verbatim, tree));
  return lines.join('\n');
}

/** The parser's tree of `text`, or null when there is no parser or it fails. */
function parseTree(text, mdast) {
  if (typeof mdast !== 'function') return null;
  try { return mdast(text) || null; } catch { return null; }
}

/** mdast nodes whose lines are not markdown. */
const VERBATIM_NODES = new Set(['code', 'math', 'mathBlock']);
/** Where an html node is a block of its own rather than a tag inside a paragraph. */
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/**
 * Which lines of `lines` belong to code, maths or block html: the line scan, plus every line
 * the parser says is one, wherever it sits (C9). A fence inside `> ` or under a nested list
 * item was invisible to the scan alone, and its backslashes were taken for escapes.
 */
function verbatimLines(lines, tree) {
  const out = verbatimByFence(lines);
  if (!tree) return out;
  const mark = (n) => {
    const p = n.position;
    if (!p || !p.start || !p.end) return;
    for (let l = p.start.line - 1; l <= p.end.line - 1 && l < out.length; l++) if (l >= 0) out[l] = true;
  };
  const walk = (n, parent) => {
    if (!n) return;
    if (VERBATIM_NODES.has(n.type)) mark(n);
    else if (n.type === 'html' && (!parent || BLOCK_PARENTS.has(parent.type))) mark(n);
    for (const c of n.children || []) walk(c, n);
  };
  walk(tree, null);
  return out;
}

/** The container markers at the start of a line: quote markers and list item markers. */
export const CONTAINER_PREFIX = /^(?:[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+))*[ \t]*/;

/**
 * The line scan: every fence and display formula, with the container markers in front of it
 * taken off first and any indent allowed. Generous on purpose: a line wrongly called code
 * keeps the serializer's escapes, which is always correct; a line of code wrongly called prose
 * loses backslashes that were the code's own (C9).
 */
export function verbatimByFence(lines: string[]): boolean[] {
  const out = new Array(lines.length).fill(false);
  let mark = '';
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i]).replace(CONTAINER_PREFIX, '');
    if (mark === '$') {
      out[i] = true;
      if (/\$\$[ \t]*$/.test(line)) mark = '';
      continue;
    }
    if (mark) {
      out[i] = true;
      const close = /^(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (close && close[0] === mark && close.length >= size) { mark = ''; size = 0; }
      continue;
    }
    const [, run = '', info = ''] = /^(`{3,}|~{3,})(.*)$/.exec(line) || [];
    // A backtick fence's info string cannot hold a backtick, so ```a``` is a code span.
    if (run && !(run[0] === '`' && info.includes('`'))) {
      out[i] = true;
      mark = run.charAt(0);
      size = run.length;
      continue;
    }
    if (!opensDisplay(line)) continue;
    out[i] = true;
    if (ONE_LINE_DISPLAY.test(line)) continue;           // opens and closes where it stands
    // Only a bare `$$` opens a formula that runs on: a line that merely starts with `$$` and
    // never closes would otherwise swallow the rest of the file.
    if (BARE_DISPLAY.test(line)) mark = '$';
  }
  return out;
}

/** The delimiter rows of the tables in the serializer's output, by line. */
function delimiterRows(src, verbatim, tree) {
  const rows: any[] = [];
  if (tree) {
    const walk = (n) => {
      if (!n) return;
      if (n.type === 'table' && n.position && n.position.start) rows.push(n.position.start.line);
      for (const c of n.children || []) walk(c);
    };
    walk(tree);
    return rows.filter((i) => i > 0 && i < src.length);
  }
  for (let i = 1; i < src.length; i++) {
    if (verbatim[i] || verbatim[i - 1]) continue;
    if (!isDelimiterRow(src[i]) || !isTableRow(src[i - 1])) continue;
    if (splitCells(src[i]).length !== splitCells(src[i - 1]).length) continue;
    rows.push(i);
  }
  return rows;
}

/** `| - | :- |` -> `| --- | :--- |`, in place, for the given delimiter rows. */
function widenDelimiters(lines, rows) {
  for (const i of rows) {
    lines[i] = lines[i].replace(/(\|\s*)(:?)-+(:?)(\s*(?=\|))/g, (_m, a, l, r, b) => a + l + '---' + r + b);
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
 *
 * This is the reconcile pass's scanner, which cuts the file into blocks and so has to agree
 * with the file's own column 0; the clean-up above uses the generous `verbatimByFence`.
 */
export function fenceTracker() {
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
export function verbatimRuns(runs) {
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
  (opensDisplay(line) ? 'D\0' : '')
  + lineRuns(line).filter((r) => r.kind === 'math').map((r) => line.slice(r.start, r.end)).join('\0');

/** A line as the table rules would see it with the table characters un-escaped. */
const tableBare = (l) => String(l).replace(/\\([|:-])/g, '$1');

/** Could this line, with its pipes un-escaped, be part of a table? Quoted or listed, too. */
function tableLike(line) {
  const bare = tableBare(line);
  const inner = bare.replace(CONTAINER_PREFIX, '');
  return isTableRow(bare) || isDelimiterRow(bare) || isTableRow(inner) || isDelimiterRow(inner);
}

/** Nothing but container markers so far: the next character starts a block. */
const atBlockStart = (out) => /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])?[ \t]*)*$/.test(out);

/**
 * Walk one line outside code spans and formulas and undo the over-escapes.
 * `nextLine` is the serializer's next line: when it could be a delimiter row, an unescaped `|`
 * here would turn this line into a table header.
 */
function unescapeLine(line, nextLine = '') {
  // Outside a table a `|` is an ordinary character, and the vault has them in prose and in
  // image widths (`![alt|420](x.png)`). remark escapes them anyway. Only where neither this
  // line nor the next could be read as a table once its pipes are bare (C8: `|:-|-:|` in a
  // paragraph under `| x |` was turned into the delimiter row of a table that was not there).
  const pipeSafe = !tableLike(line) && !isDelimiterRow(tableBare(nextLine).replace(CONTAINER_PREFIX, ''))
    && !isDelimiterRow(tableBare(nextLine));
  // A lone `~` cannot open strikethrough; mdast escapes it anyway. Only safe when the line
  // has no `~~` pair at all, so `~~struck~~` keeps its escapes.
  const tildeSafe = !/~~/.test(line.replace(/\\~/g, '~'));
  // `[` only opens a link when `](` or `][` follows it on the line. CommonMark allows no
  // space between the two, so `[cours] (Q1)` is plain text, not a link. The test is made on
  // the line as it will be, with the `(` or `[` after a `]` already bare (C8: `\[a]\(x)` was
  // taken for safe because of the backslash `linkParen` then removed, and became a link). A
  // line that starts `[label]:` would be a definition, and `[^` a footnote reference.
  const bracketSafe = !/\]\\?[([]/.test(line)
    && !(/^\\?\[/.test(line.replace(CONTAINER_PREFIX, '')) && /\\?\]:/.test(line))
    && !/\\?\[\^/.test(line);
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
      // never open or close emphasis: `100,000 * 100,000` needs no backslash. Not where a
      // block starts, where `* ` is a bullet.
      const loneStar = next === '*'
        && !atBlockStart(out)
        && /^\s*$/.test(out.slice(-1))
        && /^\s*$/.test(line[i + 2] || '');
      // `]\(` is the other half of `bracketSafe`: mdast escapes both brackets of a literal
      // `[text](url)` so it stays text, and un-escaping only the `[` leaves the stray
      // backslash of E22. When the `[` keeps its backslash the `(` cannot open anything.
      const linkParen = next === '(' && out.endsWith(']') && !bracketSafe;
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
    // A space the serializer had to write as a character reference. Hassan's files contain
    // real double spaces after a task box (`- [ ]  Home Rent: 500`), and there the space is
    // literal text either way. Anywhere else a leading space is dropped by the parser, and
    // four of them make an indented code block (C8), so the reference stays.
    if (ch === '&' && line.startsWith('&#x20;', i) && i + 6 < line.length && TASK_BOX.test(out)) {
      out += ' ';
      i += 6;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The start of a task item up to its box and the one space after it. */
const TASK_BOX = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]$/;
