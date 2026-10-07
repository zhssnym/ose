// The schema the files need, as opposed to the schema the editor needs.
//
// Milkdown's commonmark preset throws away three things on the way in, and no amount of work
// on the way out can put them back: the part of a fence's info string after the language, the
// `<br>` in the middle of a paragraph, and a reference link with its definition. Each one is a
// construct the vault is allowed to contain and the editor is not allowed to delete, so each
// one gets what it needs here — an attribute, a plugin left out, a node — and nothing else.
//
// Everything in this file is registered from engine.ts `configureMarkdown`, before `create()`,
// which the page (crepe.ts) and the headless engine both run. Two more live here that are not
// losses at parse time but at write time: the hard break (M6) and the dead reference (M8).

import { codeBlockSchema, hardbreakSchema, inlineCodeSchema, linkAttr, linkSchema, sanitizeLinkHref } from '@milkdown/kit/preset/commonmark';
import { Transform } from '@milkdown/kit/prose/transform';
import { $nodeSchema, $remark } from '@milkdown/kit/utils';
import { definitionInScope } from './stringify.ts';

/**
 * M13. A fence is written ```` ```js title="a.js" {1,3} ````; mdast splits that into `lang`
 * ("js") and `meta` (the rest), and Milkdown reads only the first and writes only the first,
 * so the rest is gone after one save. `meta` becomes an attribute that rides along untouched.
 * The language picker in code.ts sets `language` and never looks at `meta`, so it is unaffected.
 */
export function extendCodeBlock(ctx) {
  ctx.update(codeBlockSchema.key, (prev) => (c) => {
    const base = prev(c);
    return {
      ...base,
      attrs: { ...base.attrs, meta: { default: '', validate: 'string' } },
      parseMarkdown: {
        match: ({ type }) => type === 'code',
        runner: (state, node, type) => {
          state.openNode(type, { language: node.lang ?? '', meta: node.meta ?? '' });
          if (node.value) state.addText(node.value);
          state.closeNode();
        },
      },
      toMarkdown: {
        match: (node) => node.type.name === 'code_block',
        runner: (state, node) => {
          state.addNode('code', undefined, node.content.firstChild?.text || '', {
            lang: node.attrs.language,
            meta: node.attrs.meta || null,
          });
        },
      },
    };
  });
}

/**
 * M6. A hard break goes to the serializer as a break node whatever it was in the file, with
 * `data.isInline` saying it was a plain newline there (`remarkLineBreak`). Milkdown writes
 * that kind as a newline in a text node, where no handler sees it: two in a row were a blank
 * line and ended the paragraph, and one at the end of a paragraph was a blank line of space.
 * stringify.ts `writeBreak` spells both kinds, in the file's own style.
 */
export function extendHardbreak(ctx) {
  ctx.update(hardbreakSchema.key, (prev) => (c) => {
    const base = prev(c);
    return {
      ...base,
      toMarkdown: {
        match: (node) => node.type.name === 'hardbreak',
        runner: (state, node) => {
          state.addNode('break', undefined, undefined, node.attrs.isInline ? { data: { isInline: true } } : {});
        },
      },
    };
  });
}

/**
 * A `<br>` in a table cell is the cell's line break: one line of a table cannot hold a newline,
 * so Obsidian and the serializer (`writeBreak`) spell it `<br>`. Read back it was an inline html
 * node, shown as the literal tag. It becomes the hard break it stands for, and the write gives
 * `<br>` again (`<br/>` and `<br />` come back as `<br>` once the table is edited).
 */
export const remarkCellBreaks = $remark('os-cell-breaks', () => () => (tree) => {
  walk(tree, (n) => {
    if (n.type !== 'tableCell') return;
    n.children = n.children.map((c) => (c.type === 'html' && /^<br\s*\/?>$/i.test(c.value) ? { type: 'break', position: c.position } : c));
  });
});

/**
 * A code mark on something that is not text (a hard break inside a range made code with the
 * toolbar, a formula, an image). Milkdown writes it as an empty code span in place of the node,
 * so the break was lost and two stray backticks were written. A code span can only hold text:
 * the mark is left off everything else, which is then written on its own.
 */
export function extendInlineCode(ctx) {
  ctx.update(inlineCodeSchema.key, (prev) => (c) => {
    const base = prev(c);
    return {
      ...base,
      toMarkdown: {
        match: (mark) => mark.type.name === 'inlineCode',
        runner: (state, mark, node) => {
          if (!node.isText) return false;
          state.withMark(mark, 'inlineCode', node.text || '');
          return true;
        },
      },
    };
  });
}

