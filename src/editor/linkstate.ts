// What a link does and what it looks like (batch 12, package P7).
//
// One function decides where a link goes — `followHref` — and every way of following one ends
// in it: Ctrl+click and the link tooltip (index.js hands over), the command `page.follow-link`
// (Alt+Enter), and the `[[` picker's "open" path. The rules, in order:
//
//   external            bridge.openExternal; the host refuses anything but http/https/mailto
//                       and that refusal is now said out loud instead of vanishing (N9)
//   #heading            the same page, scrolled to that heading (N4, L13)
//   a folder            the folder view, `{type:'folder', path}` (wave 2, H15), never Explorer
//   any other file      navigate to `{type:'page', path}`, with the heading when the href
//                       carried one (N3): the page host decides how the file is drawn — the
//                       editor, an image or a PDF, or a box for a binary file (H17). A missing
//                       file lands on the router's "page not found · Create it" (C8)
//
// Another application is only ever an explicit command (`page.reveal`, the page host's
// "Open with default app"), never what a link does.
// The other half of the module is what a link looks like: an internal link whose target is not
// in the vault is drawn with the class `link-missing` (L14). Existence is one `bridge.exists`
// per distinct href, cached for as long as the page stays open and dropped on any `fs` event,
// so the decoration costs nothing while typing and is never stale after a file appears.

import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { bus, commands, bridge, navigate } from './host.ts';
import { toast } from './deps.ts';
import * as P from './paths.ts';

/* ------------------------------------------------------------------ following */

/**
 * Follow `href` as written inside the page at `fromPath`. Resolves when the link has been
 * acted on; never throws — a refusal is a toast, because a link that does nothing at all is
 * the bug this replaces.
 */
export async function followHref(href, fromPath) {
  const raw = String(href || '').trim();
  if (!raw) return;

  if (P.isExternal(raw)) {
    try {
      await bridge.openExternal(raw);
    } catch (err) {
      const e = (err as { code?: string, message?: string });
      // The host allows http, https and mailto and refuses the rest by design (platform.rs).
      // Saying so names the scheme, which is the one thing the user needs to know (N9).
      const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(raw) || [])[1];
      toast(scheme ? `${scheme}: links are not opened from the app` : String(e.message || e), 'warn', 3200);
    }
    return;
  }

  const t = P.linkTarget(fromPath || '', raw);
  if (!t) return;
  // A folder is a place in the app now (H15). A stat that fails, or a file that is not there,
  // is a page route: the router says it is missing and offers to create it.
  let kind: string | null = null;
  if (t.path) {
    try {
      const st = await bridge.stat(t.path);
      kind = st && st.exists !== false ? st.kind : null;
    } catch { kind = null; }
  }
  if (kind === 'dir' && !t.heading) {
    await navigate({ type: 'folder', path: t.path });
    return;
  }
  const route: {    type: string;    path: string; heading?: string; } = { type: 'page', path: t.path };
  if (t.heading) route.heading = t.heading;
  await navigate(route);
}

/* ------------------------------------------------------- the missing-link cache */

// href resolved to a vault path -> boolean. One entry per distinct target, filled in the
// background; `null` while the answer is on its way, so nothing is asked for twice.
let known = new Map();
let pending = new Set<any>();
/** Bumped whenever the cache is dropped: a decoration set built before it is rebuilt. */
let epoch = 0;
/** One repaint per live view: the page on screen and the parked ones (M12) alike. */
const redraws = new Set<any>();
const redrawAll = () => { for (const fn of [...redraws]) fn(); };

bus.on('fs', () => {
  if (!known.size && !pending.size) return;
  known = new Map();
  pending = new Set<any>();
  epoch++;
  redrawAll();
});

