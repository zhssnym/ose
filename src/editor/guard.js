// The write guard (C8) and the open-time loss check (C10).
//
// Everything the serializer and the reconcile pass do to a page is a heuristic, and a heuristic
// is not allowed to decide what goes to disk. The guard is: a text is written only when reading
// it back gives the document that is on screen. Not the canonical text of that document, which
// has been through the same clean-up as the candidate and so agrees with it by construction (the
// circular check batch 9 had), but the ProseMirror document itself, node for node, compared with
// what the parser builds from the text about to be written.
//
// The other direction is `checkOpen`. The parser does not refuse what the schema cannot hold: it
// logs and moves on, and the block is gone from the document before anyone sees it. A save would
// then write the file without it. So at open the page asks whether everything the file says made
// it into the document, and opens the file as text when it did not.
//
// No DOM, no view, no `ose:*`: this file takes an engine (engine.js, or crepe.js `engineOf`) and
// works on strings and ProseMirror nodes only.

import { detectLineBreak, postProcess, reconcile, serializeContextKey, withSerializeContext } from './stringify.js';
import { htmlEndsBlock, unmarkBreaks } from './fidelity.js';

/**
 * @typedef {object} MdEngine
 * @property {(md: string) => import('@milkdown/kit/prose/model').Node} parse
 * @property {(doc: import('@milkdown/kit/prose/model').Node) => string} serialize  raw serializer output
 * @property {(md: string) => any} [mdast]  the parser's tree of `md`, before its transformers; used
 *   to keep code and maths out of the clean-up and to count what the file says at open
 */

/**
 * @typedef {{status:'ok', text:string}
 *   | {status:'fellBack', text:string, reason:string}
 *   | {status:'unsafe', text:string|null, reason:string}} WriteCheck
 */

/** @typedef {{ok:true} | {ok:false, reason:string, missing:string[]}} OpenCheck */

const msg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);

// ---------------------------------------------------------------------------
// canonical text, memoised per engine

const CANON_CACHE = new WeakMap();
const CANON_MAX = 8000;

/**
 * Parse a markdown string and serialise it straight back, cleaned up the way a save is.
 *
 * @param {MdEngine} engine
 * @param {string} md
 * @returns {string}
 */
export function canonicalise(engine, md) {
  return postProcess(engine.serialize(engine.parse(md)), { mdast: engine.mdast });
}

/**
 * `canonicalise` for the reconcile pass, which asks it for every block of the file on disk: so
 * it is memoised per engine, keyed by the text and by what the serialisation context would
 * change about the answer (stringify.js `serializeContextKey`: the file's hard-break spelling
 * and the link definitions of the page). `clean: false` is the serializer's own output, for
 * reconciling that when the clean-up is what went wrong.
 */
