// One place that builds a Crepe instance. Both the page editor and the round-trip harness
// use it, so what the harness proves is what the editor actually does.

import { Crepe, CrepeFeature } from '@milkdown/crepe';
// Crepe's theme, one file at a time instead of its `theme/common/style.css`, which is nothing
// but these `@import`s plus `latex.css`. That one line pulls in `katex/dist/katex.min.css` and
// with it sixty KaTeX font files, 1.0 MB of the built core, for a feature that is switched off
// below and a renderer the app does not use: maths is Temml and MathML (math.js).
import '@milkdown/crepe/theme/common/prosemirror.css';
import '@milkdown/crepe/theme/common/reset.css';
import '@milkdown/crepe/theme/common/block-edit.css';
import '@milkdown/crepe/theme/common/code-mirror.css';
import '@milkdown/crepe/theme/common/cursor.css';
import '@milkdown/crepe/theme/common/image-block.css';
import '@milkdown/crepe/theme/common/link-tooltip.css';
import '@milkdown/crepe/theme/common/list-item.css';
import '@milkdown/crepe/theme/common/placeholder.css';
import '@milkdown/crepe/theme/common/toolbar.css';
import '@milkdown/crepe/theme/common/table.css';
import '@milkdown/crepe/theme/common/top-bar.css';
import '@milkdown/crepe/theme/common/diff.css';
import '@milkdown/crepe/theme/common/ai.css';
import { editorViewCtx, prosePluginsCtx } from '@milkdown/kit/core';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { strikethroughInputRule } from '@milkdown/kit/preset/gfm';
import { indentPlugin } from '@milkdown/kit/plugin/indent';
import { trailingPlugin } from '@milkdown/kit/plugin/trailing';
import { postProcess, reconcile } from './stringify.js';
import { docWithoutPad } from './space.js';
import { slashPlugin } from './slash.js';
import { blockKeysPlugin, htmlBlockPlugin } from './blocks.js';
import { calloutPlugin, findPlugin, strikethroughRule, urlPastePlugin } from './plugins.js';
import { dropPlugin } from './drop.js';
import { extensionPlugins, extensionFeatureConfigs } from './extensions.js';
import { mathSchemas } from './math-node.js';
import { configureMarkdown, engineOver } from './engine.js';
import * as guard from './guard.js';

// A token read at construction time, for the one Crepe option that takes a colour string and
// not a CSS variable. The fallback is the text colour, never a literal (CLAUDE.md: no hex
// outside tokens.css).
const cssVar = (name, fallback = 'currentColor') => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
};

/**
 * @param {object} o
 * @param {HTMLElement} o.root          element the editor mounts into
 * @param {string} o.markdown           initial body markdown
 * @param {(src:string)=>string} [o.resolveImage]   markdown src -> displayable url
 * @param {(file:File)=>Promise<string>} [o.uploadImage]  File -> markdown src
 * @param {(file:File)=>Promise<string>} [o.attachFile]   File -> vault path of the copy (drops)
 * @param {()=>string|null} [o.pagePath]  the open file, for the hrefs a drop writes
 * @param {boolean} [o.slashCommands]   false in the round-trip harness: no menu, no block keys
 * @param {() => void} [o.onChange]   after every transaction that changes the document
 * @param {(api: import('@milkdown/kit/plugin/listener').ListenerManager) => void} [o.on]
 *   Crepe's own listeners (blur, focus, …)
 */
