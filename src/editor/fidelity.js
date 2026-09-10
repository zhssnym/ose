// The schema the files need, as opposed to the schema the editor needs.
//
// Milkdown's commonmark preset throws away three things on the way in, and no amount of work
// on the way out can put them back: the part of a fence's info string after the language, the
// `<br>` in the middle of a paragraph, and a reference link with its definition. Each one is a
// construct the vault is allowed to contain and the editor is not allowed to delete, so each
// one gets what it needs here — an attribute, a plugin left out, a node — and nothing else.
//
// Everything in this file is registered from crepe.js `installExtras`, before `create()`.

import { codeBlockSchema, linkAttr, linkSchema, sanitizeLinkHref } from '@milkdown/kit/preset/commonmark';
import { $nodeSchema, $remark } from '@milkdown/kit/utils';

/**
 * M13. A fence is written ```` ```js title="a.js" {1,3} ````; mdast splits that into `lang`
 * ("js") and `meta` (the rest), and Milkdown reads only the first and writes only the first,
 * so the rest is gone after one save. `meta` becomes an attribute that rides along untouched.
 * The language picker in code.js sets `language` and never looks at `meta`, so it is unaffected.
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
          if (identifier && refUrl === href) {
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