function memo(engine, clean = true) {
  let cache = CANON_CACHE.get(engine);
  if (!cache) { cache = new Map(); CANON_CACHE.set(engine, cache); }
  return (md) => {
    const key = `${clean ? 'c' : 'r'}\0${serializeContextKey()}\0${md}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const raw = engine.serialize(engine.parse(md));
    const out = clean ? postProcess(raw, { mdast: engine.mdast }) : raw;
    if (cache.size >= CANON_MAX) cache.clear();
    cache.set(key, out);
    return out;
  };
}

// ---------------------------------------------------------------------------
// the write guard

/**
 * What to write for `doc`, and whether it is safe to. Never throws.
 *
 * `doc` is the live document without the landing pad (space.js), `original` the body on disk.
 * The texts are tried in order, and the first one that parses back to `doc` wins:
 *
 *   1. the reconciled candidate: the canonical text with every untouched block put back as the
 *      file wrote it. That is `ok`.
 *   2. the same, reconciled from the serializer's own output instead of the cleaned-up text:
 *      the clean-up is a set of heuristics (stringify.js `postProcess`) and the one thing that
 *      can be wrong in the edited block. Untouched blocks keep their bytes, so this is `ok` too.
 *   3. the canonical text: the meaning is exact, but untouched blocks may be restyled. That is
 *      `fellBack`, and `reason` says which step failed.
 *   4. the serializer's raw output, before the clean-up: `fellBack` as well.
 *
 * When none of them does, or serialising throws, the answer is `unsafe` and its `text` is the
 * best effort (the canonical text, else the raw one, else null). An `unsafe` text is never
 * written; the page opens it as text for the user to check.
 *
 * @param {MdEngine} engine
 * @param {import('@milkdown/kit/prose/model').Node} doc
 * @param {string} original
 * @returns {WriteCheck}
 */
export function checkWrite(engine, doc, original) {
  try {
    const lineBreak = detectLineBreak(original || '');
    // An html block always ends its paragraph (H2, fidelity.js): text typed beside one is
    // written as the paragraph of its own the editor already shows it in. And a hard break
    // carries no mark, which it could not show anyway (fidelity.js `unmarkBreaks`).
    const target = unmarkBreaks(htmlEndsBlock(doc));
    return withSerializeContext({ lineBreak, scope: target }, () => decide(engine, target, original));
  } catch (e) {
    return { status: 'unsafe', text: null, reason: `the guard failed: ${msg(e)}` };
  }
}

function decide(engine, doc, original) {
  // Nothing but empty paragraphs: an empty page. A file of blank lines already is one and keeps
  // its bytes; any other becomes empty, which is what reading it back gives, save after save.
  if (docShape(doc) === `${doc.type.name}{}`) {
    const text = /^\s*$/.test(original || '') ? (original || '') : '';
    try { if (docsEqual(engine.parse(text), doc)) return { status: 'ok', text }; } catch { /* go on */ }
  }
  let raw;
  try { raw = engine.serialize(doc); } catch (e) {
    return { status: 'unsafe', text: null, reason: `serialising failed: ${msg(e)}` };
  }
  const why = [];
  const tried = new Map();
  const passes = (text) => {
    if (!tried.has(text)) {
      let ok = false;
      try { ok = docsEqual(engine.parse(text), doc); } catch { ok = false; }
      tried.set(text, ok);
    }
    return tried.get(text);
  };
  const reconciled = (text, clean) => {
    try { return reconcile(text, original, { canon: memo(engine, clean) }); } catch (e) {
      why.push(`reconcile failed: ${msg(e)}`);
      return null;
    }
  };

  let canonical = null;
  try { canonical = postProcess(raw, { mdast: engine.mdast }); } catch (e) { why.push(`the clean-up failed: ${msg(e)}`); }

  if (canonical !== null) {
    const candidate = original ? reconciled(canonical, true) : canonical;
    if (candidate === canonical && !why.length && passes(canonical)) return { status: 'ok', text: canonical };
    if (candidate !== null && candidate !== canonical) {
      if (passes(candidate)) return { status: 'ok', text: candidate };
      why.push('the reconciled text reads back differently');
    }
  }
  if (original && raw !== canonical) {
    const candidate = reconciled(raw, false);
    if (candidate !== null && candidate !== raw && passes(candidate)) return { status: 'ok', text: candidate };
  }
  if (canonical !== null) {
    if (passes(canonical)) return { status: 'fellBack', text: canonical, reason: why.join('; ') || 'the reconciled text reads back differently' };
    why.push('the canonical text reads back differently');
  }
  if (raw !== canonical && passes(raw)) return { status: 'fellBack', text: raw, reason: why.join('; ') };
  why.push('the serializer output reads back differently');
  return { status: 'unsafe', text: canonical ?? raw, reason: why.join('; ') };
}

/**
 * What a save of `md` writes, as a string: the editor opening `md` and writing it back unchanged,
 * reconciled against `original` (the file on disk; `md` itself by default). The harness asks this.
 * An `unsafe` answer gives the best effort, which the page would never write.
 *
 * @param {MdEngine} engine
 * @param {string} md
 * @param {string} [original]
 * @returns {string}
 */
export function roundTrip(engine, md, original = md) {
  const r = checkWrite(engine, engine.parse(md), original);
  return r.text ?? '';
}

// ---------------------------------------------------------------------------
// comparing two documents

/**
 * Attributes that carry no file content: they are recomputed by the editor (a heading's id, a
 * list item's label and type), describe the spelling rather than the meaning (an emphasis
 * marker, the reference form of a link, a hard break's source form, list looseness), or cannot
 * be written in markdown at all (a table cell's spans and widths, an image block's ratio).
 */
const IGNORED_NODE_ATTRS = {
  heading: ['id'],
  hardbreak: ['isInline'],
  bullet_list: ['spread'],
  ordered_list: ['spread'],
  list_item: ['label', 'listType', 'spread'],
  table_header: ['colspan', 'rowspan', 'colwidth'],
  table_cell: ['colspan', 'rowspan', 'colwidth'],
  'image-block': ['ratio'],
};
const IGNORED_MARK_ATTRS = {
  link: ['identifier', 'label', 'referenceType', 'refUrl'],
  emphasis: ['marker'],
  strong: ['marker'],
};

function attrsKey(attrs, ignored) {
  const keys = Object.keys(attrs || {}).filter((k) => !(ignored && ignored.includes(k))).sort();
  if (!keys.length) return '';
  return JSON.stringify(keys.map((k) => [k, attrs[k] ?? null]));
}

const markKey = (marks) =>
  marks.map((m) => m.type.name + attrsKey(m.attrs, IGNORED_MARK_ATTRS[m.type.name])).join('+');

/** Footnote labels match case-insensitively, the way markdown matches them. */
const label = (s) => String(s ?? '').toLowerCase();

function footnoteLabels(doc) {
  const set = new Set();
  doc.descendants((n) => {
    if (n.type.name === 'footnote_definition') set.add(label(n.attrs.label));
    return true;
  });
  return set;
}

/**
 * A node as a string that is equal for two nodes exactly when they hold the same file content.
 * Inline content is compared as runs of text with their marks, merged where the marks agree once
 * the ignored attributes are gone: `_a_*b*` and `*ab*` are the same italic text.
 *
 * A footnote reference whose definition is not in the document is written `[^1]` and read back
 * as that text, which is the only thing a file can say about it; it is compared as that text.
 */
function shape(node, notes, cell = false) {
  const name = node.type.name;
  if (isBr(node)) return 'br';
  let out = name + attrsKey(node.attrs, IGNORED_NODE_ATTRS[name]);
  if (!node.childCount) return out;
  if (node.inlineContent) {
    const runs = inline(node, notes, cell);
    // Nothing left that the file can hold: the same as an empty block (a paragraph holding a
    // space, or a break, is written as the blank line an empty paragraph is).
    return runs.length ? `${out}[${runs.join(',')}]` : out;
  }
  if (name === 'table') return `${out}{${tableRows(node, notes).join(',')}}`;
  const kids = [];
  const inCell = name === 'table_cell' || name === 'table_header';
  node.forEach((child) => kids.push(shape(child, notes, inCell)));
  // A document of nothing but empty paragraphs is an empty file, however many there are: there
  // is no block for the blank lines to sit between (space.js).
  if (node.type === node.type.schema.topNodeType && kids.every((k) => k === 'paragraph')) return `${out}{}`;
  return `${out}{${kids.join(',')}}`;
}

/**
 * A table's rows, the way the file can hold them. Two things about a table have no spelling:
 *   - rows of different lengths: the delimiter row says how many columns there are, and the
 *     serializer pads the short rows with empty cells;
 *   - an alignment per cell: markdown aligns a column, and the serializer writes the header
 *     row's (@milkdown/preset-gfm), which every cell of the column reads back.
 * Compared padded and aligned by column.
 */
function tableRows(table, notes) {
  let width = 0;
  table.forEach((row) => { width = Math.max(width, row.childCount); });
  const header = table.firstChild;
  const align = [];
  for (let c = 0; c < width; c++) align.push(header && c < header.childCount ? header.child(c).attrs.alignment ?? null : null);
  const rows = [];
  table.forEach((row, _o, i) => {
    const cells = [];
    row.forEach((cell, _p, c) => {
      const attrs = { ...cell.attrs, alignment: align[c] };
      const kids = [];
      cell.forEach((child) => kids.push(shape(child, notes, true)));
      cells.push(`${cell.type.name}${attrsKey(attrs, IGNORED_NODE_ATTRS[cell.type.name])}{${kids.join(',')}}`);
    });
    const type = row.childCount ? row.child(0).type.name : (i === 0 ? 'table_header' : 'table_cell');
    for (let c = row.childCount; c < width; c++) {
      cells.push(`${type}${attrsKey({ alignment: align[c] }, IGNORED_NODE_ATTRS[type])}{paragraph}`);
    }
    rows.push(`${row.type.name}${attrsKey(row.attrs, IGNORED_NODE_ATTRS[row.type.name])}{${cells.join(',')}}`);
  });
  return rows;
}

/** Marks that hold code: their spaces are the code's own. */
const CODE_MARKS = new Set(['inlineCode', 'code_inline', 'code']);

/**
 * The inline content of one textblock as a list of runs, in the shape the file can say it.
 *
 * Three kinds of whitespace have no spelling in markdown, and the serializer does not try:
 *   - a hard break with nothing after it in its block (stringify.js `writeBreak`). It is what
 *     the caret leaves for an instant between Shift+Enter and the next key;
 *   - spaces and tabs at the end of a line, before a break or the end of the block, which the
 *     parser drops (stringify.js `writeText`). Typing "word " and pausing leaves one;
 *   - spaces at the edge of a bold, italic, struck or linked run, which Milkdown's serializer
 *     moves outside the mark (@milkdown/transformer `moveSpaces`), so `**e **x` is written
 *     `**e** x`. Code keeps its spaces.
 * They are compared the way the file will hold them.
 */
function inline(node, notes, cell = false) {
  let end = node.childCount;
  while (end > 0 && node.child(end - 1).type.name === 'hardbreak') end--;

  // The children as pieces: text with one set of marks (adjacent text nodes with the same marks
  // taken together, which is how the file holds them), or a node of its own. Adjacent inline
  // html is one piece too: `<!-- a --><!-- b -->` is two nodes on screen when two html blocks
  // were merged, and one node when read back, and the file holds the same bytes either way.
  /** @type {Array<{text?: string, marks?: readonly any[], html?: string, node?: any}>} */
  const pieces = [];
  for (let i = 0; i < end; i++) {
    const child = node.child(i);
    const last = pieces[pieces.length - 1];
    let t = null;
    if (child.isText) t = child.text;
    else if (child.type.name === 'footnote_reference' && !notes.has(label(child.attrs.label))) t = `[^${child.attrs.label}]`;
    if (t !== null) {
      if (last && last.text !== undefined && sameMarks(last.marks, child.marks)) last.text += t;
      else pieces.push({ text: t, marks: child.marks });
      continue;
    }
    if (child.type.name === 'html' && !isBr(child)) {
      const value = String(child.attrs.value ?? '');
      if (last && last.html !== undefined && sameMarks(last.marks, child.marks)) last.html += value;
      else pieces.push({ html: value, marks: child.marks });
      continue;
    }
    pieces.push({ node: child });
  }

  /** @type {Array<{text?: string, marks?: string, shape?: string}>} */
  const items = [];
  const pushText = (text, marks) => {
    if (!text) return;
    const last = items[items.length - 1];
    if (last && last.text !== undefined && last.marks === marks) last.text += text;
    else items.push({ text, marks });
  };
  for (const p of pieces) {
    if (p.node) {
      // A code mark on a node that is not text cannot be written (fidelity.js `extendInlineCode`).
      const kept = isBr(p.node) ? [] : p.node.marks.filter((m) => !CODE_MARKS.has(m.type.name));
      items.push({ shape: shape(p.node, notes) + (kept.length ? `@${markKey(kept)}` : '') });
      continue;
    }
    if (p.html !== undefined) {
      items.push({ shape: `html${JSON.stringify(p.html)}${p.marks.length ? `@${markKey(p.marks)}` : ''}` });
      continue;
    }
    // A bare url is a link in GFM (autolink literal): typed as text, it reads back as a link to
    // itself, which is what the file says and what every renderer shows.
    const marks = markKey(p.marks.filter((m) => !(m.type.name === 'link' && autolinks(p.text, m.attrs.href))));
    const t = p.text;
    if (!marks || p.marks.some((m) => CODE_MARKS.has(m.type.name))) { pushText(t, marks); continue; }
    const lead = t.startsWith(' ') ? /^\s+/.exec(t)[0] : '';
    const rest = t.slice(lead.length);
    const trail = rest.endsWith(' ') ? /\s+$/.exec(rest)[0] : '';
    pushText(lead, '');
    pushText(rest.slice(0, rest.length - trail.length), marks);
    pushText(trail, '');
  }
  // A table cell is trimmed by the parser at both ends, the start included.
  if (cell && items.length && items[0].text !== undefined) {
    items[0].text = items[0].text.replace(/^[ \t]+/, '');
  }
  const runs = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.shape !== undefined) { runs.push(it.shape); continue; }
    const next = items[i + 1];
    const endsLine = !next || next.shape === 'br';
    const text = endsLine ? it.text.replace(/[ \t]+$/, '') : it.text;
    if (text) runs.push(`${JSON.stringify(text)}${it.marks ? `@${it.marks}` : ''}`);
  }
  return runs;
}

/** Two mark sets are the same set. */
const sameMarks = (a, b) => a.length === b.length && a.every((m, i) => m.eq(b[i]));

/** Is a link with this text and target what GFM makes of the bare text on its own? */
const autolinks = (text, href) => !!text && (href === text || href === `mailto:${text}` || href === `http://${text}`);

/**
 * A hard break, or an inline `<br>`: the same thing said two ways. A break typed in a table
 * cell or a heading, which are one line each, is written `<br>` (stringify.js) and read back
 * as the html node it then is.
 */
const isBr = (node) => node.type.name === 'hardbreak'
  || (node.type.name === 'html' && node.isInline && /^<br\s*\/?>$/i.test(String(node.attrs.value ?? '').trim()));

/** Both documents as the strings `docsEqual` compares. For a reason, and for tests. */
export function docShape(doc) {
  // Taken as the file will hold it: an html block in a paragraph of its own (H2, fidelity.js).
  const d = htmlEndsBlock(doc);
  return shape(d, footnoteLabels(d));
}

/**
 * `Node.eq`, ignoring the attributes that carry no file content:
 *
 *   heading `id`, hard break `isInline`, list `spread`, list item `label`, `listType` and
 *   `spread`, table cell `colspan`, `rowspan` and `colwidth`, image block `ratio`; on marks, the
 *   emphasis and strong `marker` and the link's `identifier`, `label`, `referenceType` and
 *   `refUrl` (the reference form: the link's target and title are compared).
 *
 * Adjacent text is compared as one run where its marks agree, and a footnote reference with no
 * definition in its document is compared as the text `[^label]`.
 *
 * And compared the way a file can hold them, which is the whole list of what markdown cannot
 * say and the serializer therefore does not try to:
 *   - a hard break and an inline `<br>` are one thing; a break that ends its block is nothing;
 *   - spaces and tabs at the end of a line are nothing, and spaces at the edge of a bold,
 *     italic, struck or linked run sit outside it (Milkdown moves them there); code keeps its;
 *   - a link whose text is its own url is that bare url (a GFM autolink);
 *   - adjacent inline html is one piece of html;
 *   - a table cell has no leading spaces, a table's rows are as long as its longest and each
 *     cell has its column's alignment;
 *   - a paragraph with nothing left is empty, and a document of empty paragraphs is empty;
 *   - an html block that would open a block where it stands has its paragraph to itself
 *     (fidelity.js `htmlEndsBlock`).
 * None of them loses or changes a word or a mark on a word. The last one moves words into a
 * paragraph of their own, and the editor makes the same move on screen as they are typed
 * (blocks.js `htmlBlockPlugin`), so the page and the file agree.
 *
 * @param {import('@milkdown/kit/prose/model').Node} a
 * @param {import('@milkdown/kit/prose/model').Node} b
 * @returns {boolean}
 */
export function docsEqual(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return docShape(a) === docShape(b);
}

// ---------------------------------------------------------------------------
// the open-time loss check

/** mdast node types whose value is text the document has to hold. */
const MD_TEXT = new Set(['text', 'inlineCode', 'code', 'html', 'inlineMath', 'mathBlock']);

function mdText(tree) {
  let s = '';
  const walk = (n) => {
    if (!n) return;
    if (MD_TEXT.has(n.type) && typeof n.value === 'string') s += n.value;
    if (n.type === 'image' || n.type === 'imageReference') s += '';   // an image's alt is an attribute
    for (const c of n.children || []) walk(c);
  };
  walk(tree);
  return s;
}

function pmText(doc) {
  let s = '';
  doc.descendants((n) => {
    if (n.isText) s += n.text;
    else if (n.type.name === 'html' || n.type.name === 'math_inline' || n.type.name === 'math_block') s += String(n.attrs.value ?? '');
    return true;
  });
  return s;
}

const squash = (s) => s.replace(/\s+/g, '');

/** What of `want` is not in `have`, as a few short snippets: the leftmost alignment. */
function missingRuns(want, have) {
  const runs = [];
  let j = 0;
  let cur = '';
  for (let i = 0; i < want.length; i++) {
    if (j < have.length && want[i] === have[j]) {
      if (cur) { runs.push(cur); cur = ''; }
      j++;
    } else cur += want[i];
  }
  if (cur) runs.push(cur);
  return runs.slice(0, 5).map((r) => (r.length > 60 ? `${r.slice(0, 57)}...` : r));
}

/**
 * Parse `md` and collect what the parser refused. Milkdown's parser does not throw when the
 * schema cannot hold a node: it logs the error and drops the node (@milkdown/transformer,
 * `createNodeInParserFail`, `parserMatchError`). The log is the only trace, so it is listened to
 * for the length of one synchronous parse.
 */
function parseRefusals(engine, md) {
  const refused = [];
  const log = console.error;
  console.error = (...args) => {
    const e = args.find((a) => a && typeof a === 'object' && 'code' in a);
    if (e) refused.push(String(e.code));
    else log.apply(console, args);
  };
  try { engine.parse(md); } finally { console.error = log; }
  return refused;
}

/**
 * Did the parser keep everything `body` says? Never throws: a check that fails to run answers
 * `ok:false`, because a page the check could not vouch for is safer open as text.
 *
 * Two signals, either of which is enough: the parser logged that it dropped a node, or text the
 * file holds (prose, code, html, formulas) is not in the document. Whitespace is not compared,
 * because where it goes is the serializer's business and not content.
 *
 * @param {MdEngine} engine
 * @param {string} body   the markdown the document was built from
 * @param {import('@milkdown/kit/prose/model').Node} doc   the document the editor holds
 * @returns {OpenCheck}
 */
export function checkOpen(engine, body, doc) {
  try {
    const md = String(body ?? '');
    const refused = parseRefusals(engine, md);
    let missing = [];
    if (typeof engine.mdast === 'function') {
      const want = squash(mdText(engine.mdast(md)));
      const have = squash(pmText(doc));
      if (want !== have) missing = missingRuns(want, have);
    }
    if (!refused.length && !missing.length) return { ok: true };
    const reason = refused.length
      ? `the parser dropped ${refused.length === 1 ? 'a block' : `${refused.length} blocks`} it cannot hold`
      : 'some of the text is not in the rich view';
    return { ok: false, reason, missing };
  } catch (e) {
    return { ok: false, reason: `the check failed: ${msg(e)}`, missing: [] };
  }
}
