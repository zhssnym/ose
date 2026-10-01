// The tab strip: one tab per open place, above the page column (M23).
//
// The core owns the tabs (docs/CORE.md `ose.tabs`): each tab has its own back and forward
// history, one tab is in front, and only its current entry is mounted in the column. This file
// draws what `ose.tabs.on` says and nothing more — it keeps no list of its own — and registers
// the tab commands. A page in a background tab keeps its editor alive, parked, so switching
// back is instant and keeps the undo history (docs/CORE.md "How a page is left").
//
// The model is the editor's, not the browser's. An **ordinary** open — a click or Enter in the
// tree, quick open, a link, back, forward — goes into the tab in front, into its history. A tab
// is made **on purpose**: middle click or Ctrl+Enter on a row, Ctrl+click, `tab.new` (Ctrl+T),
// Ctrl+Shift+T. One tab is no strip at all: it appears at two and the page column takes the
// room back. Closing the last tab sends it Home rather than leaving the strip empty.

import { ose } from 'ose:core';
import { icon } from 'ose:ui';
import { HOME } from './start.js';
import { clean, baseName, titleOf, keyOf, vaultName, isOutside, outsideLabel } from './paths.js';

const { bus, commands } = ose;

let strip = null;
// The page column: the strip's `tabpanel`, so a reader can be told which tab names what is on
// screen. The router owns everything inside it; only the two aria attributes are ours.
let panelEl = null;
// The last snapshot the core sent: `{ tabs: Tab[], active: id|null }`.
/** @type {{tabs: Array<{id: string, route: {type: string, path?: string, name?: string} | null, canBack: boolean, canForward: boolean}>, active: string|null}} */
let snap = { tabs: [], active: null };
// Paths whose page has unsaved changes, from the editor's own `doc:dirty` / `doc:state`.
const dirty = new Set();
// Paths whose page could not be written, or is gone from disk, from `doc:state` (H8):
// `{ status, message }` for `not-saved`, `conflict` and `deleted`.
const trouble = new Map();
// Where the keyboard goes once a tab closed with Delete has been drawn away: the place in the
// strip that tab held. Set by the Delete key and spent by the next draw.
let refocusAt = -1;
let refocusTimer = null;

const api = ose.tabs;
const isHome = (r) => keyOf(r) === keyOf(HOME);

/* ------------------------------------------------------------------ labels */

/** What a tab says: the file's name, the folder's (the vault's at the root), the view's title. */
function labelOf(r) {
  if (!r) return '';
  if (r.type === 'view') {
    const v = ose.views.get(r.name);
    return (v && v.title) || r.name;
  }
  if (r.type === 'folder') return clean(r.path) ? baseName(r.path) : vaultName();
  return titleOf(r.path) || baseName(r.path);
}

/** A page whose file is outside the vault (X7): its tab wears the mark. */
const outsideOf = (r) => !!r && r.type === 'page' && isOutside(r.path);

/**
 * The tooltip: the whole vault path of a file or a folder, the title of a view. A file
 * outside the vault shows its full absolute path, and says where it is.
 */
function tipOf(r) {
  if (!r) return '';
  if (r.type === 'view') return labelOf(r);
  if (outsideOf(r)) return `${outsideLabel(clean(r.path))} (outside the vault)`;
  const p = clean(r.path);
  return p || vaultName();
}

/**
 * Open a route in a tab of its own: the one way a tab is made on purpose. A route that already
 * has a tab brings that tab forward instead of a second one. Answers whether it is on screen.
 * @param {object} route
 * @returns {Promise<boolean>}
 */
export function openInNewTab(route) {
  if (!route) return Promise.resolve(false);
  return Promise.resolve(api.open(route))
    .then((r) => !!r && r.shown !== false, (e) => { console.error('[shell] open tab', e); return false; });
}

/* ------------------------------------------------------------------- draw */

