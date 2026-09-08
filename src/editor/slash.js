// The slash menu.
//
// Crepe's own BlockEdit menu only opens on an empty block and only filters by substring, so it
// is switched off in crepe.js and this module replaces it: its own SlashProvider (positioning,
// debounce, show/hide), its own DOM in the app's `.surface` / `.row` idiom, and its own item
// list, which is exactly the list CONTRACT.md fixes.
//
// Trigger: `/` at the start of a text block, or right after a space anywhere in one. Never in a
// code block, never inside inline code.
//
// Selecting an item first removes the `/` and the filter text, then acts:
//   text items    convert the current block (setBlockType / wrapIn, lifting out of a list first)
//   block items   insert after the current block, or replace it when it is empty
//   Date          inserts YYYY-MM-DD at the caret
//   page / os     run the registry command of the same name

import { commands } from '../registry.js';
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core';
import { SlashProvider } from '@milkdown/kit/plugin/slash';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { canJoin } from '@milkdown/kit/prose/transform';
import { findParent } from '@milkdown/kit/prose';
import {
  blockquoteSchema, bulletListSchema, codeBlockSchema, headingSchema, hrSchema,
  liftListItemCommand, listItemSchema, orderedListSchema, paragraphSchema,
  selectTextNearPosCommand, setBlockTypeCommand, wrapInBlockTypeCommand,
} from '@milkdown/kit/preset/commonmark';
import { createTable } from '@milkdown/kit/preset/gfm';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { today } from './paths.js';
import { insertPageLink } from './link.js';

const SLASH_KEY = new PluginKey('os-slash');
const MAX_QUERY = 24;

// Every menu that is currently on screen. The block keymap asks before it acts on a key, so
// Esc and the arrows belong to the menu while it is open (CONTRACT.md batch 5).
const openMenus = new Set();
export const slashMenuOpen = () => openMenus.size > 0;

// ---------------------------------------------------------------------------
// icons (DESIGN.md: 16px, 1.5px stroke, currentColor; base.css `.row svg` sets the stroke)

const I = {
  text: '<path d="M5 7h14M5 12h10M5 17h7"/>',
  h1: '<path d="M4 6v12M12 6v12M4 12h8"/><path d="M16.5 9.6 19 8.2V18"/>',
  h2: '<path d="M4 6v12M12 6v12M4 12h8"/><path d="M16.2 10a2.1 2.1 0 1 1 3.7 1.4L16.2 18H20"/>',
  quote: '<path d="M5 5.5v13"/><path d="M10 8h9M10 12h9M10 16h6"/>',
  hr: '<path d="M4 12h16"/>',
  ul: '<path d="M9.5 7h10M9.5 12h10M9.5 17h10"/><circle cx="5" cy="7" r="1.1"/><circle cx="5" cy="12" r="1.1"/><circle cx="5" cy="17" r="1.1"/>',
  ol: '<path d="M10 7h10M10 12h10M10 17h10"/><path d="M4 6 5.6 5v4.2"/><path d="M3.8 13.2a1.3 1.3 0 1 1 2.2 1L3.8 17H6.2"/>',
  todo: '<rect x="3.5" y="4.5" width="6" height="6" rx="1"/><path d="m5 7.4 1.4 1.4 2.3-2.5"/><rect x="3.5" y="13.5" width="6" height="6" rx="1"/><path d="M13 7.5h7M13 16.5h7"/>',
  image: '<rect x="3.5" y="5.5" width="17" height="13" rx="1"/><circle cx="9" cy="10.2" r="1.4"/><path d="m4.2 16.4 4.6-4 3.9 3.4L16 12l4.4 4.4"/>',
  code: '<path d="m9 8-5 4 5 4M15 8l5 4-5 4"/>',
  table: '<rect x="3.5" y="5.5" width="17" height="13" rx="1"/><path d="M3.5 10.2h17M9.7 10.2v8.3M15.2 10.2v8.3"/>',
  link: '<path d="M10.6 13.4a3.8 3.8 0 0 0 5.4 0l2.4-2.4a3.8 3.8 0 0 0-5.4-5.4l-1.3 1.3"/><path d="M13.4 10.6a3.8 3.8 0 0 0-5.4 0l-2.4 2.4a3.8 3.8 0 0 0 5.4 5.4l1.3-1.3"/>',
  date: '<rect x="3.5" y="5.5" width="17" height="14" rx="1"/><path d="M3.5 10.2h17M8 3.5v4M16 3.5v4"/>',
  rename: '<path d="m4 20 .8-3.5L15.4 6a1.6 1.6 0 0 1 2.2 0l.5.5a1.6 1.6 0 0 1 0 2.2L7.5 19.2 4 20Z"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.9 13h9.2l.9-13"/>',
  reveal: '<path d="M3.5 6.5h5.6l1.8 2h9.6v11H3.5z"/>',
  month: '<rect x="3.5" y="3.5" width="17" height="17" rx="1"/><path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17"/>',
  week: '<path d="M4 8.5v7M7.2 6.5v11M10.4 8.5v7M13.6 4.5v15M16.8 8.5v7M20 6.5v11"/>',
  day: '<rect x="3.5" y="3.5" width="17" height="17" rx="1"/><circle cx="12" cy="12" r="1.8"/>',
  journal: '<path d="M4.5 6a1.5 1.5 0 0 1 1.5-1.5h12v15H6A1.5 1.5 0 0 1 4.5 18Z"/><path d="M8.5 9h7M8.5 13h5"/>',
  journalNew: '<path d="M4.5 6.5h9M4.5 11.5h6M4.5 16.5h6"/><path d="M16.5 12v8M12.5 16h8"/>',
};