/** True, false, or null while the answer is being fetched. */
function existsCached(path) {
  if (known.has(path)) return known.get(path);
  if (pending.has(path)) return null;
  pending.add(path);
  const mine = epoch;
  bridge.exists(path).then(
    (v) => finish(mine, path, !!v),
    () => finish(mine, path, true),   // a failed check never paints a link as broken
  );
  return null;
}

function finish(mine, path, value) {
  if (mine !== epoch) return;
  pending.delete(path);
  known.set(path, value);
  redrawAll();
}

/* ---------------------------------------------------------------- decorations */

const KEY = new PluginKey('os-linkstate');

/** Every link mark in the document whose target is a vault file that is not there. */
function missingDecorations(doc, fromPath) {
  const out: any[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find((m) => m.type.name === 'link');
    if (!mark) return true;
    const href = String(mark.attrs.href || '').trim();
    if (!href || P.isExternal(href)) return true;
    const t = P.linkTarget(fromPath, href);
    // A bare `#heading` points at the page itself: it is never missing.
    if (!t || !t.path || t.path === P.normalize(fromPath)) return true;
    if (existsCached(t.path) === false) {
      out.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'link-missing' }));
    }
    return true;
  });
  return DecorationSet.create(doc, out);
}

/**
 * The decoration plugin. `wikitrigger.ts` (the module `extensions.ts` lists) returns it
 * alongside its own, so this file needs no seam of its own. `o.pagePath()` is the file being
 * edited, which is what every relative href is resolved against.
 */
export function missingLinkPlugin(o) {
  const pathOf = () => (typeof o?.pagePath === 'function' ? o.pagePath() || '' : '');
  return [
    new Plugin({
      key: KEY,
      state: {
        init: (_cfg, state) => missingDecorations(state.doc, pathOf()),
        apply(tr, old) {
          if (tr.getMeta(KEY)) return missingDecorations(tr.doc, pathOf());
          return tr.docChanged ? missingDecorations(tr.doc, pathOf()) : old;
        },
      },
      props: { decorations: (state) => KEY.getState(state) },
      view: (view) => {
        // One repaint when an answer lands, for every live view: a parked page (M12) comes
        // back with its links drawn as they are now, not as they were when it was left.
        const redraw = () => { try { view.dispatch(view.state.tr.setMeta(KEY, true)); } catch { /* gone */ } };
        redraws.add(redraw);
        return { destroy: () => { redraws.delete(redraw); } };
      },
    }),
  ];
}

/* ------------------------------------------------------------------ commands */

/** The link mark under the caret (or under the selection's start), as written. */
export function hrefAtCaret(view) {
  if (!view) return '';
  const { state } = view;
  const $from = state.selection.$from;
  const markOf = (marks) => (marks || []).find((m) => m.type.name === 'link');
  let mark = markOf(state.selection.$from.marks());
  // At the very start of a link the caret carries the marks of what is before it; look one
  // character forward as well, which is what "the link under the cursor" means to a reader.
  if (!mark) {
    const after = $from.nodeAfter;
    if (after) mark = markOf(after.marks);
  }
  if (!mark) {
    const before = $from.nodeBefore;
    if (before) mark = markOf(before.marks);
  }
  return mark ? String(mark.attrs.href || '') : '';
}

export function registerLinkCommands(api) {
  // In Live (wave 3) the link under the caret is the Live view's to find and follow.
  const inLive = () => !!(api.isLive && api.isLive());
  commands.register({
    id: 'page.follow-link',
    title: 'Follow link under cursor',
    group: 'page',
    hint: 'the link the caret is in',
    when: () => !!(api.hasPage && api.hasPage() && (inLive() || hrefAtCaret(api.getView()))),
    run: () => {
      if (inLive()) {
        if (!api.liveRun('page.follow-link')) toast('no link under the cursor', 'info', 2000);
        return;
      }
      const view = api.getView();
      const href = hrefAtCaret(view);
      if (!href) { toast('no link under the cursor', 'info', 2000); return; }
      void followHref(href, api.getPath());
    },
  });
}