/**
 * M11. A link definition — `[docs]: https://example.com "title"` — is a block of its own in
 * markdown and has no counterpart in the editor: there is nothing to show and nothing to edit.
 * It is kept as an atom that renders as the line it came from, in the muted mono the rest of
 * the chrome uses, and writes back exactly what it read. Without it the definition has no node
 * to become and the whole document fails to parse; with it, and with `remark-inline-links`
 * left out, a reference link and its definition both survive a save.
 */
export const definitionSchema = $nodeSchema('definition', () => ({
  atom: true,
  group: 'block',
  defining: true,
  selectable: true,
  attrs: {
    identifier: { default: '', validate: 'string' },
    label: { default: '', validate: 'string' },
    url: { default: '', validate: 'string' },
    title: { default: null },
  },
  parseDOM: [{
    tag: 'div[data-type="definition"]',
    getAttrs: (dom) => ({
      identifier: dom.dataset.identifier ?? '',
      label: dom.dataset.label ?? '',
      url: dom.dataset.url ?? '',
      title: dom.dataset.title || null,
    }),
  }],
  toDOM: (node) => [
    'div',
    {
      'data-type': 'definition',
      'data-identifier': node.attrs.identifier,
      'data-label': node.attrs.label,
      'data-url': node.attrs.url,
      'data-title': node.attrs.title ?? '',
      class: 'md-definition',
    },
    definitionText(node.attrs),
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'definition',
    runner: (state, node, type) => {
      state.addNode(type, {
        identifier: node.identifier ?? '',
        label: node.label ?? node.identifier ?? '',
        url: node.url ?? '',
        title: node.title ?? null,
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'definition',
    runner: (state, node) => {
      state.addNode('definition', undefined, undefined, {
        identifier: node.attrs.identifier,
        label: node.attrs.label,
        url: node.attrs.url,
        title: node.attrs.title ?? null,
      });
    },
  },
}));

const definitionText = (a) =>
  `[${a.label || a.identifier}]: ${a.url}${a.title ? ` "${a.title}"` : ''}`;

// ---------------------------------------------------------------------------
// Reference links (M11).

/** Depth-first walk over an mdast tree. Eight lines, so no new dependency for it. */
function walk(node, fn) {
  fn(node);
  for (const child of node.children || []) walk(child, fn);
}

/**
 * Two jobs, both at parse time, before anything becomes a ProseMirror document.
 *
 * A reference link carries only an identifier, so give it the url its definition names: the
 * link is then clickable and the tooltip has something to show, while the identifier rides
 * along so the serialiser can write the reference form back.
 *
 * An image reference gets no such treatment. There is no image-reference node in the editor
 * and the vault contains none, so it is inlined the way `remark-inline-links` used to inline
 * everything — a rewrite, but of one construct nobody has, rather than a parse that throws.
 */
export const remarkResolveReferences = $remark('os-resolve-references', () => () => (tree) => {
  const defs = new Map();
  walk(tree, (n) => { if (n.type === 'definition' && n.identifier) defs.set(n.identifier, n); });
  if (!defs.size) return;
  walk(tree, (n) => {
    if (n.type !== 'linkReference' && n.type !== 'imageReference') return;
    const def = defs.get(n.identifier);
    if (!def) return;
    n.url = def.url;
    n.title = def.title ?? null;
    if (n.type === 'imageReference') {
      n.type = 'image';
      n.alt = n.alt ?? '';
      delete n.identifier;
      delete n.label;
      delete n.referenceType;
    }
  });
});

/**
 * The link mark learns the reference form. `identifier`, `label` and `referenceType` are what
 * `[text][docs]`, `[docs][]` and `[docs]` differ by, and they are written back exactly.
 *
 * `refUrl` is what the definition said when the file was read, and a link only goes back as a
 * reference while `href` still equals it. Edit the target in the link tooltip and the two part
 * company, so the link is written as an ordinary inline one — the user's edit lands in the file
 * instead of being quietly dropped on the way out.
 *
 * The same happens when the definition itself is gone from the page (M8). `[docs][d]` with no
 * `[d]: …` anywhere is not a link at all: it reads back as the brackets, and the url is lost.
 * Which definitions the page still holds is the serialisation's context (stringify.ts).
 */
export function extendLink(ctx) {
  ctx.update(linkSchema.key, (prev) => (c) => {
    const base = prev(c);
    return {
      ...base,
      attrs: {
        ...base.attrs,
        identifier: { default: '', validate: 'string' },
        label: { default: '', validate: 'string' },
        referenceType: { default: '', validate: 'string' },
        refUrl: { default: '', validate: 'string' },
      },
      toDOM: (mark) => ['a', {
        ...c.get(linkAttr.key)(mark),
        title: mark.attrs.title,
        href: sanitizeLinkHref(mark.attrs.href),
      }],
      parseMarkdown: {
        match: (node) => node.type === 'link' || node.type === 'linkReference',
        runner: (state, node, markType) => {
          state.openMark(markType, {
            href: node.url ?? '',
            title: node.title ?? null,
            identifier: node.identifier ?? '',
            label: node.label ?? '',
            referenceType: node.referenceType ?? '',
            refUrl: node.type === 'linkReference' ? (node.url ?? '') : '',
          });
          state.next(node.children);
          state.closeMark(markType);
        },
      },
      toMarkdown: {
        match: (mark) => mark.type.name === 'link',
        runner: (state, mark) => {
          const { identifier, label, referenceType, refUrl, href, title } = mark.attrs;
          if (identifier && refUrl === href && definitionInScope(identifier)) {
            state.withMark(mark, 'linkReference', undefined, {
              identifier, label: label || identifier, referenceType: referenceType || 'full',
            });
            return;
          }
          state.withMark(mark, 'link', undefined, { title, url: href });
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// An html block is a block (H2).
//
// Milkdown keeps an html block as an inline atom alone in a paragraph, so the caret can sit
// beside it and typing lands in the same paragraph. The file cannot say that: a line that
// starts with `<!--`, `<div>` or any of CommonMark's block tags opens an html block that runs
// on, and ` zz` typed after a comment was written `<!-- comment --> zz` and read back as part
// of the comment, gone from view. Text typed in front of a multi-line `<div>` did the opposite
// and turned the div's inner lines into prose. So an html node that would open a block where it
// stands is written in a paragraph of its own, and what was typed beside it in the paragraph
// before or after: the editor does it as it happens (blocks.ts `htmlBlockPlugin`), and the
// write guard does it to the document it writes (guard.ts), so neither can disagree.

/** CommonMark html block starts 1 to 6: they open a block whatever follows on the line. */
const HTML_BLOCK_START = /^(?:<(?:script|pre|style|textarea)(?:\s|>|$)|<!--|<\?|<![A-Za-z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$))/i;
/** Start 7: one complete tag, which opens a block only when it is alone on its line. */
const HTML_LONE_TAG = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/;

const isBlankLeaf = (n) => n.type.name === 'hardbreak' || (n.isText && !/\S/.test(n.text));

/**
 * The index of the html child of `para` that cannot share its paragraph, or -1.
 */
function strayHtml(para: import('@milkdown/kit/prose/model').Node) {
  if (para.type.name !== 'paragraph' || para.childCount < 2) return -1;
  let lineStart = true;
  let paraStart = true;
  for (let i = 0; i < para.childCount; i++) {
    const child = para.child(i);
    if (child.type.name === 'html') {
      const value = String(child.attrs.value ?? '');
      const next = i + 1 < para.childCount ? para.child(i + 1) : null;
      const lineEnd = !next || next.type.name === 'hardbreak';
      const opens = value.includes('\n')
        || (lineStart && HTML_BLOCK_START.test(value))
        // A lone tag cannot interrupt a paragraph: it opens a block only where one starts.
        || (paraStart && lineEnd && HTML_LONE_TAG.test(value));
      // Anything else in the paragraph, a bare break included: a break in front of the html
      // is a line the html then interrupts.
      if (opens) return i;
    }
    const blank = isBlankLeaf(child);
    paraStart = paraStart && blank;
    lineStart = child.type.name === 'hardbreak' || (lineStart && blank);
  }
  return -1;
}

/**
 * `para` cut into up to three paragraphs around its html child `i`: what came before it, the
 * html alone, what came after it. The breaks and spaces at the cut go, because a paragraph
 * cannot start or end with them.
 */
function splitAround(para, i) {
  const kids: any[] = [];
  para.forEach((c) => kids.push(c));
  const trim = (list, fromEnd) => {
    const out = list.slice();
    while (out.length && isBlankLeaf(fromEnd ? out[out.length - 1] : out[0])) (fromEnd ? out.pop() : out.shift());
    if (!fromEnd && out.length && out[0].isText) {
      const t = out[0].text.replace(/^[ \t]+/, '');
      out[0] = t ? out[0].type.schema.text(t, out[0].marks) : null;
      if (!out[0]) out.shift();
    }
    return out;
  };
  const before = trim(kids.slice(0, i), true);
  const after = trim(kids.slice(i + 1), false);
  const make = (list) => para.type.create(para.attrs, list);
  return [...(before.length ? [make(before)] : []), make([kids[i]]), ...(after.length ? [make(after)] : [])];
}

/**
 * Put every stray html block of `tr.doc` between `from` and `to` in a paragraph of its own.
 * Works on a Transaction as on a bare Transform. Answers whether it changed anything.
 */
export function splitStrayHtml(tr: import('@milkdown/kit/prose/transform').Transform, from: number = 0, to: number = tr.doc.content.size) {
  const found: any[] = [];
  tr.doc.nodesBetween(Math.max(0, from), Math.min(to, tr.doc.content.size), (node, pos) => {
    if (node.type.name === 'paragraph') {
      if (strayHtml(node) >= 0) found.push(pos);
      return false;
    }
    return !node.isTextblock;
  });
  for (let k = found.length - 1; k >= 0; k--) {
    let pos = found[k];
    let node = tr.doc.nodeAt(pos);
    // One html node at a time, the last pieces first: a paragraph can hold several.
    for (let guard = 0; guard < 64 && node; guard++) {
      const i = strayHtml(node);
      if (i < 0) break;
      const parts = splitAround(node, i);
      tr.replaceWith(pos, pos + node.nodeSize, parts);
      // What follows the html is the only piece that can still hold another stray one.
      const last = parts[parts.length - 1];
      if (parts.length < 2 || last.childCount < 1 || last.child(0).type.name === 'html') break;
      let size = 0;
      for (let p = 0; p < parts.length - 1; p++) size += parts[p].nodeSize;
      pos += size;
      node = tr.doc.nodeAt(pos);
    }
  }
  return found.length > 0;
}

/** The whole document with every stray html block on its own (for the write guard and the tests). */
export function htmlEndsBlock(doc) {
  const tr = new Transform(doc);
  return splitStrayHtml(tr) ? tr.doc : doc;
}

/**
 * The document with no mark on a hard break. Bold or a link over a selection that crosses a
 * line break marks the break as well, and a mark carried across a newline is written
 * `**e\n**line`, whose closing `**` opens a line and so closes nothing. A mark on a break shows
 * nothing either way; written off it, the run is closed before the newline and opened again after.
 */
export function unmarkBreaks(doc: import('@milkdown/kit/prose/model').Node): import('@milkdown/kit/prose/model').Node {
  const at: any[] = [];
  doc.descendants((n, pos, parent, index) => {
    if (n.type.name !== 'hardbreak' || !n.marks.length || !parent) return true;
    // A mark that goes on past the break is an ordinary run over two lines (`_one\ntwo_`) and
    // stays; only one that stops or starts at the break is taken off it.
    const before = index > 0 ? parent.child(index - 1) : null;
    const after = index + 1 < parent.childCount ? parent.child(index + 1) : null;
    for (const m of n.marks) {
      if (!(before && m.isInSet(before.marks) && after && m.isInSet(after.marks))) at.push([pos, m]);
    }
    return true;
  });
  if (!at.length) return doc;
  const tr = new Transform(doc);
  for (const [pos, m] of at) tr.removeMark(pos, pos + 1, m);
  return tr.doc;
}

/**
 * The document with no empty inline formula. Insert a formula opens one with nothing in it, and
 * the page saves while its source is still being typed; `$$` is not an empty inline formula but
 * the start of a display one, so it could never be written. Nothing in it means nothing to
 * write: the save leaves it out, and the formula is in the next save once it holds TeX. Leaving
 * its box empty takes it out of the page as well (math-node.ts `empty`).
 */
export function dropEmptyFormulas(doc: import('@milkdown/kit/prose/model').Node): import('@milkdown/kit/prose/model').Node {
  const at: number[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'math_inline' && !String(n.attrs.value || '').trim()) at.push(pos);
    return true;
  });
  if (!at.length) return doc;
  const tr = new Transform(doc);
  for (const pos of at.reverse()) tr.delete(pos, pos + 1);
  return tr.doc;
}
