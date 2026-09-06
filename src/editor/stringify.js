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
};

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
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...STRINGIFY_OPTIONS }));
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

  // 1. An empty document serialises as a single `<br />` (one empty paragraph). An empty file
  //    must stay an empty file.
  if (out.trim() === '<br />') return '';

  // 2. Milkdown's image-block node keeps the aspect ratio in the markdown `alt` slot
  //    (`![1.00](x.png)`). That is a Milkdown-ism, not markdown; strip it so the files stay
  //    portable. Cost: alt text on a block image is not round-tripped. See the report.
  out = out.replace(/!\[\d+\.\d{2}\]\(/g, '![](');

  const src = out.split('\n');
  const lines = [];
  const fence = fenceTracker();
  let dropped = false;
  for (let i = 0; i < src.length; i++) {
    if (fence(src[i])) { lines.push(src[i]); continue; }

    // 3. Any empty block serialises as `<br />`: an empty paragraph of its own, or an empty
    //    table cell. Neither belongs in a markdown file. Removing the paragraph also removes
    //    the blank line that separated it from the next block, so no gap is left behind.
    if (/^\s*<br \/>\s*$/.test(src[i])) { dropped = true; continue; }
    let line = src[i];
    if (isTableRow(line)) line = line.replace(/(\|\s*)<br \/>(\s*(?=\|))/g, '$1$2');

    line = unescapeLine(line);
    if (!line.trim()) {
      if (dropped) { dropped = false; continue; }
      if (lines.length && !lines[lines.length - 1].trim()) continue;
    } else {
      dropped = false;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Stateful fence detector: true for a fence marker line and for every line inside a fence. */
function fenceTracker() {
  let inFence = false;
  let mark = '';
  return (line) => {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!inFence) { inFence = true; mark = m[1][0]; return true; }
      if (m[1][0] === mark) { inFence = false; mark = ''; return true; }
    }
    return inFence;
  };
}

/** Walk one line outside code spans and undo the over-escapes. */
function unescapeLine(line) {
  // A lone `~` cannot open strikethrough; mdast escapes it anyway. Only safe when the line
  // has no `~~` pair at all, so `~~struck~~` keeps its escapes.
  const tildeSafe = !/~~/.test(line.replace(/\\~/g, '~'));
  // `[` only opens a link when `](` or `][` follows it on the line. CommonMark allows no
  // space between the two, so `[cours] (Q1)` is plain text, not a link.
  const bracketSafe = !/\][([]/.test(line);

  let out = '';
  let i = 0;
  let inCode = false;
  let codeTicks = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '`') {
      let n = 0;
      while (line[i + n] === '`') n++;
      if (!inCode) { inCode = true; codeTicks = n; }
      else if (n === codeTicks) { inCode = false; codeTicks = 0; }
      out += line.slice(i, i + n);
      i += n;
      continue;
    }
    if (!inCode && ch === '\\' && i + 1 < line.length) {
      const next = line[i + 1];
      // A `*` with whitespace on both sides is neither left- nor right-flanking, so it can
      // never open or close emphasis: `100,000 * 100,000` needs no backslash.
      const loneStar = next === '*'
        && /^\s*$/.test(out.slice(-1))
        && /^\s*$/.test(line[i + 2] || '');
      if ((next === '~' && tildeSafe) || (next === '[' && bracketSafe) || loneStar) out += next;
      else out += ch + next;
      i += 2;
      continue;
    }
    // A leading space inside a block is written as a character reference. Hassan's files
    // contain real double spaces (`- [ ]  Home Rent: 500`); keep them literal.
    if (!inCode && ch === '&' && line.startsWith('&#x20;', i) && i + 6 < line.length) {
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
const lineKey = (l) =>
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
 * @param {boolean} [opt.lines=true] also restore lines that differ only in escaping or spacing
 * @returns {string} a candidate the caller must verify by re-parsing
 */
export function reconcile(out, original, opt = {}) {
  if (!original) return out;
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
// Tables.
//
// remark rewrites every table into one canonical shape. The vault uses several (`|---|---|`,
// `| --- | --- |`, `| - | - |`, padded columns), so a page edited anywhere would have all of
// its tables reflowed. Any table whose cell content came back unchanged is put back exactly as
// it was written; a table the user actually edited no longer matches and gets the canonical
// shape, which is the right trade.

const isTableRow = (l) => /^\s*\|/.test(l);
const isDelimiterRow = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(l);

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
