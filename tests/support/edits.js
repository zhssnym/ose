// Structural edits on a ProseMirror document, the shapes of the audit's round-trip fuzzer
// (work/audit/roundtrip/fuzz.mjs): typing, deleting blocks, splitting and joining, wrapping,
// marks, tasks, select-all-and-type. Every edit is a real Transform, so the document it
// answers is one the editor could hold.
//
// Each edit also keeps `origin`: for every top-level block of the current document, the index
// of the block of the file it still is byte for byte, or null once it was typed in, moved,
// split, joined or inserted. That is what the "untouched blocks keep their bytes" property
// reads after a whole sequence of edits.

import { Transform } from '@milkdown/kit/prose/transform';

/** Text a user types, chosen to hit the escaping and the inline rules. */
export const TYPED = [
  'zz', ' *', '_', '$', '5 $ and 10 $', '#', '# x', '|', 'a|b', '[x]', '[x](y)', '`', '<b>', '&amp;',
  'AT&T', '\\', '~', '~~s~~', '1. ', '- ', '> ', '    ', '  two  spaces', '---', '***', '<!-- c -->',
  '[[wiki]]', 'http://x.y', '*a*', '**b**', 'x y', '\t', '!', '=', '+ ', '1)',
];

/**
 * A source of choices in [0, 1) from a list of integers (fast-check's), reused in a cycle, so
 * a shrunk list is still a valid run.
 * @param {number[]} nums
 */
export function chooser(nums) {
  let i = 0;
  const next = () => (nums.length ? (nums[i++ % nums.length] >>> 0) / 4294967296 : 0);
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (a) => a[Math.floor(next() * a.length)],
  };
}

const range = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };
const tops = (doc) => { const a = []; doc.forEach((node, offset, index) => a.push({ node, offset, index })); return a; };

/** Every textblock in `node` (not code), with the position of its content in the document. */
function textblocksIn(node, base) {
  const out = [];
  if (node.isTextblock) { if (node.type.name !== 'code_block') out.push({ n: node, pos: base + 1 }); return out; }
  node.descendants((n, pos) => { if (n.isTextblock && n.type.name !== 'code_block') out.push({ n, pos: base + 1 + pos + 1 }); return true; });
  return out;
}

function topIndexAt(doc, pos) {
  let idx = -1;
  doc.forEach((n, off, i) => { if (pos >= off && pos < off + n.nodeSize) idx = i; });
  return idx;
}

/**
 * The edits. Each takes (doc, schema, c) and answers null when it does not apply, or
 * `{ tr, map }` where `map(origin)` gives the new origin list from the old one.
 */
