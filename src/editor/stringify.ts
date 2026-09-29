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
import { lineRuns, opensDisplay } from './math-rule.ts';
import { spaceJoin } from './space.ts';

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
  // What an empty paragraph costs in blank lines (space.ts). mdast reads `join` back to front,
  // so this one is asked before its own rules and nothing below it can widen a gap again.
  // `listAcrossSpace` only remembers and never answers, so it goes last and is asked first.
  join: [spaceJoin, listAcrossSpace],
};

// ---------------------------------------------------------------------------
// What one serialisation is for.
//
// A handler sees one mdast node and nothing of the page it belongs to, and two answers depend
// on the page: how this file spells a hard break (M6), and which link definitions the document
// still holds (M8). Both are set around a serialisation by `withSerializeContext` and read here.
// Serialising is synchronous, so a plain module variable, restored in a `finally`, is enough.

/** a hard break as the file writes it */
export type LineBreak = '\n'|'  \n'|'\\\n';

let context: { lineBreak: LineBreak; defs: Set<string> | null; } = { lineBreak: '\n', defs: null };

/** A link or definition label the way markdown matches it: case and inner whitespace ignored. */
export const labelKey = (s) => String(s ?? '').replace(/[\t\n\r ]+/g, ' ').trim().toLowerCase();

/** The definitions a document holds, by `labelKey`. */
function definitionsOf(doc) {
  const set = new Set<any>();
  try {
    doc.descendants((n) => {
      if (n.type.name === 'definition') set.add(labelKey(n.attrs.identifier || n.attrs.label));
      return true;
    });
  } catch { return null; }
  return set;
}

/**
 * Run `fn` with a serialisation context and restore the previous one after it.
 *
 *   lineBreak  how a hard break is written (`detectLineBreak` of the file on disk)
 *   scope      the document whose link definitions count: the page being written. It wins
 *              over any `doc` further in, so a block serialised on its own for the reconcile
 *              pass still sees the definitions of the whole page.
 *   doc        the document being serialised: its definitions count when no scope is set
 */
export function withSerializeContext<T>(over: { lineBreak?: LineBreak; scope?: any; doc?: any; }, fn: () => T): T {
  const was = context;
  const next = { ...was };
  if (over && over.lineBreak) next.lineBreak = over.lineBreak;
  if (over && over.scope) next.defs = definitionsOf(over.scope);
  else if (over && over.doc && !was.defs) next.defs = definitionsOf(over.doc);
  context = next;
  try { return fn(); } finally { context = was; }
}

/**
 * Does a reference link to `identifier` still have its definition in the document being
 * written? True when nobody said which document that is, which is the old behaviour.
 */
export function definitionInScope(identifier: string) {
  return !context.defs || context.defs.has(labelKey(identifier));
}

/** A string that changes whenever the context would change what a serialisation writes. */
export function serializeContextKey() {
  return `${JSON.stringify(context.lineBreak)}\0${context.defs ? [...context.defs].sort().join('\u0001') : '*'}`;
}

/**
 * How this file writes a hard break (M6): a bare newline (Hassan's files, and the default),
 * two trailing spaces, or a trailing backslash. Whichever the file uses most, outside code;
 * a file with no hard break at all gets the default. It is only ever style: the write guard
 * (guard.ts) proves that what is written reads back the same either way.
 *
 * `detectLineBreak.current()` is the spelling in force in the current serialisation.
 */
