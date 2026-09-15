// The tab strip: one tab per open route, above the page column.
//
// The kernel has one current route and a history stack, and it does not know the word "tab".
// This file is the whole of it: a rice-side list of routes that follows `ose.route.on` — a
// route that is not in the list joins it, a route that is becomes the active one — plus the
// close, cycle and reopen commands. A tab's identity is the kernel's own route key
// (`page:<path>`, `own:<path>`, `view:<name>`), so a page reached from the tree, from quick
// open and from a link is one tab, not three.
//
// The home tab (the dashboard) is always first and has no close button: closing the last real
// tab lands there, which is why there is always somewhere to land.
//
// Tabs are not restored across restarts. A window that opens on yesterday's twelve tabs is a
// window that owes you twelve decisions before you have made one.

import { ose } from 'ose:kernel';
import { icon, esc } from 'ose:ui';
import { clean, titleOf } from './paths.js';
import { HOME, HOME_TITLE } from './dashboard.js';

const { bus, store, commands, route } = ose;

// How many closed tabs Ctrl+Shift+T walks back through. The kernel keeps its own stack for
// `route.close()`; this one also holds the tabs closed while another one was in front.
const MAX_CLOSED = 20;

let strip = null;
// The page column: the strip's `tabpanel`, so a reader can be told which tab names what is
// on screen. The router owns everything inside it; only the two aria attributes are ours.
let panelEl = null;
// [{ key, route }] in the order they are drawn. tabs[0] is always the home tab.
let tabs = [];
let activeKey = null;
// The tab that was in front before this one: where a close goes back to.
let prevKey = null;
let closed = [];
// Route keys whose page has unsaved changes, from the editor's own `doc:dirty`.
const dirty = new Set();
// Until the rice has navigated once, a null route is the boot, not a close.
let armed = false;

/* ------------------------------------------------------------------ routes */

/** The kernel's own route key (src/kernel/router.js `routeKey`), spelled once here. */
function keyOf(r) {
  if (!r) return '';
  if (r.type === 'page') return 'page:' + clean(r.path);
  if (r.type === 'own') return 'own:' + clean(r.path);
  return 'view:' + r.name;
}

/**
 * What the tab reopens with. A line, a column, a heading or a query says where *one* open
 * lands and is not part of the page (the router spends them on the way in); the tab is the
 * page. An owned route keeps every field it came with: those are the module's, not ours.
 */
function keepRoute(r) {
  if (r.type === 'page') return { type: 'page', path: clean(r.path) };
  if (r.type === 'view') return { type: 'view', name: r.name };
  const out = { ...r, path: clean(r.path) };
  delete out.line; delete out.col; delete out.heading; delete out.query; delete out.selection;
  return out;
}

/**
 * A tab's label is what the window title says for that route: a page's H1 (the editor
 * publishes it on `pageTitle`) or its stem, a view's title, an owned route's title as its
 * module registered it through `ose.route.index`.
 */
function labelOf(r) {
  if (!r) return '';
  if (r.type === 'view') {
    const v = ose.views.get(r.name);
    return (v && v.title) || r.name;
  }
  if (r.type === 'page') {
    const known = store.get('pageTitle');
    const h1 = known && known.path === r.path ? String(known.title || '').trim() : '';
    return h1 || titleOf(r.path);
  }
  const own = ownTitles.get('own:' + clean(r.path));
  if (own) return own;
  const row = ose.route.indexed().find((x) => x.path === r.path);
  return (row && row.title) || titleOf(r.path);
}

// What `ose.route.title(text)` (or a mount's `title`) said for an owned route, by route key,
// off the kernel's `route:title` event; the index is the fallback for a route never mounted.
const ownTitles = new Map();

const isHome = (key) => key === keyOf(HOME);
const indexOf = (key) => tabs.findIndex((t) => t.key === key);

/* ------------------------------------------------------------------- draw */