export const EDITS = {
  delLast(doc) {
    const T = tops(doc); if (T.length < 2) return null;
    const b = T.at(-1);
    return { tr: new Transform(doc).delete(b.offset, b.offset + b.node.nodeSize), map: (o) => o.slice(0, -1) };
  },
  delFirst(doc) {
    const T = tops(doc); if (T.length < 2) return null;
    return { tr: new Transform(doc).delete(0, T[0].node.nodeSize), map: (o) => o.slice(1) };
  },
  delRandom(doc, _s, c) {
    const T = tops(doc); if (T.length < 2) return null;
    const b = c.pick(T);
    return { tr: new Transform(doc).delete(b.offset, b.offset + b.node.nodeSize), map: (o) => o.filter((_, i) => i !== b.index) };
  },
  typeEnd(doc, s, c) {
    const b = c.pick(tops(doc)); const tb = textblocksIn(b.node, b.offset); if (!tb.length) return null;
    const t = c.pick(tb);
    return { tr: new Transform(doc).insert(t.pos + t.n.content.size, s.text(c.pick(TYPED))), map: touch([b.index]) };
  },
  typeMiddle(doc, s, c) {
    const b = c.pick(tops(doc)); const tb = textblocksIn(b.node, b.offset); if (!tb.length) return null;
    const t = c.pick(tb);
    return { tr: new Transform(doc).insert(t.pos + c.int(t.n.content.size + 1), s.text(c.pick(TYPED))), map: touch([b.index]) };
  },
  typeLastBlock(doc, s) {
    const b = tops(doc).at(-1); const tb = textblocksIn(b.node, b.offset); if (!tb.length) return null;
    const t = tb.at(-1);
    return { tr: new Transform(doc).insert(t.pos + t.n.content.size, s.text(' zz')), map: touch([b.index]) };
  },
  insertParaEnd(doc, s) {
    return { tr: new Transform(doc).insert(doc.content.size, para(s, 'new para')), map: (o) => [...o, null] };
  },
  insertParaAt(doc, s, c) {
    const b = c.pick(tops(doc));
    return { tr: new Transform(doc).insert(b.offset, para(s, 'inserted')), map: insertAt(b.index) };
  },
  insertParaTop(doc, s) {
    return { tr: new Transform(doc).insert(0, para(s, 'New first line')), map: insertAt(0) };
  },
  insertEmptyAt(doc, s, c) {
    const b = c.pick(tops(doc));
    return { tr: new Transform(doc).insert(b.offset, para(s, '')), map: insertAt(b.index) };
  },
  insertEmptyEnd(doc, s) {
    return { tr: new Transform(doc).insert(doc.content.size, para(s, '')), map: (o) => [...o, null] };
  },
  duplicate(doc, _s, c) {
    const b = c.pick(tops(doc));
    return { tr: new Transform(doc).insert(b.offset + b.node.nodeSize, b.node), map: insertAt(b.index + 1) };
  },
  swap(doc, _s, c) {
    const T = tops(doc); if (T.length < 2) return null;
    const i = c.int(T.length - 1); const a = T[i]; const b = T[i + 1];
    const tr = new Transform(doc).delete(b.offset, b.offset + b.node.nodeSize).insert(a.offset, b.node);
    return { tr, map: touch([i, i + 1]) };
  },
  split(doc, _s, c) {
    const T = tops(doc).filter((x) => x.node.type.name === 'paragraph' && x.node.content.size > 1); if (!T.length) return null;
    const b = c.pick(T);
    const at = b.offset + 1 + 1 + c.int(b.node.content.size - 1);
    return { tr: new Transform(doc).split(at), map: (o) => { const n = o.slice(); n.splice(b.index, 1, null, null); return n; } };
  },
  merge(doc, _s, c) {
    const T = tops(doc); const cand = [];
    for (let i = 0; i + 1 < T.length; i++) if (T[i].node.type.name === 'paragraph' && T[i + 1].node.type.name === 'paragraph') cand.push(i);
    if (!cand.length) return null;
    const i = c.pick(cand);
    return { tr: new Transform(doc).join(T[i + 1].offset), map: (o) => { const n = o.slice(); n.splice(i, 2, null); return n; } };
  },
  paraToList(doc, s, c) {
    const T = tops(doc).filter((x) => x.node.type.name === 'paragraph' && x.node.content.size); if (!T.length) return null;
    const b = c.pick(T);
    const ul = s.nodes.bullet_list.create(null, s.nodes.list_item.create(null, b.node));
    return { tr: new Transform(doc).replaceWith(b.offset, b.offset + b.node.nodeSize, ul), map: touch([b.index]) };
  },
  crossDelete(doc, _s, c) {
    const T = tops(doc); if (T.length < 3) return null;
    const i = c.int(T.length - 1); const j = i + 1 + c.int(Math.min(3, T.length - i - 1));
    const a = textblocksIn(T[i].node, T[i].offset); const b = textblocksIn(T[j].node, T[j].offset);
    if (!a.length || !b.length) return null;
    const ta = a.at(-1); const tb = b[0];
    const from = ta.pos + c.int(ta.n.content.size + 1); const to = tb.pos + c.int(tb.n.content.size + 1);
    return { tr: new Transform(doc).delete(from, to), map: rebuild };
  },
  editThenDeleteRest(doc, s, c) {
    const T = tops(doc); if (T.length < 2) return null;
    const i = c.int(T.length - 1); const a = textblocksIn(T[i].node, T[i].offset); if (!a.length) return null;
    const t = a.at(-1);
    const tr = new Transform(doc).delete(T[i + 1].offset, doc.content.size);
    tr.insert(t.pos + t.n.content.size, s.text(' zz'));
    return { tr, map: (o) => [...o.slice(0, i), null] };
  },
  deleteTail(doc, _s, c) {
    const T = tops(doc); if (T.length < 3) return null;
    const i = 1 + c.int(T.length - 2);
    return { tr: new Transform(doc).delete(T[i].offset, doc.content.size), map: rebuild };
  },
  deleteAll(doc, s) {
    return { tr: new Transform(doc).replaceWith(0, doc.content.size, para(s, '')), map: () => [null] };
  },
  replaceAll(doc, s) {
    return { tr: new Transform(doc).replaceWith(0, doc.content.size, para(s, 'only this')), map: () => [null] };
  },
  toggleTask(doc, _s, c) {
    const cand = [];
    doc.descendants((n, pos) => { if (n.type.name === 'list_item' && n.attrs.checked != null) cand.push({ n, pos }); return true; });
    if (!cand.length) return null;
    const t = c.pick(cand);
    return { tr: new Transform(doc).setNodeMarkup(t.pos, null, { ...t.n.attrs, checked: !t.n.attrs.checked }), map: touch([topIndexAt(doc, t.pos)]) };
  },
  addMark(doc, s, c) {
    const b = c.pick(tops(doc)); const tb = textblocksIn(b.node, b.offset).filter((x) => x.n.content.size > 3); if (!tb.length) return null;
    const t = c.pick(tb); const from = t.pos + c.int(t.n.content.size - 2);
    const m = c.pick([s.marks.strong, s.marks.emphasis, s.marks.inlineCode].filter(Boolean));
    return { tr: new Transform(doc).addMark(from, from + 2, m.create()), map: touch([b.index]) };
  },
  wrapQuote(doc, s, c) {
    const T = tops(doc).filter((x) => x.node.type.name === 'paragraph' && x.node.content.size); if (!T.length) return null;
    const b = c.pick(T);
    return { tr: new Transform(doc).replaceWith(b.offset, b.offset + b.node.nodeSize, s.nodes.blockquote.create(null, b.node)), map: touch([b.index]) };
  },
  headingToPara(doc, s, c) {
    const T = tops(doc).filter((x) => x.node.type.name === 'heading'); if (!T.length) return null;
    const b = c.pick(T);
    return { tr: new Transform(doc).setNodeMarkup(b.offset, s.nodes.paragraph, {}), map: touch([b.index]) };
  },
  paraToHeading(doc, s, c) {
    const T = tops(doc).filter((x) => x.node.type.name === 'paragraph' && x.node.content.size); if (!T.length) return null;
    const b = c.pick(T);
    return { tr: new Transform(doc).setNodeMarkup(b.offset, s.nodes.heading, { level: 2 }), map: touch([b.index]) };
  },
};