// ---------------------------------------------------------------------------
// document edits

const call = (ctx, key, payload) => ctx.get(commandsCtx).call(key, payload);
const inList = ($pos) => !!findParent((n) => n.type.name === 'list_item')($pos);

/** Lift the current block out of every list it sits in, so `/h1` on a list item is a heading. */
function liftOutOfList(ctx) {
  const view = ctx.get(editorViewCtx);
  for (let i = 0; i < 10 && inList(view.state.selection.$from); i++) {
    if (!call(ctx, liftListItemCommand.key)) break;
  }
}

/** Turn the current block into `nodeType`, out of any list first. */
function turnInto(ctx, type, attrs) {
  liftOutOfList(ctx);
  call(ctx, setBlockTypeCommand.key, { nodeType: type(ctx), attrs: attrs || null });
}

/** Wrap the current block in `nodeType`, out of any list first (so lists convert to lists). */
function wrapInto(ctx, type, attrs, join) {
  liftOutOfList(ctx);
  call(ctx, wrapInBlockTypeCommand.key, { nodeType: type(ctx), attrs: attrs || null });
  if (join) joinNeighbourLists(ctx);
}

/**
 * Merge the list the caret is in with an identical list touching it.
 *
 * Two adjacent bullet lists cannot be written as markdown without alternating the bullet
 * marker, so leaving them apart would rewrite `- one` as `* one` in a list the user never
 * touched. One list is both the faithful reading of the markdown and the one that serialises
 * back unchanged.
 */
function joinNeighbourLists(ctx) {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const $from = state.selection.$from;
  let d = $from.depth;
  while (d > 0 && !/_list$/.test($from.node(d).type.name)) d--;
  if (d === 0) return;
  let tr = state.tr;
  let joined = false;
  for (const pos of [$from.after(d), $from.before(d)]) {
    const $pos = tr.doc.resolve(pos);
    // Same type only: ProseMirror would happily join an ordered list into a bullet list,
    // because their content matches, and the ordered list would silently lose its numbers.
    if ($pos.nodeBefore && $pos.nodeAfter && $pos.nodeBefore.type === $pos.nodeAfter.type
        && canJoin(tr.doc, pos)) {
      tr = tr.join(pos);
      joined = true;
    }
  }
  if (joined) view.dispatch(tr);
}

/**
 * A whole block, not a conversion: it goes after the current block, or in its place when the
 * block is empty (CONTRACT.md). `make` returns a ProseMirror node.
 */
function putBlock(ctx, make) {
  const view = ctx.get(editorViewCtx);
  const node = make(ctx);
  if (!node) return;
  const { state } = view;
  const $from = state.selection.$from;
  const d = $from.depth;
  const empty = $from.parent.isTextblock && $from.parent.content.size === 0;
  const at = empty ? $from.before(d) : $from.after(d);
  const tr = empty
    ? state.tr.replaceWith(at, $from.after(d), node)
    : state.tr.insert(at, node);
  // A container (code block, table) takes the caret; a rule or an image hands it to the block
  // after it, and gets an empty paragraph to hand it to when it was inserted at the end.
  const inside = node.isTextblock || node.type.name === 'table';
  const end = at + node.nodeSize;
  if (!inside) {
    const next = tr.doc.resolve(end).nodeAfter;
    if (!next || !next.isTextblock) tr.insert(end, paragraphSchema.type(ctx).createAndFill());
  }
  view.dispatch(tr);
  call(ctx, selectTextNearPosCommand.key, { pos: at + (inside ? 1 : node.nodeSize) });
}