export async function makeCrepe(o) {
  const crepe = new Crepe({
    root: o.root,
    defaultValue: o.markdown ?? '',
    features: {
      [CrepeFeature.ImageBlock]: true,
      [CrepeFeature.Toolbar]: true,
      [CrepeFeature.Placeholder]: true,
      [CrepeFeature.Table]: true,
      [CrepeFeature.CodeMirror]: true,
      [CrepeFeature.LinkTooltip]: true,
      [CrepeFeature.ListItem]: true,
      [CrepeFeature.Cursor]: true,
      // off: Latex (KaTeX, its Computer Modern and its sixty font files, and a `$` rule read
      //      like a code span, so a price in a journal entry becomes a formula; maths is
      //      math.js and math-node.js instead, on the pandoc rule and Temml),
      //      TopBar (a fixed formatting ribbon; the selection toolbar and the slash menu do
      //      that job), AI (no AI surface in the app), BlockEdit (it is only the gutter
      //      handle, removed in batch 2, plus a slash menu that cannot be retriggered or
      //      refiltered through its config; slash.js replaces the menu entirely).
      [CrepeFeature.Latex]: false,
      [CrepeFeature.TopBar]: false,
      [CrepeFeature.AI]: false,
      [CrepeFeature.BlockEdit]: false,
    },
    // The batch-12 modules (extensions.js) merge their own feature options over these.
    featureConfigs: extensionFeatureConfigs(o, {
      [CrepeFeature.Placeholder]: { text: 'Type / for commands', mode: 'block' },
      [CrepeFeature.Cursor]: { color: cssVar('--accent'), width: 2, virtual: true },
      [CrepeFeature.LinkTooltip]: { inputPlaceholder: 'Paste or type a link' },
      // Crepe's CodeMirror feature installs One Dark as its theme, and One Dark is not only a
      // ground and a caret: it carries a highlight style of its own, with hard-coded hexes, that
      // ran beside ours. Ours (highlight.js) leaves a plain identifier the body colour on
      // purpose; One Dark painted those same identifiers coral, on screen and in the PDF, where
      // it was the one colour on an otherwise black-and-white sheet. `null` is the feature's own
      // way of asking for no theme; the code block's ground, caret, selection and gutters are
      // editor.css's and always were.
      [CrepeFeature.CodeMirror]: { theme: null },
      [CrepeFeature.ImageBlock]: {
        proxyDomURL: o.resolveImage,
        onUpload: o.uploadImage,
        blockUploadPlaceholderText: 'or paste a link',
        inlineUploadPlaceholderText: 'or paste a link',
        blockCaptionPlaceholderText: 'Caption',
      },
    }),
  });

  await installExtras(crepe.editor, o);
  if (o.slashCommands !== false) { installSlash(crepe.editor); installBlockKeys(crepe.editor); }
  if (o.onChange) watchDoc(crepe.editor, o.onChange);
  if (o.on) crepe.on(o.on);

  await crepe.create();
  dropStaleTransactions(crepe);
  return crepe;
}

/**
 * A transaction built on a document the view has since left is dropped, not applied.
 *
 * Milkdown's table block selects the cell under a click from a `requestAnimationFrame` (or a
 * 20 ms timeout) with the state it read at mousedown. A key typed inside that frame moves the
 * document on, and ProseMirror refuses the old transaction with an uncaught `RangeError:
 * Applying a mismatched transaction`, which lands in the log at error level for a selection
 * change nobody would miss. ProseMirror would throw it away anyway; this only asks first. The
 * view binds `dispatch` in its constructor, and every caller reads it off the view at call time.
 */
function dropStaleTransactions(crepe) {
  const view = editorView(crepe);
  if (!view || typeof view.dispatch !== 'function') return;
  const dispatch = view.dispatch;
  view.dispatch = (tr) => {
    if (tr && tr.before && !tr.before.eq(view.state.doc)) {
      console.debug('[editor] dropped a transaction built on an older document');
      return;
    }
    dispatch(tr);
  };
}

/**
 * The batch-9 plugins (plugins.js) and the drop handler (drop.js). The paste and drop
 * handlers go in front of `prosePluginsCtx`: ProseMirror asks plugins in order and Milkdown's
 * clipboard and upload plugins, already in the list, would otherwise paste the URL as text,
 * or claim a drop of files it then throws away, before ours are asked. The callout and find
 * decorations can go anywhere. The gfm strikethrough input rule is taken out before
 * `create()` (`remove` only edits the plugin store at that point) and the `~~`-only rule is
 * used in its place. The harness passes no `attachFile`, so it gets no drop handler.
 */
