// Part of the serializer (../stringify.ts). The options remark writes with, its handlers, and what
// one serialisation is for: the line break and the definitions in scope.

import { remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { remarkGFMPlugin } from '@milkdown/kit/preset/gfm';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { spaceJoin } from '../space.ts';
import { verbatimByFence } from './cleanup.ts';
import { isTableRow } from './tables.ts';

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
 *
 * A list item: the box of an empty task item, see `writeListItem`.
 */
function HANDLERS() {
  return {
    break: writeBreak,
    text: writeText,
    listItem: writeListItem,
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

/**
 * remark-gfm's own `listItem` handler, the one that writes the task box. mdast applies the
 * settings' handlers after the extensions' (mdast-util-to-markdown `configure`), so ours stands
 * in its place and hands over to it; nothing of the box rule is copied here.
 */
const gfmListItem = (gfmToMarkdown().extensions || [])
  .map((ext) => ext.handlers && ext.handlers.listItem)
  .find((handler) => typeof handler === 'function');

/**
 * One list item: the box of a task item goes only where the file can hold it.
 *
 * GFM gives an empty task item no spelling. `- [ ]` with nothing after it is the text `[ ]`
 * (micromark-extension-gfm-task-list-item: the box has to be followed by a space and then
 * something, and the end of the item is not something), and remark-gfm's handler knows it:
 * for an item whose paragraph is empty it writes a bare `-`, which is an empty plain item.
 * When a nested list follows that empty paragraph it does worse, and puts the box on the line
 * after the bullet (`-\n[ ]   - sub`), where it is text in a paragraph of its own. Either way
 * the text read back differently from the document, and Enter at the end of a checklist
 * followed by a pause of a second (the autosave) put the page in Source under the banner.
 *
 * So an item whose own paragraph writes nothing is written without its box, bare `-` and its
 * content under it, which is the one way markdown can hold it, and the guard does not compare
 * the box of such an item (guard.ts `shape`). Typed into, the item is written as a task again.
 */
function writeListItem(node, parent, state, info) {
  if (!gfmListItem) throw new Error('remark-gfm has no listItem handler');
  const head = node.children && node.children[0];
  const boxless = typeof node.checked === 'boolean' && !!head && head.type === 'paragraph'
    && (head.children || []).every(isBlankInline);
  if (!boxless) return gfmListItem(node, parent, state, info);
  // The node itself goes to the handler, not a copy: an ordered item is numbered by its index
  // among its siblings. The tree is the serializer's own, built for this one write.
  const was = node.checked;
  node.checked = null;
  try { return gfmListItem(node, parent, state, info); } finally { node.checked = was; }
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
