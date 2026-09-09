// One place that builds a Crepe instance. Both the page editor and the round-trip harness
// use it, so what the harness proves is what the editor actually does.

import { Crepe, CrepeFeature } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import { editorViewCtx, parserCtx, prosePluginsCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { strikethroughInputRule } from '@milkdown/kit/preset/gfm';
import { configureStringify, postProcess, reconcile } from './stringify.js';
import { slashPlugin } from './slash.js';
import { blockKeysPlugin } from './blocks.js';
import { calloutPlugin, findPlugin, strikethroughRule, urlPastePlugin } from './plugins.js';
import { dropPlugin } from './drop.js';

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
      // off: Latex (no maths in the vault, and it would rewrite `$` in prose),
      //      TopBar (a fixed formatting ribbon; the selection toolbar and the slash menu do
      //      that job), AI (no AI surface in the app), BlockEdit (it is only the gutter
      //      handle, removed in batch 2, plus a slash menu that cannot be retriggered or
      //      refiltered through its config; slash.js replaces the menu entirely).
      [CrepeFeature.Latex]: false,
      [CrepeFeature.TopBar]: false,
      [CrepeFeature.AI]: false,
      [CrepeFeature.BlockEdit]: false,
    },
    featureConfigs: {
      [CrepeFeature.Placeholder]: { text: 'Type / for commands', mode: 'block' },
      [CrepeFeature.Cursor]: { color: cssVar('--accent'), width: 2, virtual: true },
      [CrepeFeature.LinkTooltip]: { inputPlaceholder: 'Paste or type a link' },
      [CrepeFeature.ImageBlock]: {
        proxyDomURL: o.resolveImage,
        onUpload: o.uploadImage,
        blockUploadPlaceholderText: 'or paste a link',
        inlineUploadPlaceholderText: 'or paste a link',
        blockCaptionPlaceholderText: 'Caption',
      },
    },
  });

  configureStringify(crepe.editor);
  await installExtras(crepe.editor, o);
  if (o.slashCommands !== false) { installSlash(crepe.editor); installBlockKeys(crepe.editor); }
  if (o.onChange) watchDoc(crepe.editor, o.onChange);
  if (o.on) crepe.on(o.on);

  await crepe.create();
  return crepe;
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
    ctx.update(prosePluginsCtx, (plugins) => [...first, ...plugins, calloutPlugin(), findPlugin()]);
  });
  await editor.remove(strikethroughInputRule);
  editor.use(strikethroughRule);
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

/**
 * Body markdown as it would be written to disk.
 *
 * `original` is the text currently in the file. The canonical serialisation is reconciled
 * against it so untouched lines, blank lines and tables keep the shape Hassan wrote, and the
 * result is then verified: it is only used if re-parsing it gives back the same document.
 * That verification is what makes the reconciliation safe rather than merely plausible.
 */
export function readMarkdown(crepe, original) {
  return verify(crepe, postProcess(crepe.getMarkdown()), original);
}

function verify(crepe, canonical, original) {
  if (!original) return canonical;
  for (const opt of [{ lines: true }, { lines: false }]) {
    const candidate = reconcile(canonical, original, opt);
    if (candidate === canonical) return canonical;
    if (canonicalise(crepe, candidate) === canonical) return candidate;
  }
  return canonical;
}

/** Parse a markdown string and serialise it straight back, with no view involved. */
export function canonicalise(crepe, markdown) {
  return crepe.editor.action((ctx) =>
    postProcess(ctx.get(serializerCtx)(ctx.get(parserCtx)(markdown))));
}

/** What the editor would write for `markdown` if it were opened and saved unchanged. */
export function roundTrip(crepe, markdown) {
  return verify(crepe, canonicalise(crepe, markdown), markdown);
}

/**
 * The canonical markdown of one top-level node, on its own: the node is wrapped in a fresh
 * `doc` and put through the same serializer and clean-up a save uses. lines.js counts these
 * to map a source line onto a block (C7); nothing is written from here.
 */
export function blockMarkdown(crepe, node) {
  return crepe.editor.action((ctx) => {
    const doc = ctx.get(schemaCtx).nodes.doc.create(null, node);
    return postProcess(ctx.get(serializerCtx)(doc));
  });
}

export function editorView(crepe) {
  try { return crepe.editor.action((ctx) => ctx.get(editorViewCtx)); } catch { return null; }
}
