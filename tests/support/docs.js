// Small helpers over ProseMirror documents and files for the serialiser tests: where a block
// ends, how to type into it, and the "untouched blocks keep their bytes" reading.

import { Transform } from '@milkdown/kit/prose/transform';
import { parseDoc } from '../../src/editor/doc.ts';

/** Every top-level block with its offset and index. */
export function tops(doc) {
  const a = [];
  doc.forEach((node, offset, index) => a.push({ node, offset, index }));
  return a;
}

/** The position at the end of the last textblock inside top-level block `i` (null if none). */
export function endOfBlock(doc, i) {
  const t = tops(doc)[i];
  if (!t) return null;
  if (t.node.isTextblock) return t.offset + 1 + t.node.content.size;
  let p = null;
  t.node.descendants((n, pos) => { if (n.isTextblock) p = t.offset + 1 + pos + 1 + n.content.size; return true; });
  return p;
}

/** The position at the end of the last textblock of the document that is not code. */
export function lastTextEnd(doc) {
  let last = null;
  doc.descendants((n, pos) => { if (n.isTextblock && n.type.name !== 'code_block') last = pos + 1 + n.content.size; return true; });
  return last;
}

/** `doc` with `text` typed at `pos`. */
export function typeAt(doc, pos, text) {
  return new Transform(doc).insert(pos, doc.type.schema.text(text)).doc;
}

/** A paragraph node holding `text` (or empty). */
export function para(schema, text) {
  return schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
}

/** `doc` with a new paragraph inserted before top-level block `i`. */
export function insertParaAt(doc, i, text) {
  const t = tops(doc)[i];
  return new Transform(doc).insert(t ? t.offset : doc.content.size, para(doc.type.schema, text)).doc;
}

/** The body the page edits (the file without its frontmatter and title strip), as the page reads it. */
export function bodyOf(file) {
  return parseDoc(file).body;
}

/** The code or maths text of the first code block or maths block in `doc`, or null. */
export function codeOf(doc) {
  let out = null;
  doc.descendants((n) => {
    if (out !== null) return false;
    if (n.type.name === 'code_block') out = n.textContent;
    else if (n.type.name === 'math_block') out = String(n.attrs.value ?? n.textContent);
    return true;
  });
  return out;
}

/** True when some text in `doc` carries a mark named `name`. */
export function hasMark(doc, name) {
  let found = false;
  doc.descendants((n) => { if (n.marks.some((m) => m.type.name === name)) found = true; return !found; });
  return found;
}

const LISTS = new Set(['bullet_list', 'ordered_list']);

/**
 * Is block `i` of the edited document excused from keeping its bytes? Only where markdown itself
 * leaves no choice: two lists of the same kind side by side must be told apart (a different
 * marker), and a thematic break next to changed text can be read as a setext underline, so
 * either may have to be spelled differently once a neighbour moved. Every other untouched
 * block keeps its bytes, the block after an insertion at the top included (C11).
 */
function excused(doc, origin, i) {
  const node = doc.child(i);
  const moved = (j) => j < 0 || j >= origin.length || origin[j] === null
    || origin[j] !== origin[i] + (j - i);
  const neighbourMoved = moved(i - 1) || moved(i + 1);
  if (!neighbourMoved) return false;
  if (node.type.name === 'hr') return true;
  if (LISTS.has(node.type.name)) {
    for (const j of [i - 1, i + 1]) {
      if (j >= 0 && j < doc.childCount && doc.child(j).type === node.type) return true;
    }
  }
  return false;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does this block of the file hold a reference link (`[text][id]`, `[id]`) whose definition is
 * not in the written text any more? Then it is written inline, `[text](url)`, by design (M8):
 * a reference with no definition would stop being a link.
 */
function lostDefinition(node, text) {
  const ids = [];
  const walk = (n) => {
    if (n.type === 'linkReference' || n.type === 'imageReference') ids.push(n.label || n.identifier);
    if (n.children) n.children.forEach(walk);
  };
  walk(node);
  return ids.some((id) => !new RegExp(`^ {0,3}\\[${escapeRe(String(id))}\\]:`, 'im').test(text));
}

/**
 * The untouched blocks whose source bytes are not in `text`, in order. `origin[i]` is the index
 * of the block of the file that block `i` of `doc` still is, byte for byte, or null
 * (tests/support/edits.js); `tree` is the mdast of `body`, whose top-level children are the
 * file's blocks when their count matches the parsed document's.
 * @returns {string[]} the missing slices (empty when every untouched block kept its bytes)
 */
export function untouchedMissing(body, tree, origin, doc, text) {
  const missing = [];
  let cur = 0;
  for (let i = 0; i < origin.length; i++) {
    const o = origin[i];
    if (o == null || excused(doc, origin, i)) continue;
    const child = tree.children[o];
    if (child && lostDefinition(child, text)) continue;
    const p = child && child.position;
    if (!p) continue;
    const src = body.slice(p.start.offset, p.end.offset);
    const at = text.indexOf(src, cur);
    if (at < 0) { missing.push(src); continue; }
    cur = at + src.length;
  }
  return missing;
}