function render() {
  if (!strip) return;
  let activeId = '';
  strip.innerHTML = tabs.map((t, i) => {
    const on = t.key === activeKey;
    const id = 'tab-' + i;
    if (on) activeId = id;
    const label = labelOf(t.route);
    const home = isHome(t.key);
    return `
      <div class="tab${on ? ' on' : ''}" id="${id}" role="tab" aria-selected="${on ? 'true' : 'false'}"
           tabindex="${on ? '0' : '-1'}" data-key="${esc(t.key)}" title="${esc(label)}">
        ${dirty.has(t.key) ? '<span class="tab-dot" aria-label="unsaved changes"></span>' : ''}
        <span class="tab-name">${esc(label)}</span>
        ${home ? '' : `<button type="button" class="tab-x" tabindex="-1" aria-label="Close ${esc(label)}" title="Close">${icon('close')}</button>`}
      </div>`;
  }).join('');
  // Nothing is selected while a close is in flight: the strip keeps one tab stop all the same,
  // so Tab never falls through a bar that is still on screen.
  if (!activeId && strip.firstElementChild) strip.firstElementChild.tabIndex = 0;
  // The page column is this strip's panel; say so, and say which tab names it.
  if (panelEl && activeId) panelEl.setAttribute('aria-labelledby', activeId);
  const on = strip.querySelector('.tab.on');
  if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/* ------------------------------------------------------------------ the list */

function onRoute(r) {
  if (!r) { onEmptySurface(); return; }
  armed = true;
  const key = keyOf(r);
  const at = indexOf(key);
  if (at < 0) tabs.push({ key, route: keepRoute(r) });
  else tabs[at].route = keepRoute(r);
  if (key !== activeKey) { prevKey = activeKey; activeKey = key; }
  render();
}

/**
 * The route went away: `route.close()`, which is what Ctrl+W and a trashed open page both
 * end at. The kernel has already put it on its own closed stack; the list drops the tab and
 * goes where a close goes. Called inside the `route` event, so the navigation happens before
 * the kernel has drawn its empty surface and nothing flashes.
 */
function onEmptySurface() {
  if (!armed || !activeKey) return;
  const key = activeKey;
  const next = neighbourOf(key);
  remember(key);
  drop(key);
  activeKey = null;
  render();
  if (next) void ose.route.navigate(next.route, { force: true });
}

/** Where closing `key` goes: the tab that was in front before it, else its neighbour, else home. */
function neighbourOf(key) {
  const at = indexOf(key);
  const rest = tabs.filter((t) => t.key !== key);
  if (!rest.length) return null;
  const prev = prevKey && prevKey !== key ? rest.find((t) => t.key === prevKey) : null;
  return prev || rest[Math.min(Math.max(0, at), rest.length - 1)];
}

function remember(key) {
  const t = tabs[indexOf(key)];
  if (!t || isHome(key)) return;
  closed = [t.route, ...closed.filter((r) => keyOf(r) !== key)].slice(0, MAX_CLOSED);
}

function drop(key) {
  const at = indexOf(key);
  if (at < 0) return;
  tabs.splice(at, 1);
  dirty.delete(key);
  if (prevKey === key) prevKey = null;
}

/**
 * Close one tab. The active one goes through the kernel — the editor's own `page.close` when
 * it is a page, so the buffer is saved, and `route.close()` otherwise — so the kernel's closed
 * stack is fed and `onEmptySurface` above does the rest. An inactive one is only a row in this
 * list and is dropped here.
 */
function closeTab(key) {
  if (indexOf(key) < 0 || isHome(key)) return;
  if (key !== activeKey) { remember(key); drop(key); render(); return; }
  const t = tabs[indexOf(key)];
  const save = commands.get('page.close');
  if (t.route.type === 'page' && save && (!save.when || save.when())) commands.run('page.close');
  else void ose.route.close();
}

/* ------------------------------------------------- what the tree does to a tab */

const under = (p, folder) => p === folder || p.startsWith(folder + '/');

/**
 * A page was renamed or moved: its tab follows it. Called by the sidebar before it navigates,
 * so the page keeps one tab instead of leaving a dead one behind at the old path. A folder
 * move carries every tab under it.
 */
export function moveTabs(from, to) {
  const a = clean(from), b = clean(to);
  let touched = false;
  for (const t of tabs) {
    if (t.route.type !== 'page' || !under(t.route.path, a)) continue;
    const path = b + t.route.path.slice(a.length);
    const key = 'page:' + path;
    if (dirty.delete(t.key)) dirty.add(key);
    if (activeKey === t.key) activeKey = key;
    if (prevKey === t.key) prevKey = key;
    t.key = key;
    t.route = { type: 'page', path };
    touched = true;
  }
  // A move onto a path that already had a tab leaves two rows with one key: keep the first.
  const seen = new Set();
  tabs = tabs.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));
  if (touched) render();
  return touched;
}

/**
 * A page (or a folder of them) was trashed: its tabs go, and if one of them was in front the
 * strip moves to where a close would have gone. Nothing is remembered — a trashed page is not
 * something Ctrl+Shift+T should bring back — and the editor is never asked to save it.
 */
export function closeTabsUnder(path, { focus = true } = {}) {
  const p = clean(path);
  const hits = tabs.filter((t) => t.route.type === 'page' && under(t.route.path, p));
  if (!hits.length) return false;
  const wasActive = hits.some((t) => t.key === activeKey);
  let next = wasActive ? neighbourOf(activeKey) : null;
  for (const t of hits) drop(t.key);
  if (!wasActive) { render(); return true; }
  if (!next || indexOf(next.key) < 0) next = tabs[0] || null;
  activeKey = null;
  render();
  if (next) void ose.route.navigate(next.route, { focus });
  return true;
}

/* -------------------------------------------------------------- the keyboard */

function tabEls() { return strip ? [...strip.querySelectorAll('.tab')] : []; }