export function detectLineBreak(text: string): LineBreak {
  const lines = String(text ?? '').split('\n');
  const inCode = verbatimByFence(lines);
  let spaces = 0;
  let slash = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (inCode[i] || inCode[i + 1]) continue;
    const line = (lines[i] ?? '').replace(/\r$/, '');
    const next = (lines[i + 1] ?? '').replace(/\r$/, '');
    if (!next.trim() || !line.trim()) continue;
    if (/^\s*(?:>[ \t]?)*\s*(?:#{1,6}[ \t]|\|)/.test(line) || isTableRow(line)) continue;
    if (/\S[ \t]*$/.test(line) && / {2,}$/.test(line)) spaces++;
    else if (/(?:^|[^\\])(?:\\\\)*\\$/.test(line)) slash++;
  }
  if (!spaces && !slash) return '\n';
  return spaces >= slash ? '  \n' : '\\\n';
}
detectLineBreak.current = () => context.lineBreak;

/**
 * The mdast handlers we replace (D7, E33, L17, M3; M6; H3).
 *
 * A hard break. `mdast-util-to-markdown` writes `\` and a newline; the vault writes a bare
 * newline in a paragraph and a literal `<br>` in a cell, like Obsidian, and a file that writes
 * two spaces or a backslash keeps its own spelling (M6, `detectLineBreak`). The matching read is
 * already there: `remarkLineBreak` turns a soft newline inside a paragraph into a hard break,
 * and a `<br>` in a cell is an inline html node.
 *
 * Emphasis and strong: see `attention`.
 */
function HANDLERS() {
  return {
    break: writeBreak,
    text: writeText,
    emphasis: (node, _parent, state, info) => attention(node, state, info, 'emphasis', 1),
    strong: (node, _parent, state, info) => attention(node, state, info, 'strong', 2),
  };
}

/**
 * Text (L1, C8). Milkdown's handler writes any text that ends in whitespace and holds no `*`,
 * `_` or `\` exactly as it is, unescaped: a paragraph that is only `- ` came back as an empty
 * list, `# ` as an empty heading, and `[x](y) ` before a bold word as a link. Its reason was
 * the trailing space, which the escaper would otherwise write as `&#x20;` at the end of a line.
 * So the text is escaped like any other, and spaces that end a line are left off: the parser
 * drops them on the way back in, which is what markdown does with them anyway, and the guard
 * compares documents without them (guard.ts). A two-space hard break is the break's to write
 * (`writeBreak`), and a line the user did not touch keeps its own bytes (`reconcile`).
 */
function writeText(node, _parent, state, info) {
  const value = String(node.value ?? '');
  const endsLine = !info.after || info.after[0] === '\n' || info.after[0] === '\r';
  const tail = endsLine ? (/[ \t]+$/.exec(value) || [''])[0] : '';
  const core = value.slice(0, value.length - tail.length);
  if (!core) return tail ? '' : value;
  return state.safe(core, { ...info, after: tail ? '\n' : info.after, encode: [] as any[] });
}

/**
 * Two lists of the same kind with nothing but space between them (space.ts: an empty paragraph
 * the user left there) are two lists only if their markers differ: blank lines alone do not end
 * a list, and the second one was read back as more items of the first. mdast alternates the
 * marker of adjacent lists (`bulletOther`), but an empty paragraph between them resets what it
 * remembers. So the marker a list used is remembered here, and handed back to the list after
 * the space. A `join` rule, because that is the one hook mdast calls between two siblings; it
 * never answers anything itself.
 */
const LIST_BULLET = new WeakMap();
function listAcrossSpace(left, right, parent, state) {
  if (left && left.type === 'list' && state.bulletLastUsed) LIST_BULLET.set(left, state.bulletLastUsed);
  if (!right || right.type !== 'list' || !isEmptyParagraph(left) || !parent || !parent.children) return undefined;
  const kids = parent.children;
  let k = kids.indexOf(right) - 1;
  while (k >= 0 && isEmptyParagraph(kids[k])) k--;
  const before = kids[k];
  if (before && before.type === 'list' && !!before.ordered === !!right.ordered && LIST_BULLET.has(before)) {
    state.bulletLastUsed = LIST_BULLET.get(before);
  }
  return undefined;
}

const isEmptyParagraph = (n) => !!n && n.type === 'paragraph' && !(n.children && n.children.length);

const isBreak = (n) => !!n && n.type === 'break';
/** Text of spaces and tabs only: at the end of a line the parser drops it. */
const isBlankText = (n) => !!n && n.type === 'text' && /^[ \t]*$/.test(String(n.value ?? ''));
/** Nothing the rest of a line can hold: breaks and blank text. */
const isBlankInline = (n) => isBreak(n) || isBlankText(n);

/**
 * One hard break. `data.isInline` marks a break that was a plain newline in the file
 * (`remarkLineBreak`): it is written as one again, whatever the file's style for the others.
 *
 * Three places where a newline cannot say "break":
 *   - at the end of a paragraph, where markdown drops it. The break has nothing after it and
 *     nothing to write; the guard compares documents without trailing breaks (guard.ts).
 *   - at the start of a paragraph, or right after another break, where a bare newline would be
 *     a blank line and end the paragraph. `\` and a newline is a break anywhere a line can end.
 *   - in a table cell or an ATX heading, which are one line: `<br>`, as Obsidian writes it.
 */
function writeBreak(node, parent, state) {
  const kids = (parent && parent.children) || [];
  const at = kids.indexOf(node);
  if (at >= 0 && kids.slice(at + 1).every(isBlankInline)) return '';
  if (state.stack.includes('tableCell') || state.stack.includes('headingAtx')) return '<br>';
  // What is on this line before the break: nothing, or only spaces, which the line loses.
  let k = at - 1;
  while (k >= 0 && isBlankText(kids[k])) k--;
  if (k < 0 || isBreak(kids[k])) return '\\\n';
  if (node.data && node.data.isInline) return '\n';
  return context.lineBreak || '\n';
}

// A character as CommonMark's flanking rules see it: whitespace (a line boundary counts), a
// punctuation mark or symbol, or anything else, which is a letter.
const WHITESPACE = 1;
const PUNCTUATION = 2;
function classify(code) {
  if (Number.isNaN(code) || code === undefined) return WHITESPACE;
  const ch = String.fromCharCode(code);
  if (/\s/.test(ch)) return WHITESPACE;
  if (/[\p{P}\p{S}]/u.test(ch)) return PUNCTUATION;
  return undefined;
}

/**
 * Which side of a delimiter run has to be written as a character reference for it to open or
 * close where it stands. `mdast-util-to-markdown`'s own `encodeInfo`, rule for rule.
 */
function encodeInfo(outside, inside, marker) {
  const o = classify(outside);
  const i = classify(inside);
  if (o === undefined) {
    if (i === undefined) return marker === '_' ? { inside: true, outside: true } : { inside: false, outside: false };
    return i === WHITESPACE ? { inside: true, outside: true } : { inside: false, outside: true };
  }
  if (o === WHITESPACE) {
    return i === WHITESPACE ? { inside: true, outside: true } : { inside: false, outside: false };
  }
  return i === WHITESPACE ? { inside: true, outside: false } : { inside: false, outside: false };
}

const charRef = (code) => `&#x${code.toString(16).toUpperCase()};`;

/**
 * Emphasis and strong (H3). Milkdown's handlers write the node's own marker, or the default,
 * and nothing else: an `_x_` that touches a letter (`a_l_pha`, `_em_Q`, Ctrl+I in the middle
 * of a word) is not emphasis in CommonMark, and came back from the next save as literal
 * underscores. This is the stock handler of `mdast-util-to-markdown`, which knows the flanking
 * rules, with one choice added: the marker stays the file's (`node.marker`, else the default),
 * unless it is `_` and `_` cannot open or close there, in which case it is `*`, which can.
 * Where even `*` cannot (whitespace just inside the mark), the character is written as a
 * reference, exactly as the stock handler does.
 */
function attention(node, state, info, name, width) {
  const preferred = node.marker || (name === 'strong' ? state.options.strong : state.options.emphasis) || '*';
  const tryWith = (marker) => {
    const exit = state.enter(name);
    const tracker = state.createTracker(info);
    const open = marker.repeat(width);
    const before = tracker.move(open);
    let between = tracker.move(state.containerPhrasing(node, { after: marker, before, ...tracker.current() }));
    exit();
    return { marker, open, between, tracker };
  };
  const outsideBefore = info.before.charCodeAt(info.before.length - 1);
  const outsideAfter = info.after.charCodeAt(0);
  const encodes = (r) => {
    if (!r.between) return false;
    const o = encodeInfo(outsideBefore, r.between.charCodeAt(0), r.marker);
    const c = encodeInfo(outsideAfter, r.between.charCodeAt(r.between.length - 1), r.marker);
    return o.inside || o.outside || c.inside || c.outside;
  };
  let r = tryWith(preferred);
  // Nothing inside: bold on nothing but spaces, which Milkdown has already moved outside the
  // mark. An empty `****` would be read back as four asterisks of text, so nothing is written.
  if (!r.between) { state.attentionEncodeSurroundingInfo = undefined; return ''; }
  if (preferred === '_' && encodes(r)) r = tryWith('*');
  let { between } = r;
  let o = { inside: false, outside: false };
  let c = { inside: false, outside: false };
  if (between) {
    o = encodeInfo(outsideBefore, between.charCodeAt(0), r.marker);
    if (o.inside) between = charRef(between.charCodeAt(0)) + between.slice(1);
    c = encodeInfo(outsideAfter, between.charCodeAt(between.length - 1), r.marker);
    if (c.inside) between = between.slice(0, -1) + charRef(between.charCodeAt(between.length - 1));
  }
  r.tracker.move(r.open);
  state.attentionEncodeSurroundingInfo = { after: c.outside, before: o.outside };
  return r.open + between + r.open;
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
    // of join rules and Milkdown puts its own in each. Ours for emphasis and strong replace
    // Milkdown's (H3) and still write the marker each node was read with, which is what keeps
    // the vault's mix of `_x_` and `*x*` as it was written.
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
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+))*[ \t]*/;