async function installExtras(editor, o) {
  const first = [urlPastePlugin()];
  if (typeof o.attachFile === 'function') first.push(dropPlugin({ attach: o.attachFile, pagePath: o.pagePath || (() => null) }));
  editor.config((ctx) => {
    // The batch-12 module plugins (extensions.js) come after ours and before Milkdown's keymap,
    // which is appended after this whole list, so a table keymap can answer Enter first. The
    // html rule (H2, blocks.js) keeps an html block in a paragraph of its own after every edit.
    ctx.update(prosePluginsCtx, (plugins) => [...first, ...plugins, calloutPlugin(), findPlugin(), htmlBlockPlugin(), ...extensionPlugins(ctx, o)]);
  });
  await editor.remove(strikethroughInputRule);
  editor.use(strikethroughRule);
  // D2/E1/E2/L2: `plugin-indent` is the last handler in the Tab chain, and what it does is type
  // four literal spaces — which re-parse as an indented code block, so a paragraph silently
  // became code on the next reload. Tab is decided in commands.js instead, and nothing in the
  // editor ever writes a space for it. Removing a plugin only edits the store before `create()`.
  // Only the shortcut goes: `indent` is `[indentConfig, indentPlugin]`, and Crepe's own builder
  // configures `indentConfig` at create time, so taking the ctx slice away throws there.
  await editor.remove(indentPlugin);
  // The landing pad after a table or a code block is kept, but by space.js instead, because it
  // has to be told from an empty paragraph the file itself contains and no plugin state of
  // Milkdown's says which is which. Only the prose plugin goes; `trailingConfig` is a ctx slice
  // Crepe's builder reads at create time and taking it away would throw there.
  await editor.remove(trailingPlugin);
  // Everything that decides how a page reads and writes: the stringify options, the removals
  // (`remark-preserve-empty-line`, M3; `remark-inline-links`, M11), the definition node, the
  // maths nodes and the space reader, which has to be the last remark plugin. One list, in
  // engine.js, which the headless engine the tests run reads as well (CONTRACT 7.4).
  await configureMarkdown(editor, { nodes: mathSchemas });
}

/** The slash menu, as a plain ProseMirror plugin so it holds the editor ctx it needs. */
function installSlash(editor) {
  editor.config((ctx) => {
    ctx.update(prosePluginsCtx, (plugins) => plugins.concat(slashPlugin(ctx)));
  });
}

/**
 * The block keymap (Esc, Shift+arrows, Ctrl+Shift+arrows). Milkdown builds every keymap into
 * one plugin appended after `prosePluginsCtx`, so a plugin added here is asked first and can
 * take Backspace away from the base keymap when whole blocks are selected.
 */
function installBlockKeys(editor) {
  editor.config((ctx) => {
    ctx.update(prosePluginsCtx, (plugins) => plugins.concat(blockKeysPlugin()));
  });
}

const DIRTY_KEY = new PluginKey('os-dirty');

/**
 * Fire `onChange` for every transaction that changes the document.
 *
 * Not `listener.updated`: that one is debounced by 200ms and skips any transaction marked
 * `addToHistory: false`, and in practice it never fires for `setNodeAttribute` — which is
 * exactly what ticking a task checkbox dispatches. A plugin sees every transaction.
 */
function watchDoc(editor, onChange) {
  editor.config((ctx) => {
    ctx.update(prosePluginsCtx, (plugins) => plugins.concat(new Plugin({
      key: DIRTY_KEY,
      state: {
        init: () => 0,
        apply: (tr, n) => {
          if (!tr.docChanged) return n;
          queueMicrotask(onChange);   // never call back inside a transaction
          return n + 1;
        },
      },
    })));
  });
}

// ---------------------------------------------------------------------------
// reading the page back as markdown

const ENGINES = new WeakMap();

/**
 * The parse/serialize pipeline of this instance, as an engine (engine.js `MdEngine`): the same
 * functions the headless engine the tests run gives, over this editor's own parser and
 * serializer. One per instance.
 *
 * @param {import('@milkdown/crepe').Crepe} crepe
 * @returns {import('./engine.js').Engine}
 */
export function engineOf(crepe) {
  let engine = ENGINES.get(crepe);
  if (!engine) { engine = engineOver(crepe.editor); ENGINES.set(crepe, engine); }
  return engine;
}

/**
 * The open document, as it is written: without the landing pad (space.js), which is the
 * editor's furniture rather than the file's. Null when there is no view.
 */
function liveDoc(crepe) {
  const view = editorView(crepe);
  if (!view) return null;
  return docWithoutPad(view.state) || view.state.doc;
}

/**
 * What to write for the page body, and whether it is safe to (C8, guard.js). Never throws.
 *
 *   ok        write `text`
 *   fellBack  write `text`: the meaning is exact, untouched blocks may be restyled
 *   unsafe    write nothing; `text` is the best effort, to open as text for the user to check
 *
 * `original` is the body currently on disk: untouched blocks keep its bytes.
 *
 * @param {import('@milkdown/crepe').Crepe} crepe
 * @param {string} original
 * @returns {import('./guard.js').WriteCheck}
 */