function insertText(ctx, text) {
  const view = ctx.get(editorViewCtx);
  view.dispatch(view.state.tr.insertText(text));
}

// ---------------------------------------------------------------------------
// the menu, exactly as CONTRACT.md lists it

const GROUPS = [
  {
    key: 'blocks', label: 'blocks', items: [
      { key: 'text', label: 'Text', icon: I.text, aliases: ['p', 'text', 'paragraph'], onRun: (c) => turnInto(c, paragraphSchema.type) },
      { key: 'h1', label: 'Heading 1', icon: I.h1, aliases: ['h1', 'heading1', 'title'], onRun: (c) => turnInto(c, headingSchema.type, { level: 1 }) },
      { key: 'h2', label: 'Heading 2', icon: I.h2, aliases: ['h2', 'heading2'], onRun: (c) => turnInto(c, headingSchema.type, { level: 2 }) },
      { key: 'quote', label: 'Quote', icon: I.quote, aliases: ['quote', 'blockquote'], onRun: (c) => wrapInto(c, blockquoteSchema.type) },
      { key: 'hr', label: 'Divider', icon: I.hr, aliases: ['hr', 'divider', 'rule', 'line'], onRun: (c) => putBlock(c, (x) => hrSchema.type(x).createAndFill()) },
      { key: 'ul', label: 'Bullet list', icon: I.ul, aliases: ['ul', 'bullet', 'list'], onRun: (c) => wrapInto(c, bulletListSchema.type, null, true) },
      { key: 'ol', label: 'Ordered list', icon: I.ol, aliases: ['ol', 'numbered', 'ordered'], onRun: (c) => wrapInto(c, orderedListSchema.type, null, true) },
      { key: 'todo', label: 'Task list', icon: I.todo, aliases: ['todo', 'task', 'check', 'checkbox'], onRun: (c) => wrapInto(c, listItemSchema.type, { checked: false }, true) },
      { key: 'image', label: 'Image', icon: I.image, aliases: ['img', 'image', 'picture'], onRun: (c) => putBlock(c, (x) => imageBlockSchema.type(x).createAndFill()) },
      { key: 'code', label: 'Code', icon: I.code, aliases: ['code', 'pre'], onRun: (c) => putBlock(c, (x) => codeBlockSchema.type(x).createAndFill()) },
      { key: 'table', label: 'Table', icon: I.table, aliases: ['table'], onRun: (c) => putBlock(c, (x) => createTable(x, 3, 3)) },
      { key: 'date', label: 'Date', icon: I.date, aliases: ['date', 'today'], inline: true, onRun: (c) => insertText(c, today()) },
      // No `inline`: the space in front of the `/` is removed with it and comes back only
      // when a page is actually chosen, so cancelling the picker leaves no trailing space.
      { key: 'link', label: 'Link', icon: I.link, aliases: ['link', 'page', 'ref'], onRun: (c, at) => void insertPageLink(c.get(editorViewCtx), at) },
    ],
  },
  {
    key: 'page', label: 'page', items: [
      { key: 'rename', label: 'Rename', icon: I.rename, aliases: ['rename'], cmd: 'page.rename' },
      { key: 'trash', label: 'Move to trash', icon: I.trash, aliases: ['trash', 'delete'], cmd: 'page.trash' },
      { key: 'reveal', label: 'Reveal in Explorer', icon: I.reveal, aliases: ['reveal', 'explorer'], cmd: 'page.reveal' },
    ],
  },
  {
    key: 'os', label: 'os', items: [
      { key: 'month', label: 'Month', icon: I.month, aliases: ['month'], cmd: 'view.month' },
      { key: 'week', label: 'Week', icon: I.week, aliases: ['week'], cmd: 'view.week' },
      { key: 'day', label: 'Day', icon: I.day, aliases: ['day'], cmd: 'view.day' },
      { key: 'journal', label: 'Journal', icon: I.journal, aliases: ['journal'], cmd: 'view.journal' },
      { key: 'journal-new', label: 'New journal entry', icon: I.journalNew, aliases: ['entry'], cmd: 'journal.new' },
    ],
  },
];

