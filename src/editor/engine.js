// The markdown pipeline, once, for the editor and for anything that has to read and write a page
// the way the editor does without an editor on screen.
//
// Two things live here. `configureMarkdown` is the one list of what the files need from the
// parser and the serializer: the stringify options, the removals, the nodes and the remark
// plugins. `makeCrepe` (crepe.js) calls it and so does `makeEngine` below, so what a test proves
// about a save is what the page does, and the two cannot drift apart.
//
// `makeEngine` is that pipeline with no view: no DOM, no Crepe, no CSS. Milkdown builds its
// parser and serializer before it builds the view, so `create()` is allowed to fail at the view
// (there is no root to mount into) once the other two are ready.
//
// Nothing in this file imports `ose:*`, a stylesheet or the DOM at module top level. The two
// modules that bring nodes of their own, maths (math-node.js) and the image block (image.js),
// reach the core through host.js and are only imported inside `makeEngine`, which the app never
// calls; the page passes them in through `configureMarkdown`'s options instead. One stylesheet
// still comes in underneath: stringify.js reads the `$` rule from math.js, which imports Temml's
// and its own CSS, so plain Node needs a loader that stubs `.css` (the tests alias it).

import { Editor, parserCtx, remarkCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core';
import { commonmark, remarkInlineLinkPlugin, remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { imageBlockSchema, remarkImageBlockPlugin } from '@milkdown/kit/component/image-block';
import { configureStringify, withSerializeContext } from './stringify.js';
import { remarkSpace } from './space.js';
import * as guard from './guard.js';
import { definitionSchema, extendCodeBlock, extendHardbreak, extendInlineCode, extendLink, remarkResolveReferences } from './fidelity.js';

/**
 * @typedef {object} MarkdownExtras
 * @property {Array<any>} [nodes]   Milkdown plugins that bring nodes of their own (the maths
 *   schemas). Used after the definition node and before the space reader, which has to be the
 *   last remark plugin because it reads the positions the others leave alone.
 * @property {Array<(ctx: any) => void>} [extend]   schema extenders run inside `editor.config`
 *   (the image block's `alt` and `width`). The page leaves this empty: image.js extends the
 *   schema from its own `plugins(ctx)` through extensions.js, which the page installs anyway.
 */

/**
 * What the files need from the parser and the serializer, applied to a Milkdown editor before
 * `create()`. Everything that decides how a page reads and writes is here and nowhere else.
 *
 * @param {import('@milkdown/kit/core').Editor} editor
 * @param {MarkdownExtras} [extras]
 * @returns {Promise<import('@milkdown/kit/core').Editor>}
 */
export async function configureMarkdown(editor, extras = {}) {
  configureStringify(editor);
  editor.config((ctx) => {
    // M13/M11: a fence keeps the part of its info string past the language, and the link mark
    // learns the reference form (fidelity.js).
    extendCodeBlock(ctx);
    extendLink(ctx);
    // M6: every hard break reaches the serializer as a break node (fidelity.js, stringify.js).
    extendHardbreak(ctx);
    // A code mark on a break or a formula is not written as an empty code span (fidelity.js).
    extendInlineCode(ctx);
    for (const fn of extras.extend || []) fn(ctx);
  });
  // M3: `remark-preserve-empty-line` splices out every html node whose value is a `<br>`, so
  // `line one<br>line two` came back as `line oneline two`. Without it an empty paragraph is
  // simply not written, and `<br>` is an ordinary inline html node again.
  await editor.remove(remarkPreserveEmptyLinePlugin);
  // M11: `remark-inline-links` rewrites `[text][ref]` into `[text](url)` and deletes the
  // definition at parse time. Out it goes, and `definition` becomes a node of its own.
  await editor.remove(remarkInlineLinkPlugin);
  editor.use(definitionSchema);
  editor.use(remarkResolveReferences);
  for (const plugin of extras.nodes || []) editor.use(plugin);
  // Space: the blank lines of the file, read back as the empty paragraphs they are (space.js).
  // It runs on the parsed tree, so it is the last remark plugin.
  editor.use(remarkSpace);
  return editor;
}

/**
 * @typedef {object} Engine
 * @property {(md: string) => import('@milkdown/kit/prose/model').Node} parse
 * @property {(doc: import('@milkdown/kit/prose/model').Node) => string} serialize  raw output
 * @property {(md: string) => any} mdast   the parsed tree of `md`, before any transformer runs
 * @property {import('@milkdown/kit/prose/model').Schema} schema
 * @property {(md: string) => string} canonicalise   parse, serialise, clean up
 * @property {(md: string, original?: string) => string} roundTrip   what a save of `md` writes
 * @property {import('@milkdown/kit/core').Editor} editor
 */

/**
 * The same parse/serialize pipeline Crepe uses, with no view and no DOM.
 * @returns {Promise<Engine>}
 */
export async function makeEngine() {
  const [math, image] = await Promise.all([import('./math-node.js'), import('./image.js')]);
  // Crepe's own base (crepe `CrepeBuilder`): commonmark and gfm, and of its features the one that
  // brings a node, the image block. Everything else Crepe adds is a view, a keymap or a command.
  const editor = Editor.make().use(commonmark).use(gfm).use(imageBlockSchema).use(remarkImageBlockPlugin);
  await configureMarkdown(editor, {
    nodes: math.mathSchemas,
    extend: [(ctx) => { image.plugins(ctx, {}); }],
  });
  headless();
  // The view is the last internal plugin to start and the only one that needs a real DOM. By
  // the time it fails, the parser and the serializer are ready, and they are all this is for.
  try { await editor.create(); } catch { /* the view: there is nothing to mount into */ }
  return engineOver(editor);
}

/**
 * Just enough of a browser for Milkdown's `create()` to get as far as the parser and the
 * serializer: its view plugin asks for `document` before anything else fails. Nothing is
 * replaced that is already there, so under happy-dom or in the app this does nothing.
 */
function headless() {
  // what is stubbed is only ever looked up by these names, never checked for its full type
  const g = /** @type {{document?: object, requestAnimationFrame?: Function, getComputedStyle?: Function,
   *   addEventListener?: Function, removeEventListener?: Function, dispatchEvent?: Function}} */ (globalThis);
  g.document ??= { compatMode: 'CSS1Compat', body: {}, querySelector: () => null, createElement: () => { throw new Error('no dom'); } };
  g.requestAnimationFrame ??= (f) => setTimeout(f, 0);
  g.getComputedStyle ??= () => ({ getPropertyValue: () => '' });
  if (!g.addEventListener) {
    const et = new EventTarget();
    g.addEventListener = et.addEventListener.bind(et);
    g.removeEventListener = et.removeEventListener.bind(et);
    g.dispatchEvent = et.dispatchEvent.bind(et);
  }
}

/**
 * An engine over a Milkdown editor that has been created, headless or not. crepe.js builds the
 * page's engine with this, so the page and the tests share every line of it.
 *
 * @param {import('@milkdown/kit/core').Editor} editor
 * @returns {Engine}
 */
export function engineOver(editor) {
  const act = (fn) => editor.action(fn);
  const engine = {
    editor,
    parse: (md) => act((ctx) => ctx.get(parserCtx)(String(md ?? ''))),
    serialize: (doc) => withSerializeContext({ doc }, () => act((ctx) => ctx.get(serializerCtx)(doc))),
    mdast: (md) => act((ctx) => ctx.get(remarkCtx).parse(String(md ?? ''))),
    get schema() { return act((ctx) => ctx.get(schemaCtx)); },
    canonicalise: (md) => guard.canonicalise(engine, md),
    roundTrip: (md, original = md) => guard.roundTrip(engine, md, original),
  };
  return engine;
}