function render() {
  if (!strip) return;
  const tabs = snap.tabs || [];
  // One tab is not a strip: it says nothing the title bar does not, and it costs the page
  // column a bar for the privilege. It comes back the moment there are two.
  strip.hidden = tabs.length < 2;
  // The nodes are kept, not redrawn. A click on a tab while the page in front is dirty blurs
  // the editor on mousedown, the blur saves, and the save's `doc:state` draws the strip again
  // before mouseup: a node rebuilt in between would never get the click. So each tab id keeps
  // its element, only what changed is written, and a node moves only when the order did.
  const have = new Map();
  for (const el of tabEls()) have.set(el.dataset.id, el);
  const wanted = new Set(tabs.map((t) => t.id));
  for (const [id, el] of have) if (!wanted.has(id)) el.remove();
  let activeDom = '';
  tabs.forEach((t, i) => {
    const on = t.id === snap.active;
    const domId = 'tab-' + t.id;
    if (on) activeDom = domId;
    const r = t.route;
    const path = r && r.type === 'page' ? clean(r.path) : null;
    const bad = path ? trouble.get(path) : null;
    const gone = !!bad && bad.status === 'deleted';
    const isDirty = !!path && dirty.has(path);
    const label = labelOf(r) + (gone ? ' (deleted)' : '');
    // Not saved, or changed on disk under an unsaved page: the error mark, with the editor's
    // own sentence as the tooltip. A page deleted on disk says so in its label, and wears the
    // mark only while it holds text that exists nowhere else.
    const err = !!bad && (bad.status !== 'deleted' || isDirty);
    const tip = bad && bad.message ? `${tipOf(r)}: ${bad.message}` : tipOf(r);
    const mark = err ? 'err' : isDirty ? 'dot' : '';
    const out = outsideOf(r);
    let el = have.get(t.id);
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('role', 'tab');
      el.dataset.id = t.id;
      el.innerHTML = '<span class="tab-name"></span>'
        + `<button type="button" class="tab-x" tabindex="-1" title="Close">${icon('close')}</button>`;
    }
    const cls = `tab${on ? ' on' : ''}${err ? ' err' : ''}${out ? ' outside' : ''}`;
    if (el.className !== cls) el.className = cls;
    if (el.id !== domId) el.id = domId;
    setAttr(el, 'aria-selected', on ? 'true' : 'false');
    setAttr(el, 'tabindex', on ? '0' : '-1');
    setAttr(el, 'title', tip);
    const name = el.querySelector('.tab-name');
    if (name.textContent !== label) name.textContent = label;
    setAttr(el.querySelector('.tab-x'), 'aria-label', `Close ${label}`);
    // The outside mark (X7): a word after the name, and the same in what a reader hears.
    setAttr(el, 'aria-label', out ? `${label}, outside vault` : label);
    const hadOut = el.querySelector('.tab-out');
    if (out && !hadOut) {
      const o = document.createElement('span');
      o.className = 'tab-out mono-sm';
      o.setAttribute('aria-hidden', 'true');
      o.textContent = 'outside vault';
      name.after(o);
    } else if (!out && hadOut) hadOut.remove();
    const had = el.querySelector('.tab-err, .tab-dot');
    const hadMark = had ? (had.classList.contains('tab-err') ? 'err' : 'dot') : '';
    if (hadMark !== mark) {
      if (had) had.remove();
      if (mark) {
        const m = document.createElement('span');
        m.className = mark === 'err' ? 'tab-err' : 'tab-dot';
        m.setAttribute('role', 'img');
        m.setAttribute('aria-label', mark === 'err' ? 'not saved' : 'unsaved changes');
        el.insertBefore(m, name);
      }
    }
    const at = strip.children[i];
    if (at !== el) strip.insertBefore(el, at || null);
  });
  if (!activeDom && strip.firstElementChild) strip.firstElementChild.tabIndex = 0;
  if (panelEl) {
    if (activeDom && !strip.hidden) panelEl.setAttribute('aria-labelledby', activeDom);
    else panelEl.removeAttribute('aria-labelledby');
  }
  const on = strip.querySelector('.tab.on');
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (refocusAt >= 0) {
    const rest = tabEls();
    if (rest.length && !strip.hidden) focusTab(rest[Math.min(refocusAt, rest.length - 1)]);
    clearRefocus();
  }
}