/** Items whose command is registered and currently allowed. Static items always show. */
function available() {
  return GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => {
      if (!it.cmd) return true;
      const c = commands.get(it.cmd);
      return !!c && (!c.when || c.when());
    }),
  })).filter((g) => g.items.length);
}

// ---------------------------------------------------------------------------
// filtering: fuzzy subsequence over label and aliases, one skipped query character allowed

const TYPO = -70;
const boundary = (t, k) => k > 0 && !/[a-z0-9]/.test(t[k - 1]);

/**
 * Best subsequence score of `q` in `t`, or -Infinity. Higher is better. One query character
 * may be dropped, which is what makes `haeding` find Heading 1 — but not below three
 * characters, where a free skip would match `h1` against half the menu.
 */
function fuzzy(q, t) {
  if (!q) return 0;
  if (q.length > t.length + 1) return -Infinity;
  const typos = q.length >= 3 ? 1 : 0;
  const memo = new Map();
  const go = (qi, ti, skipped, run) => {
    if (qi === q.length) return 0;
    const key = ((qi * 64 + ti) * 2 + skipped) * 2 + (run ? 1 : 0);
    const seen = memo.get(key);
    if (seen !== undefined) return seen;
    let best = -Infinity;
    if (!skipped && typos) {                          // one typo: drop this query character
      const s = go(qi + 1, ti, 1, false);
      if (s > -Infinity) best = Math.max(best, s + TYPO);
    }
    for (let k = ti; k < t.length; k++) {
      if (t[k] !== q[qi]) continue;
      let gain = 12;
      if (k === 0) gain += 24;
      else if (boundary(t, k)) gain += 12;
      if (run && k === ti) gain += 16;                // contiguous with the previous match
      gain -= Math.min(k - ti, 12);
      const s = go(qi + 1, k + 1, skipped, true);
      if (s > -Infinity) best = Math.max(best, gain + s);
    }
    memo.set(key, best);
    return best;
  };
  return go(0, 0, 0, false);
}

/** Score one item against a lowercased query. -Infinity when it does not match at all. */
function score(q, item) {
  const label = item.label.toLowerCase();
  for (const a of item.aliases) if (a === q) return 100000;   // exact alias first
  if (label === q) return 90000;
  let best = -Infinity;
  for (const a of item.aliases) if (a.startsWith(q)) best = Math.max(best, 5000 + (32 - a.length));
  if (label.startsWith(q)) best = Math.max(best, 4000 + (48 - label.length));
  for (const t of [label, ...item.aliases]) {
    const s = fuzzy(q, t);
    if (s > -Infinity) best = Math.max(best, s);
  }
  return best;
}

/** Groups with their items filtered and sorted; groups ordered by their best item. */
function filtered(query) {
  const groups = available();
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out = [];
  for (const g of groups) {
    const scored = g.items
      .map((it, i) => ({ it, s: score(q, it), i }))
      .filter((r) => r.s > -Infinity)
      .sort((a, b) => b.s - a.s || a.i - b.i);
    if (scored.length) out.push({ ...g, items: scored.map((r) => r.it), top: scored[0].s });
  }
  return out.sort((a, b) => b.top - a.top);
}

// ---------------------------------------------------------------------------
// trigger

