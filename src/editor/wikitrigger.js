// `[[` (batch 12, package P7, N1 and N13).
//
// Obsidian's most-used key. Typing `[[` opens a page picker where the caret is — anchored like
// the slash menu, filtered by the quick-open matcher, so the same three characters find the
// same page here, in Ctrl+P and in the Link command. Enter inserts a **markdown** link with
// the page's title. Wiki-link syntax is never written to a file and never rendered: the vault
// stays ordinary markdown that any tool can read (docs/CONTRACT.md, D3).
//
// A name nothing matches offers `Create "<name>"`, which writes `<current folder>/<name>.md`
// with an H1 and links it. `]]` or Esc closes the menu and leaves what was typed exactly as it
// was typed, so `[[not a link]]` can still be written by hand.

import { SlashProvider } from '@milkdown/kit/plugin/slash';
import { editorViewCtx } from '@milkdown/kit/core';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { findParent } from '@milkdown/kit/prose';
import { esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { allPages } from '../shell/sidebar.js';
import { recentFiles } from '../shell/router.js';
import { pageItems, highlight } from '../shell/fuzzy.js';
import { toast } from './deps.js';
import { insertLink, pageTitle, hrefFor } from './link.js';
import { missingLinkPlugin, registerLinkCommands } from './linkstate.js';
import * as P from './paths.js';

const KEY = new PluginKey('os-wikitrigger');
/** A page name longer than this is not what `[[` is for; the menu closes rather than crawl. */
const MAX_QUERY = 64;
const MAX_ROWS = 40;

/**
 * The `[[…` under the caret, or null. The two brackets may sit anywhere in a text block; the
 * query runs to the caret and stops at the first `]`, `[` or newline, so `]]` closes the menu
 * and a second `[[` starts a new one.
 */
function matchAt(view) {
  if (!view.editable || !view.hasFocus()) return null;
  const { state } = view;
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $from = sel.$from;
  const parent = $from.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  if (findParent((n) => n.type.name === 'code_block')($from)) return null;
  for (const m of state.storedMarks || $from.marks()) {
    if (m.type.name === 'inlineCode' || m.type.spec.code) return null;
  }
  const before = parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const i = before.lastIndexOf('[[');
  if (i < 0) return null;
  const query = before.slice(i + 2);
  if (query.length > MAX_QUERY || /[[\]\n]/.test(query)) return null;
  return { from: $from.pos - ($from.parentOffset - i), to: $from.pos, query };
}

/** `<folder>/<name>.md`, numbered when taken. The folder is the open page's own. */
async function freePath(folder, base) {
  const dir = folder ? folder + '/' : '';
  let candidate = `${dir}${base}.md`;
  for (let n = 2; n < 500 && await bridge.exists(candidate); n++) candidate = `${dir}${base} ${n}.md`;
  return candidate;
}

/** A file name from what was typed: no separators, no Windows-reserved characters. */
const cleanName = (name) =>
  String(name).replace(/[\\/:*?"<>|[\]]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.md$/i, '').replace(/[. ]+$/, '');

class WikiView {
  constructor(ctx, editorView, pagePath) {
    this.ctx = ctx;
    this.pagePath = pagePath;
    this.dom = editorView.dom;
    this.items = [];
    this.index = 0;
    this.query = null;
    this.shown = false;
    this.dismissed = null;
    this.busy = false;

    const el = document.createElement('div');
    el.className = 'os-slash os-wiki surface';
    el.setAttribute('role', 'listbox');
    el.dataset.show = 'false';
    this.el = el;

    // A pointerdown in the menu must not blur the editor, or the caret moves under us.
    el.addEventListener('pointerdown', (e) => e.preventDefault());
    el.addEventListener('pointerup', (e) => {
      const row = e.target instanceof Element ? e.target.closest('.row') : null;
      if (row) void this.run(this.items[+row.dataset.i]);
    });
    el.addEventListener('pointermove', (e) => {
      const row = e.target instanceof Element ? e.target.closest('.row') : null;
      if (row) this.select(+row.dataset.i, false);
    });

    this.onKey = (e) => this.key(e);
    window.addEventListener('keydown', this.onKey, true);
    this.onBlur = () => setTimeout(() => {
      const v = this.view();
      if (!v || !v.hasFocus()) this.hide();
    }, 0);
    this.dom.addEventListener('blur', this.onBlur);

    this.provider = new SlashProvider({
      content: el,
      debounce: 20,
      offset: 8,
      shouldShow: (view) => this.shouldShow(view),
    });
    this.provider.onShow = () => { this.shown = true; };
    this.provider.onHide = () => { this.shown = false; this.query = null; };
  }

  update(view, prevState) { this.provider.update(view, prevState); }
  hide() { this.provider.hide(); }
  view() { try { return this.ctx.get(editorViewCtx); } catch { return null; } }

  destroy() {
    window.removeEventListener('keydown', this.onKey, true);
    this.dom.removeEventListener('blur', this.onBlur);
    this.provider.destroy();
    this.el.remove();
  }

  shouldShow(view) {
    const m = matchAt(view);
    // Esc dismisses this `[[`; typing on does not bring it back, a new `[[` does.
    if (!m) { this.dismissed = null; return false; }
    if (this.dismissed === m.from) return false;
    this.render(m.query);
    return true;
  }

  render(query) {
    const fresh = query !== this.query;
    this.query = query;
    const here = this.pagePath();
    const pages = pageItems(allPages(), query, { recent: recentFiles(), limit: MAX_ROWS })
      .filter((it) => it.path !== here);
    const name = cleanName(query);
    // The create row is offered whenever a name has been typed and nothing carries it
    // exactly; a partial match is still a match worth choosing, so it never comes first.
    const exact = pages.some((it) => it.title.toLowerCase() === query.trim().toLowerCase());
    this.items = pages.map((it) => ({ kind: 'page', path: it.path, title: it.title, hint: it.hint, hits: it.hits }));
    if (name && !exact) this.items.push({ kind: 'create', name, title: `Create "${name}"`, hint: 'new page' });

    const frag = document.createDocumentFragment();
    if (!this.items.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = 'type a page name';
      frag.append(d);
    }
    this.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'row' + (it.kind === 'create' ? ' os-wiki-create' : '');
      row.dataset.i = String(i);
      row.setAttribute('role', 'option');
      row.innerHTML = `<span class="grow">${it.kind === 'page' ? highlight(it.title, it.hits) : esc(it.title)}</span>`
        + (it.hint ? `<span class="hint">${esc(it.hint)}</span>` : '');
      frag.append(row);
    });
    this.el.replaceChildren(frag);
    this.select(fresh ? 0 : this.index, false);
  }

  select(i, scroll = true) {
    if (!this.items.length) return;
    this.index = Math.max(0, Math.min(i, this.items.length - 1));
    for (const row of this.el.querySelectorAll('.row')) {
      const on = +row.dataset.i === this.index;
      row.classList.toggle('current', on);
      if (on && scroll) row.scrollIntoView({ block: 'nearest' });
    }
  }

  key(e) {
    if (e.isComposing || e.keyCode === 229) return;                  // E44
    if (!this.shown || e.ctrlKey || e.metaKey || e.altKey) return;
    const view = this.view();
    if (!view || !view.hasFocus()) { this.hide(); return; }
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') {
      stop();
      const m = matchAt(view);
      this.dismissed = m ? m.from : null;
      this.hide();
      return;
    }
    if (e.key === 'ArrowDown') { stop(); this.select(this.index + 1); return; }
    if (e.key === 'ArrowUp') { stop(); this.select(this.index - 1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (!this.items.length) return;
      stop();
      void this.run(this.items[this.index]);
    }
  }

  /** Replace `[[query` with a markdown link to the chosen (or created) page. */
  async run(item) {
    if (!item || this.busy) return;
    const view = this.view();
    if (!view) return;
    const m = matchAt(view);
    this.hide();
    if (!m) return;
    const from = this.pagePath();

    let target = item.path;
    if (item.kind === 'create') {
      this.busy = true;
      try {
        target = await freePath(P.dirname(from), item.name);
        await bridge.writeText(target, `# ${item.name}\n`);
      } catch (err) {
        toast('could not create the page: ' + (err.message || err), 'err');
        this.busy = false;
        return;
      }
      this.busy = false;
    }

    const title = item.kind === 'create' ? item.name : await pageTitle(target);
    // The range is re-read: the menu is 20ms behind the caret, and creating a page awaited a
    // write. If the text has moved on, the link goes where the `[[` still is, or nowhere.
    const now = matchAt(view);
    const range = now || m;
    insertLink(view, title, hrefFor(from, target), { from: range.from, to: range.to });
  }
}

/**
 * `extensions.js` asks for this. It is also the seam for `linkstate.js` (the broken-link
 * decoration and the follow-link command), which is a sibling library rather than a module of
 * its own so that `extensions.js` needs no change for batch 12.
 */
export function plugins(ctx, o) {
  const pagePath = () => (typeof o?.pagePath === 'function' ? o.pagePath() || '' : '');
  let self = null;
  return [
    ...missingLinkPlugin(o),
    new Plugin({
      key: KEY,
      view: (editorView) => {
        self = new WikiView(ctx, editorView, pagePath);
        return {
          update: (view, prev) => self && self.update(view, prev),
          destroy: () => { if (self) self.destroy(); self = null; },
        };
      },
    }),
  ];
}

/** `page.follow-link`; see linkstate.js. */
export function registerCommands(api) { registerLinkCommands(api); }
