// The headless engine, until src/editor/engine.js lands (CONTRACT 7.4). A copy of the audit's
// work/audit/roundtrip/engine.mjs, reading the live sources under src/editor instead of the
// audit's snapshots: the same presets, the same removals, the same schemas, the same remark
// plugins and the same stringify options as crepe.js makeCrepe(), with no EditorView.
//
// It is only a stand-in. tests/support/pipeline.js prefers src/editor/engine.js as soon as the
// file exists, and this one can then go. Keep it in step with crepe.js installExtras() until
// then: a plugin added there and not here is a difference the tests cannot see.

import {
  Editor, editorViewCtx, parserCtx, remarkCtx, schemaCtx, serializerCtx,
} from '@milkdown/kit/core';
import { commonmark, remarkInlineLinkPlugin, remarkPreserveEmptyLinePlugin } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { imageBlockSchema, remarkImageBlockPlugin } from '@milkdown/kit/component/image-block';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

installHeadlessGlobals();

/**
 * Just enough of a browser for Milkdown's `create()` to get as far as the parser and the
 * serializer. The view is the last internal plugin and fails without a DOM, which is fine:
 * nothing here needs one. In a happy-dom file the real globals are already there and nothing
 * is replaced.
 */
function installHeadlessGlobals() {
  const g = globalThis;
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
 * The same parse/serialize pipeline Crepe uses, with no view and no DOM.
 * @returns {Promise<{
 *   parse: (md: string) => import('@milkdown/kit/prose/model').Node,
 *   serialize: (doc: import('@milkdown/kit/prose/model').Node) => string,
 *   schema: import('@milkdown/kit/prose/model').Schema,
 *   mdast: (md: string) => any,
 *   canonicalise: (md: string) => string,
 *   roundTrip: (md: string, original?: string) => string,
 *   S: any,
 * }>}
 */
export async function makeEngine() {
  // `OSE_TEST_EDITOR_DIR` points the stand-in at another copy of the editor sources (the
  // audit's snapshots in work/audit/roundtrip/orig, fixed, fixed2), to check what a test says
  // about a version of the serialiser other than the one in src/editor.
  const dir = process.env.OSE_TEST_EDITOR_DIR
    ? pathToFileURL(resolve(process.env.OSE_TEST_EDITOR_DIR) + '/').href
    : pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'editor') + '/').href;
  const load = (name) => import(/* @vite-ignore */ new URL(name, dir).href);
  const S = await load('stringify.js');
  const F = await load('fidelity.js');
  const SP = await load('space.js');
  const M = await load('math-node.js');
  const I = await load('image.js');

  const editor = Editor.make().use(commonmark).use(gfm).use(imageBlockSchema).use(remarkImageBlockPlugin);
  S.configureStringify(editor);
  editor.config((ctx) => {
    F.extendCodeBlock(ctx);
    F.extendLink(ctx);
    I.plugins(ctx, {});
  });
  await editor.remove(remarkPreserveEmptyLinePlugin);
  await editor.remove(remarkInlineLinkPlugin);
  editor.use(F.definitionSchema);
  editor.use(F.remarkResolveReferences);
  for (const p of M.mathSchemas) editor.use(p);
  editor.use(SP.remarkSpace);
  // The view is the last plugin to start and the only one that needs a DOM.
  try { await editor.create(); } catch { /* no view, by design */ }
  void editorViewCtx;

  const act = (fn) => editor.action(fn);
  const parse = (md) => act((ctx) => ctx.get(parserCtx)(md));
  const serialize = (doc) => act((ctx) => ctx.get(serializerCtx)(doc));
  const schema = act((ctx) => ctx.get(schemaCtx));
  const remark = act((ctx) => ctx.get(remarkCtx));
  const mdast = (md) => remark.runSync(remark.parse(md), md);

  const cache = new Map();
  const canonicalise = (md) => S.postProcess(serialize(parse(md)));
  const canon = (md) => {
    let hit = cache.get(md);
    if (hit === undefined) { hit = canonicalise(md); cache.set(md, hit); }
    return hit;
  };
  // crepe.js verify() at ecb46ae: reconcile, then the string-level check.
  const verify = (canonical, original) => {
    if (!original) return canonical;
    let candidate;
    try { candidate = S.reconcile(canonical, original, { canon }); } catch { return canonical; }
    if (candidate === canonical) return canonical;
    try { return canon(candidate) === canonical ? candidate : canonical; } catch { return canonical; }
  };
  const roundTrip = (md, original = md) => verify(canonicalise(md), original);

  return { editor, parse, serialize, schema, remark, mdast, canon, canonicalise, roundTrip, verify, S };
}