/**
 * The `/…` under the caret, or null. `/` counts at the start of a text block or right after a
 * space; the query stops at the next space, so typing a space closes the menu.
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
  const i = before.lastIndexOf('/');
  if (i < 0) return null;
  if (i > 0 && !/\s/.test(before[i - 1])) return null;
  const query = before.slice(i + 1);
  if (query.length > MAX_QUERY || /[\s/]/.test(query)) return null;
  return {
    from: $from.pos - ($from.parentOffset - i),
    to: $from.pos,
    query,
    // `foo /h1` must leave `foo`, not `foo ` — a trailing space is not written to the vault.
    // Only when the `/…` ends the block, and never for Date, which inserts text in its place.
    space: before[i - 1] === ' ' && $from.parentOffset === parent.content.size,
  };
}

// ---------------------------------------------------------------------------
// the view

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

class SlashView {
  constructor(ctx, editorView) {
    this.ctx = ctx;
    this.dom = editorView.dom;
    this.items = [];
    this.index = 0;
    this.query = null;
    this.shown = false;
    this.dismissed = null;

    const el = document.createElement('div');
    el.className = 'os-slash surface';
    el.setAttribute('role', 'listbox');
    el.dataset.show = 'false';
    this.el = el;

    // Keep the caret where it is: a pointerdown in the menu must not blur the editor.
    el.addEventListener('pointerdown', (e) => e.preventDefault());
    el.addEventListener('pointerup', (e) => {
      const row = e.target instanceof Element ? e.target.closest('.row') : null;
      if (row) this.run(this.items[+row.dataset.i]);
    });
    el.addEventListener('pointermove', (e) => {
      const row = e.target instanceof Element ? e.target.closest('.row') : null;
      if (row) this.select(+row.dataset.i, false);
    });

    this.onKey = (e) => this.key(e);
    window.addEventListener('keydown', this.onKey, true);
    // A click outside the editor changes no state, so the provider would never be asked again
    // and the menu would stay floating over the page. The delay lets focus land first, and it
    // is a timer rather than a frame because a hidden window paints none.
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
    this.provider.onShow = () => { this.shown = true; openMenus.add(this); };
    this.provider.onHide = () => { this.shown = false; this.query = null; openMenus.delete(this); };
  }

  update(view, prevState) { this.provider.update(view, prevState); }

  hide() { this.provider.hide(); }

  /** The live editor view, or null once the editor has been destroyed. */
  view() {
    try { return this.ctx.get(editorViewCtx); } catch { return null; }
  }

  destroy() {
    openMenus.delete(this);
    window.removeEventListener('keydown', this.onKey, true);
    this.dom.removeEventListener('blur', this.onBlur);
    this.provider.destroy();
    this.el.remove();
  }

  shouldShow(view) {
    const m = matchAt(view);
    // Esc dismisses this `/`, and typing on does not bring it back; a new `/` does.
    if (!m) { this.dismissed = null; return false; }
    if (this.dismissed === m.from) return false;
    const groups = filtered(m.query);
    if (!groups.length) return false;
    this.render(groups, m.query);
    return true;
  }

  render(groups, query) {
    const fresh = query !== this.query;
    this.query = query;
    const frag = document.createDocumentFragment();
    this.items = [];
    for (const g of groups) {
      const label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = g.label;
      frag.append(label);
      for (const it of g.items) {
        const i = this.items.length;
        this.items.push(it);
        const row = document.createElement('div');
        row.className = 'row';
        row.dataset.i = String(i);
        row.setAttribute('role', 'option');
        row.innerHTML = `<svg viewBox="0 0 24 24">${it.icon}</svg><span class="grow">${esc(it.label)}</span>`;
        frag.append(row);
      }
    }
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
    if (!this.shown || e.ctrlKey || e.metaKey || e.altKey) return;
    const view = this.view();
    // The menu never eats a key for anything else: if the editor is not the focus any more,
    // it should not be open at all.
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
    if (e.key === 'Enter' || e.key === 'Tab') { stop(); this.run(this.items[this.index]); }
  }

  /** Remove the `/query`, then act. The range is re-read: the menu is 20ms behind the caret. */
  run(item) {
    if (!item) return;
    const view = this.view();
    if (!view) return;
    const m = matchAt(view);
    this.hide();
    if (m) {
      const from = m.space && !item.inline ? m.from - 1 : m.from;
      if (m.to > from) view.dispatch(view.state.tr.delete(from, m.to));
    }
    try {
      if (item.cmd) setTimeout(() => commands.run(item.cmd), 0);   // let the menu close first
      else item.onRun(this.ctx, { space: !!(m && m.space) });
    } catch (err) {
      console.error('[slash]', item.key, err);
    }
    view.focus();
  }
}

/** The ProseMirror plugin. `crepe.js` concatenates it onto `prosePluginsCtx`. */
export function slashPlugin(ctx) {
  let self = null;
  return new Plugin({
    key: SLASH_KEY,
    view: (editorView) => {
      self = new SlashView(ctx, editorView);
      return {
        update: (view, prev) => self && self.update(view, prev),
        destroy: () => { if (self) self.destroy(); self = null; },
      };
    },
  });
}
