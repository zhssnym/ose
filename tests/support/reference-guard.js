// A reference reading of the write guard (CONTRACT 7.1), for the tests to run against until
// src/editor/guard.ts lands. It is what the contract says, written the plainest way, over the
// engine's own parse and serialize: nothing here is clever, and nothing here is shipped.
//
// tests/support/pipeline.js hands out src/editor/guard.ts the moment it exists, and
// tests/serializer/landed.test.js fails until it does, so a green run never rests on this file.

/**
 * Attributes that carry no file content, the list CONTRACT 7.1 asks the real guard to name: what
 * the editor recomputes (a heading's id, an item's label and type, a list's looseness), what
 * says how a thing was spelled rather than what it is (an emphasis marker, a link's reference
 * form, a hard break's source form), and what markdown cannot write (cell spans and widths, an
 * image's ratio). The audit's fuzzer compared documents the same way.
 */
const NODE_NOISE = {
  heading: ['id'],
  hardbreak: ['isInline'],
  bullet_list: ['spread'],
  ordered_list: ['spread'],
  list_item: ['label', 'listType', 'spread'],
  table_header: ['colspan', 'rowspan', 'colwidth'],
  table_cell: ['colspan', 'rowspan', 'colwidth'],
  'image-block': ['ratio'],
};
const MARK_NOISE = {
  link: ['identifier', 'label', 'referenceType', 'refUrl'],
  emphasis: ['marker'],
  strong: ['marker'],
};

const without = (attrs, noise) => {
  const out = {};
  for (const k of Object.keys(attrs || {}).sort()) if (!(noise || []).includes(k)) out[k] = attrs[k] ?? null;
  return out;
};

/**
 * A copy of a node's JSON without the noise above, with neighbouring text runs whose marks agree
 * merged into one (`_a_*b*` is the same italic text as `*ab*`). A copy, because `Node.toJSON()`
 * hands out the node's own `attrs` object, and deleting from it would change the live document.
 * @param {any} json
 */
function strip(json) {
  const out = { type: json.type, attrs: without(json.attrs, NODE_NOISE[json.type]) };
  if (json.text !== undefined) out.text = json.text;
  if (json.marks) out.marks = json.marks.map((m) => ({ type: m.type, attrs: without(m.attrs, MARK_NOISE[m.type]) }));
  if (json.content) {
    out.content = [];
    for (const child of json.content.map(strip)) {
      const last = out.content.at(-1);
      if (last && last.text !== undefined && child.text !== undefined && JSON.stringify(last.marks) === JSON.stringify(child.marks)) last.text += child.text;
      else out.content.push(child);
    }
  }
  return out;
}

/**
 * Node.eq, ignoring the attributes in NODE_NOISE and MARK_NOISE.
 * @param {import('@milkdown/kit/prose/model').Node} a
 * @param {import('@milkdown/kit/prose/model').Node} b
 */
export function docsEqual(a, b) {
  if (a.eq(b)) return true;
  return JSON.stringify(strip(a.toJSON())) === JSON.stringify(strip(b.toJSON()));
}

/**
 * The text a save would write, checked against the document it claims to be. Never throws.
 * @param {{parse: Function, serialize: Function, canonicalise: Function, S: any}} engine
 * @param {import('@milkdown/kit/prose/model').Node} doc   the live document, without the pad
 * @param {string} original   the body on disk
 * @returns {{status:'ok'|'fellBack'|'unsafe', text:string|null, reason?:string}}
 */
export function checkWrite(engine, doc, original) {
  // The stringify module the stand-in engine was built from (tests/support/engine.js).
  const { postProcess, reconcile } = engine.S;
  const parsesTo = (text) => { try { return docsEqual(engine.parse(text), doc); } catch { return false; } };
  let raw;
  let canonical;
  try {
    raw = engine.serialize(doc);
    canonical = postProcess(raw);
  } catch (e) {
    return { status: 'unsafe', text: typeof raw === 'string' ? raw : null, reason: `serialize threw: ${e && e.message}` };
  }
  let why = 'reconciled text does not parse back to the document';
  if (original) {
    const cache = new Map();
    const canon = (md) => {
      let hit = cache.get(md);
      if (hit === undefined) { hit = engine.canonicalise(md); cache.set(md, hit); }
      return hit;
    };
    try {
      const candidate = reconcile(canonical, original, { canon });
      if (parsesTo(candidate)) return { status: 'ok', text: candidate };
    } catch (e) {
      why = `reconcile threw: ${e && e.message}`;
    }
  } else if (parsesTo(canonical)) {
    return { status: 'ok', text: canonical };
  }
  if (parsesTo(canonical)) return { status: 'fellBack', text: canonical, reason: why };
  if (parsesTo(raw)) return { status: 'fellBack', text: raw, reason: `${why}; post-processed text does not either` };
  return { status: 'unsafe', text: canonical, reason: 'no text parses back to the document' };
}

/**
 * Words of every literal in an mdast tree: text, code, maths, html and the urls and titles of
 * links, images and definitions. Enough to tell "the parser dropped something" from "the
 * parser read it differently".
 */
function words(tree) {
  const out = [];
  const visit = (n) => {
    for (const k of ['value', 'url', 'title', 'alt', 'label']) {
      if (typeof n[k] === 'string') out.push(...(n[k].match(/[\p{L}\p{N}]+/gu) || []));
    }
    if (n.children) n.children.forEach(visit);
  };
  visit(tree);
  return out;
}

/**
 * ok:false iff content present in `body` is absent from what the parser built. Never throws.
 * @param {{serialize: Function, mdast: Function}} engine
 * @param {string} body
 * @param {import('@milkdown/kit/prose/model').Node} doc
 * @returns {{ok:true} | {ok:false, reason:string, missing:string[]}}
 */
export function checkOpen(engine, body, doc) {
  try {
    const have = new Map();
    for (const w of words(engine.mdast(engine.serialize(doc)))) have.set(w, (have.get(w) || 0) + 1);
    const missing = [];
    for (const w of words(engine.mdast(body))) {
      const n = have.get(w) || 0;
      if (n > 0) have.set(w, n - 1); else missing.push(w);
    }
    return missing.length ? { ok: false, reason: `${missing.length} words the view does not hold`, missing } : { ok: true };
  } catch (e) {
    return { ok: false, reason: `check threw: ${e && e.message}`, missing: [] };
  }
}