export const EDIT_NAMES = Object.keys(EDITS);

const para = (s, t) => s.nodes.paragraph.create(null, t ? s.text(t) : null);
const touch = (idx) => (o) => o.map((v, i) => (idx.includes(i) ? null : v));
const insertAt = (i) => (o) => { const n = o.slice(); n.splice(i, 0, null); return n; };
/** The edit reached across blocks in a way not worth tracking: nothing is still untouched. */
const rebuild = () => null;

/**
 * Apply a sequence of edits. A step that does not apply to the document, or whose Transform
 * refuses (an invalid split or join), is skipped, as a keystroke that does nothing would be.
 * @param {import('@milkdown/kit/prose/model').Node} doc
 * @param {Array<{ name: string, nums: number[] }>} steps
 * @returns {{ doc: any, origin: Array<number|null> | null, applied: string[] }}
 */
export function applyEdits(doc, steps) {
  const schema = doc.type.schema;
  let origin = range(0, doc.childCount - 1);
  const applied = [];
  for (const step of steps) {
    const c = chooser(step.nums);
    let r;
    try { r = EDITS[step.name](doc, schema, c); } catch { r = null; }
    if (!r) continue;
    doc = r.tr.doc;
    origin = origin && r.map(origin);
    if (origin && origin.length !== doc.childCount) origin = null;
    applied.push(step.name);
  }
  return { doc, origin, applied };
}

export { tops, textblocksIn };