/**
 * The line scan: every fence and display formula, with the container markers in front of it
 * taken off first and any indent allowed. Generous on purpose: a line wrongly called code
 * keeps the serializer's escapes, which is always correct; a line of code wrongly called prose
 * loses backslashes that were the code's own (C9).
 */
function verbatimByFence(lines: string[]): boolean[] {
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
function units(text) {
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

function reconcileBlocks(out, original, rawCanon) {
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
function restoreLinesIn(next, prev) {
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
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const inFence = fence(line);
    if (f) { style.fence = f.charAt(0); continue; }
    if (inFence) continue;
    // A frame is `>>` in this vault and `> >` in remark's output (M25). The file decides.
    const quote = QUOTE_RUN.exec(line)?.[2];
    if (quote && !seenQuote && (quote.match(/>/g) || []).length > 1) {
      style.quote = /^>>/.test(quote) ? '>>' : '> >';
      seenQuote = true;
    }
    const rule = /^\s{0,3}((?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.exec(line)?.[1];
    if (rule) { style.rule = rule.trimEnd(); continue; }
    const [, lead = '', marker = ''] = /^([ \t]*)([-*+]|\d+[.)])[ \t]/.exec(line) || [];
    if (!marker) continue;
    if (/[-*+]/.test(marker) && !seenBullet) { style.bullet = marker; seenBullet = true; }
    if (/\d/.test(marker)) style.ordered = marker.slice(-1);
    if (lead && !seenIndent) { style.indent = lead.replace(/\t/g, '    ').length; seenIndent = true; }
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
    // Two lists side by side are told apart by their markers alone: remark writes the second one
    // with `bulletOther` (`*`) or `)`. Where the file's own marker is that other one, the two
    // trade places, so the lists stay two lists instead of both becoming the file's marker.
    if (style.bullet !== '-') {
      out = out.replace(/^([ \t]*)([-*])([ \t])/, (_m, ind, b, sp) =>
        `${ind}${b === '-' ? style.bullet : (style.bullet === '*' ? '-' : b)}${sp}`);
    }
    if (style.ordered !== '.') {
      out = out.replace(/^([ \t]*\d+)([.)])([ \t])/, (_m, n, d, sp) => `${n}${d === '.' ? style.ordered : '.'}${sp}`);
    }
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
  const blocks: any[] = [];
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
  const rows: any[] = [];
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
    if (!A || !B) continue;
    if (tableSignature(a.lines, A.start, A.end) !== tableSignature(b.lines, B.start, B.end)) continue;
    lines.splice(A.start, A.end - A.start + 1, ...b.lines.slice(B.start, B.end + 1));
    changed = true;
  }
  return changed ? lines.join('\n') : out;
}