export function readMarkdownChecked(crepe, original) {
  try {
    const doc = liveDoc(crepe);
    if (!doc) return { status: 'unsafe', text: null, reason: 'the editor is gone' };
    return guard.checkWrite(engineOf(crepe), doc, original);
  } catch (err) {
    const e = /** @type {{ code?: string, message?: string }} */ (err);
    return { status: 'unsafe', text: null, reason: `the guard failed: ${String((e && e.message) || e).split('\n')[0]}` };
  }
}

/**
 * Did the rich view keep everything `body` says (C10, guard.js `checkOpen`)? Asked right after
 * the page mounts. Never throws: a check that cannot run answers `ok: false`, and the page
 * opens as text.
 *
 * @param {import('@milkdown/crepe').Crepe} crepe
 * @param {string} body   the markdown the editor was built from
 * @returns {import('./guard.js').OpenCheck}
 */
export function openCheck(crepe, body) {
  try {
    const view = editorView(crepe);
    if (!view) return { ok: false, reason: 'the editor is gone', missing: [] };
    return guard.checkOpen(engineOf(crepe), body, view.state.doc);
  } catch (err) {
    const e = /** @type {{ code?: string, message?: string }} */ (err);
    return { ok: false, reason: `the check failed: ${String((e && e.message) || e).split('\n')[0]}`, missing: [] };
  }
}

/**
 * Body markdown as it would be written to disk: `readMarkdownChecked`'s text. For callers that
 * want a string and nothing else (copying, the harness); the page asks `readMarkdownChecked`,
 * because an `unsafe` text must never be written. With no view at all, Crepe's own markdown.
 *
 * @param {import('@milkdown/crepe').Crepe} crepe
 * @param {string} original
 * @returns {string}
 */
export function readMarkdown(crepe, original) {
  const r = readMarkdownChecked(crepe, original);
  if (r.text !== null && r.text !== undefined) return r.text;
  try { return crepe.getMarkdown(); } catch { return ''; }
}

/**
 * Batch 9's engine — line-keyed reconcile, string-level verify, all or nothing. Nothing in the
 * app asks for it; the harness does, so the before and after of batch 12 are one measurement by
 * one instrument over one vault.
 */
function legacyRoundTrip(crepe, markdown, original) {
  const engine = engineOf(crepe);
  const canonical = guard.canonicalise(engine, markdown);
  if (!original) return canonical;
  for (const opt of [{ lines: true }, { lines: false }]) {
    const candidate = reconcile(canonical, original, opt);
    if (candidate === canonical) return canonical;
    if (guard.canonicalise(engine, candidate) === canonical) return candidate;
  }
  return canonical;
}

/**
 * Parse a markdown string and serialise it straight back, with no view involved.
 * @param {import('@milkdown/crepe').Crepe} crepe
 * @param {string} markdown
 */
export function canonicalise(crepe, markdown) {
  return guard.canonicalise(engineOf(crepe), markdown);
}

/**
 * What the editor would write for `markdown` if it were opened and saved unchanged.
 *
 * `original` is the text the reconcile pass is allowed to put back, and defaults to `markdown`
 * itself, which is the open-and-save case. The harness passes the two apart to ask the other
 * question: given the file on disk and a document with one line edited, what gets written?
 * The answer goes through the write guard like a save; an `unsafe` one is the best effort,
 * which a save would not write.
 */
export function roundTrip(crepe, markdown, original = markdown, opt = {}) {
  if (opt.legacy) return legacyRoundTrip(crepe, markdown, original);
  return guard.roundTrip(engineOf(crepe), markdown, original);
}

/**
 * The canonical markdown of one top-level node, on its own: the node is wrapped in a fresh
 * `doc` and put through the same serializer and clean-up a save uses. lines.js counts these
 * to map a source line onto a block (C7); nothing is written from here.
 */
export function blockMarkdown(crepe, node) {
  const engine = engineOf(crepe);
  // every Milkdown schema has its `doc`
  const doc = /** @type {import('@milkdown/kit/prose/model').NodeType} */ (engine.schema.nodes.doc).create(null, node);
  return postProcess(engine.serialize(doc), { mdast: engine.mdast });
}

export function editorView(crepe) {
  try { return crepe.editor.action((ctx) => ctx.get(editorViewCtx)); } catch { return null; }
}