/** An attribute written only when it differs: a draw that changes nothing touches nothing. */
function setAttr(el, name, value) {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function refocusAfterClose(at) {
  refocusAt = at;
  clearTimeout(refocusTimer);
  refocusTimer = setTimeout(clearRefocus, 300);
}

function clearRefocus() {
  refocusAt = -1;
  clearTimeout(refocusTimer);
  refocusTimer = null;
}

/* ------------------------------------------------------------------ acting */

function activate(id) {
  if (!id || id === snap.active) return;
  void api.activate(id);
}

/**
 * Close one tab. The core asks its page first: a page that cannot be saved refuses (C1, H8),
 * the answer is false, its banner says why, and nothing on the strip changes.
 * @returns {Promise<boolean>}
 */
async function closeTab(id) {
  if (!id) return false;
  let ok = false;
  try { ok = (await api.close(id)) !== false; } catch (e) { console.error('[shell] close tab', e); ok = false; }
  if (!ok) clearRefocus();
  return ok;
}

function step(delta) {
  const tabs = snap.tabs || [];
  if (tabs.length < 2) return;
  const at = Math.max(0, tabs.findIndex((t) => t.id === snap.active));
  activate(tabs[(at + delta + tabs.length) % tabs.length]?.id);
}

const activeTab = () => (snap.tabs || []).find((t) => t.id === snap.active) || null;

/* -------------------------------------------------------------- the keyboard */

function tabEls() { return strip ? [...strip.querySelectorAll('.tab')] : []; }

function focusTab(el) {
  if (!el) return;
  for (const t of tabEls()) t.tabIndex = t === el ? 0 : -1;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function onKey(e) {
  const el = e.target.closest && e.target.closest('.tab');
  if (!el) return;
  const list = tabEls();
  const at = list.indexOf(el);
  const k = e.key;
  if ((k === 'ArrowRight' || k === 'ArrowLeft') && e.ctrlKey && e.shiftKey) {
    // Ctrl+Shift+Arrow carries the tab along the strip: the keyboard's drag.
    e.preventDefault();
    const to = Math.max(0, Math.min(list.length - 1, at + (k === 'ArrowRight' ? 1 : -1)));
    if (to !== at) { api.move(el.dataset.id, to); requestAnimationFrame(() => focusTab(strip.querySelector(`.tab[data-id="${CSS.escape(el.dataset.id)}"]`))); }
  } else if (k === 'ArrowRight' || k === 'ArrowLeft') {
    const next = list[(at + (k === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
    e.preventDefault();
    focusTab(next);
  } else if (k === 'Home' || k === 'End') {
    e.preventDefault();
    focusTab(k === 'Home' ? list[0] : list[list.length - 1]);
  } else if (k === 'Enter' || k === ' ') {
    e.preventDefault();
    activate(el.dataset.id);
  } else if (k === 'Delete' || k === 'Backspace') {
    e.preventDefault();
    refocusAfterClose(at);
    void closeTab(el.dataset.id);
  }
}

/* ------------------------------------------------------------------- mount */

/**
 * Build the strip into `node` and register the tab commands. `panel` is the page column, which
 * the strip names as its tabpanel. Before `ose.init`, so the first tab event is heard.
 * @param {HTMLElement} node
 * @param {HTMLElement} [panel]
 */
export function initTabs(node, panel) {
  strip = node;
  panelEl = panel || null;
  strip.className = 'tabs mono';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', 'Open tabs');
  if (panelEl) panelEl.setAttribute('role', 'tabpanel');

  strip.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const el = e.target.closest('.tab');
    if (!(el instanceof HTMLElement)) return;
    if (e.target.closest('.tab-x')) { void closeTab(el.dataset.id); return; }
    activate(el.dataset.id);
  });
  // Middle click closes, as it does in every browser and every editor.
  strip.addEventListener('mousedown', (e) => { if (e.button === 1 && e.target instanceof Element && e.target.closest('.tab')) e.preventDefault(); });
  strip.addEventListener('auxclick', (e) => {
    if (e.button !== 1 || !(e.target instanceof Element)) return;
    const el = e.target.closest('.tab');
    if (!(el instanceof HTMLElement)) return;
    e.preventDefault();
    void closeTab(el.dataset.id);
  });
  strip.addEventListener('keydown', onKey);

  api.on((d) => {
    snap = { tabs: (d && d.tabs) || api.list(), active: d && d.active !== undefined ? d.active : (api.active() || {}).id || null };
    render();
  });
  snap = { tabs: api.list(), active: (api.active() || {}).id || null };

  // The marks: the same events the title bar reads, so one page is never dirty in one place
  // and clean in the other. By path, so a file open in two tabs is marked in both.
  bus.on('doc:dirty', (d) => {
    if (!d || !d.path) return;
    if (d.dirty) dirty.add(clean(d.path)); else dirty.delete(clean(d.path));
    render();
  });
  bus.on('doc:saved', (d) => {
    if (!d || !d.path) return;
    dirty.delete(clean(d.path));
    render();
  });
  bus.on('doc:state', (d) => {
    if (!d || !d.path) return;
    const p = clean(d.path);
    if (d.status === 'not-saved' || d.status === 'conflict' || d.status === 'deleted') {
      trouble.set(p, { status: d.status, message: d.message || '' });
    } else {
      trouble.delete(p);
    }
    if (d.dirty) dirty.add(p); else dirty.delete(p);
    render();
  });
  // A rename moves the marks with the page: the tab follows its file (the core re-points it).
  bus.on('paths:moved', (d) => {
    for (const m of (d && d.moves) || []) {
      if (!m || !m.from || !m.to) continue;
      const a = clean(m.from), b = clean(m.to);
      const under = (p) => p === a || p.startsWith(a + '/');
      for (const p of [...dirty]) if (under(p)) { dirty.delete(p); dirty.add(b + p.slice(a.length)); }
      for (const [p, v] of [...trouble]) if (under(p)) { trouble.delete(p); trouble.set(b + p.slice(a.length), v); }
    }
    render();
  });
  // Labels follow the settings (hideMdExt) and the views the planner registers after boot.
  bus.on('settings', render);
  bus.on('booted', render);

  render();

  commands.register({
    id: 'tab.close', title: 'Close tab', group: 'navigate',
    hint: 'the tab in front', shortcut: 'Mod+W',
    // One tab left, on Home: there is nothing to close, and the chord says so.
    when: () => { const t = activeTab(); return !!t && ((snap.tabs || []).length > 1 || !isHome(t.route)); },
    run: () => closeTab(snap.active),
  });
  commands.register({
    id: 'tab.close-others', title: 'Close other tabs', group: 'navigate',
    hint: 'every tab but the one in front',
    when: () => (snap.tabs || []).length > 1,
    run: () => (snap.active ? api.closeOthers(snap.active) : false),
  });
  // A new tab opens Home: a tab has to hold a place, and Home is the place that means "I have
  // not picked yet".
  commands.register({
    id: 'tab.new', title: 'New tab', group: 'navigate',
    hint: 'a new tab, on Home', shortcut: 'Mod+T',
    run: () => api.open(HOME, { reuse: false }),
  });
  commands.register({
    id: 'tab.next', title: 'Next tab', group: 'navigate',
    shortcut: 'Mod+Tab', when: () => (snap.tabs || []).length > 1,
    run: () => step(1),
  });
  commands.register({
    id: 'tab.prev', title: 'Previous tab', group: 'navigate',
    shortcut: 'Mod+Shift+Tab', when: () => (snap.tabs || []).length > 1,
    run: () => step(-1),
  });
  commands.register({
    id: 'tab.focus', title: 'Focus tabs', group: 'navigate',
    hint: 'arrows walk the strip, Enter opens, Delete closes',
    when: () => !!strip && !strip.hidden,
    run: () => { const on = strip && (strip.querySelector('.tab.on') || strip.querySelector('.tab')); focusTab(on); },
  });
}