function focusTab(el) {
  if (!el) return;
  for (const t of tabEls()) t.tabIndex = t === el ? 0 : -1;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function step(delta) {
  if (tabs.length < 2) return;
  const at = Math.max(0, indexOf(activeKey));
  const next = tabs[(at + delta + tabs.length) % tabs.length];
  void ose.route.navigate(next.route);
}

function onKey(e) {
  const el = e.target.closest && e.target.closest('.tab');
  if (!el) return;
  const list = tabEls();
  const at = list.indexOf(el);
  const k = e.key;
  if (k === 'ArrowRight' || k === 'ArrowLeft') {
    const next = list[(at + (k === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
    e.preventDefault();
    focusTab(next);
  } else if (k === 'Home' || k === 'End') {
    e.preventDefault();
    focusTab(k === 'Home' ? list[0] : list[list.length - 1]);
  } else if (k === 'Enter' || k === ' ') {
    e.preventDefault();
    const t = tabs[indexOf(el.dataset.key)];
    if (t) void ose.route.navigate(t.route);
  } else if (k === 'Delete' || k === 'Backspace') {
    e.preventDefault();
    closeTab(el.dataset.key);
  }
}

/* ------------------------------------------------------------------- mount */

export function initTabs(node, panel) {
  strip = node;
  panelEl = panel || null;
  strip.className = 'tabs mono';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', 'Open pages');
  if (panelEl) panelEl.setAttribute('role', 'tabpanel');

  strip.addEventListener('click', (e) => {
    const el = e.target.closest('.tab');
    if (!el) return;
    if (e.target.closest('.tab-x')) { closeTab(el.dataset.key); return; }
    const t = tabs[indexOf(el.dataset.key)];
    if (t && t.key !== activeKey) void ose.route.navigate(t.route);
  });
  // Middle click closes, as it does in every browser and every editor.
  strip.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const el = e.target.closest('.tab');
    if (!el) return;
    e.preventDefault();
    closeTab(el.dataset.key);
  });
  strip.addEventListener('keydown', onKey);

  bus.on('route', onRoute);
  // A renamed H1 renames the tab, the same way it renames the window title (the editor
  // publishes `pageTitle` on the mount and on every keystroke in the title strip).
  store.watch('pageTitle', () => render());
  bus.on('route:title', (d) => {
    if (!d || !d.route || d.route.type !== 'own') return;
    ownTitles.set('own:' + clean(d.route.path), String(d.title || ''));
    render();
  });
  // The dot: the same two events the title bar reads, so one page is never dirty in one place
  // and clean in the other.
  bus.on('doc:dirty', (d) => {
    if (!d || !d.path) return;
    const key = 'page:' + clean(d.path);
    if (d.dirty) dirty.add(key); else dirty.delete(key);
    render();
  });
  bus.on('doc:saved', (d) => {
    if (!d || !d.path) return;
    dirty.delete('page:' + clean(d.path));
    render();
  });

  // The home tab exists before anything is opened, so the strip is never an empty bar and
  // there is always a tab for a close to fall back to.
  tabs = [{ key: keyOf(HOME), route: { ...HOME } }];
  render();

  commands.register({
    id: 'tab.close', title: 'Close tab', group: 'navigate',
    hint: 'the page or view in front', shortcut: 'Mod+W',
    when: () => !!activeKey && !isHome(activeKey),
    run: () => closeTab(activeKey),
  });
  commands.register({
    id: 'tab.next', title: 'Next tab', group: 'navigate',
    shortcut: 'Mod+Tab', when: () => tabs.length > 1,
    run: () => step(1),
  });
  commands.register({
    id: 'tab.prev', title: 'Previous tab', group: 'navigate',
    shortcut: 'Mod+Shift+Tab', when: () => tabs.length > 1,
    run: () => step(-1),
  });
  // Ctrl+Shift+T. This list's own stack first — it holds the tabs closed while another one
  // was in front, which the kernel never saw — and the kernel's `app.reopen-closed` behind it,
  // so a page closed by anything but a tab still comes back.
  commands.register({
    id: 'tab.reopen', title: 'Reopen closed tab', group: 'navigate',
    hint: 'the last tab closed', shortcut: 'Mod+Shift+T',
    run: () => {
      const r = closed.shift();
      if (r) { void ose.route.navigate(r, { force: true }); return; }
      commands.run('app.reopen-closed');
    },
  });
  commands.register({
    id: 'tab.focus', title: 'Focus tabs', group: 'navigate',
    hint: 'arrows walk the strip, Enter opens, Delete closes',
    run: () => { const on = strip && (strip.querySelector('.tab.on') || strip.querySelector('.tab')); focusTab(on); },
  });
}

/** Whether a route has a tab: for a caller that wants to know before it acts. */
export const hasTab = (r) => indexOf(keyOf(r)) >= 0;
