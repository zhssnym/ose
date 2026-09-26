// The widget registration API between Live's core and its widgets (contract §4.3).
//
// Types, and `collect()`, which sorts a list of widgets into what the core asks for: the
// parser extensions and code languages that go into the markdown language, the extensions
// that go into the view, and the widgets to call per syntax node, split by kind.
//
// Nothing here draws. A widget's `decorate` is called only for the nodes it names, and only
// when those nodes are not revealed (reveal.js); the core sorts what goes into the sink, and a
// widget that throws leaves its node raw and is logged once (inline.js, blocks.js).
//
// Node names are lezer-markdown's, plus the ones syntax.js adds:
//   - `Wikilink`, `[[target#heading|alias]]`, with two `WikilinkMark` children;
//   - `Frontmatter`, the `---` block at the very start of the file, with `FrontmatterMark`s;
//   - an embed, `![[file.png|300]]`, is parsed as an **`Image`** node too, whose children are
//     two `WikilinkMark`s instead of `LinkMark`/`URL`. An image widget tells the two apart by
//     the node's text (`![[` or `![`).

/**
 * @typedef {object} WidgetContext
 * @property {import('@codemirror/state').EditorState} state
 * @property {string} path
 * @property {(from: number, to: number) => boolean} revealed   raw markup is shown for [from, to]
 * @property {(src: string) => string | null} resolveAsset
 * @property {(href: string, o: { newTab: boolean }) => void} openLink
 * @property {(md: string) => string} inlineHtml   inline markdown -> sanitised HTML (table cells)
 */

/**
 * @typedef {{ add(from: number, to: number, deco: import('@codemirror/view').Decoration): void }} DecorationSink
 */

/**
 * @typedef {object} LiveWidget
 * @property {string} id                            'image' | 'table' | 'math' | 'code'
 * @property {'inline' | 'block'} kind              inline: visible ranges (ViewPlugin); block: StateField
 * @property {string[]} nodes                       lezer node names: 'Image', 'Table', 'InlineMath', 'BlockMath', 'FencedCode'
 * @property {(ctx: WidgetContext, node: import('@lezer/common').SyntaxNodeRef, out: DecorationSink) => void} decorate
 * @property {import('@lezer/markdown').MarkdownConfig} [markdown]           parser extension (math)
 * @property {import('@codemirror/language').LanguageDescription[]} [languages]  nested code languages
 * @property {import('@codemirror/state').Extension} [extension]              theme, handlers
 */

/**
 * @typedef {object} PasteContext
 * @property {string} path
 * @property {(file: File) => Promise<string | null>} saveAttachment
 * @property {(vaultPath: string) => string} linkTo
 */

/**
 * @typedef {object} Collected
 * @property {Map<string, LiveWidget[]>} inline     node name -> the inline widgets that draw it
 * @property {Map<string, LiveWidget[]>} block      node name -> the block widgets that draw it
 * @property {import('@lezer/markdown').MarkdownConfig[]} markdown
 * @property {import('@codemirror/language').LanguageDescription[]} languages
 * @property {import('@codemirror/state').Extension[]} extensions
 */

/**
 * Sort `widgets` into what the core consumes. A malformed entry (no id, no `decorate`, an
 * unknown kind) is skipped and said once on the console: a broken widget must never keep the
 * page from opening.
 * @param {readonly LiveWidget[] | null | undefined} widgets
 * @returns {Collected}
 */
export function collect(widgets) {
  /** @type {Collected} */
  const out = { inline: new Map(), block: new Map(), markdown: [], languages: [], extensions: [] };
  for (const w of widgets || []) {
    if (!w || typeof w.id !== 'string') continue;
    if (w.markdown) out.markdown.push(w.markdown);
    if (Array.isArray(w.languages)) out.languages.push(...w.languages);
    if (w.extension) out.extensions.push(w.extension);
    if (typeof w.decorate !== 'function' || (w.kind !== 'inline' && w.kind !== 'block')) {
      if (w.nodes && w.nodes.length) console.warn(`[live] widget ${w.id}: no decorate or unknown kind, skipped`);
      continue;
    }
    const map = w.kind === 'block' ? out.block : out.inline;
    for (const name of w.nodes || []) {
      const list = map.get(name) || [];
      list.push(w);
      map.set(name, list);
    }
  }
  return out;
}

/** The widget ids that already said they threw: one console line per widget, not per node. */
const told = new Set();

/**
 * Run one widget's `decorate` into a buffer, and only hand the buffer on when it returned:
 * a widget that throws halfway leaves its node raw instead of half drawn.
 * @param {LiveWidget} w
 * @param {WidgetContext} ctx
 * @param {import('@lezer/common').SyntaxNodeRef} node
 * @param {(from: number, to: number, deco: import('@codemirror/view').Decoration) => void} add
 * @returns {boolean} true when the widget drew something
 */
export function runWidget(w, ctx, node, add) {
  /** @type {[number, number, import('@codemirror/view').Decoration][]} */
  const buf = [];
  try {
    w.decorate(ctx, node, { add: (from, to, deco) => { buf.push([from, to, deco]); } });
    for (const [from, to, deco] of buf) {
      const why = invalid(ctx.state.doc, w.kind, from, to, deco);
      if (why) throw new Error(`${why} at ${from}-${to}`);
    }
  } catch (e) {
    if (!told.has(w.id)) { told.add(w.id); console.error(`[live] widget ${w.id} failed; its nodes stay raw`, e); }
    return false;
  }
  for (const [from, to, deco] of buf) add(from, to, deco);
  return buf.length > 0;
}

/**
 * Why CodeMirror would refuse this decoration, or null. CodeMirror throws from inside the view
 * update on these, which would take every keystroke down with it, so a widget's output is
 * checked before it goes in: an inline widget may not replace a line break (only a state field
 * may), and a block replace has to cover whole lines.
 * @param {import('@codemirror/state').Text} doc
 * @param {'inline' | 'block'} kind
 * @param {number} from
 * @param {number} to
 * @param {import('@codemirror/view').Decoration} deco
 * @returns {string | null}
 */
function invalid(doc, kind, from, to, deco) {
  if (!(from >= 0 && to >= from && to <= doc.length)) return 'out of the document';
  if (!deco.point) return null;
  const block = !!(deco.spec && deco.spec.block);
  if (block && kind === 'inline') return 'a block decoration from an inline widget';
  if (!block && kind === 'inline' && to > from && doc.lineAt(from).number !== doc.lineAt(to).number) {
    return 'an inline replace across a line break';
  }
  if (block && to > from && (doc.lineAt(from).from !== from || doc.lineAt(to).to !== to)) {
    return 'a block replace that does not cover whole lines';
  }
  return null;
}
