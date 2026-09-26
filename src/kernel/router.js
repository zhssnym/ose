// Router. Two route shapes: {type:'page', path, line?, col?, heading?, query?} and
// {type:'view', name}. `line` is a 1-based line of the file to land on (C7): a search hit, a
// task row. `col` is the 1-based column inside it (N36), `heading` a `#fragment` the router
// turns into a line before the page mounts (N3), and `query` the search text the editor opens
// find with so the hit is highlighted. None of them is part of a route's identity, so two
// routes to one page are the same page.
// Owns the teardown/mount cycle for the main column, the back/forward stack, the 'route'
// event, and the recent-files list the quick-open palette reads.
import { bus, store, status, views, commands, debounce, esc } from './registry.js';
import { bridge } from './bridge/index.js';
// The editor is a separate bundle (`ose:editor`) and the kernel never imports it: the shell
// registers whoever draws a page through `setPageHost` (./pagehost.js).
import { pageHost, headingLineIn } from './pagehost.js';
import { patchState, stateCache, flushState } from './state.js';
import { titleOf, clean, dirName, baseName } from './paths.js';
import { toast } from './dialog.js';
import { shortcutFor } from './keys.js';
import { loadingOverlay } from './loading.js';
// "Create it" is a file operation like any other (H12, M4): exclusive, any extension, never a
// markdown heading written into a `.json`. Circular with ./fileops.js, which re-points the
// history through `repoint` below; both only call each other at run time.
import { create as createFile } from './fileops.js';

const MAX_RECENT = 40;
// How many recent pages the empty surface lists (D7). Enough to find yesterday, not a dashboard.
const START_RECENT = 8;
// Scroll positions kept per route key (C16). Fifty is more than the back stack holds.
const MAX_SCROLL_MEMORY = 50;
// Routes `clearRoute` dropped, newest first, for `app.reopen-closed` (N43, Ctrl+Shift+T).
const MAX_CLOSED = 20;

let mainEl = null;
let scrollEl = null;
let current = null;
let mountedView = null;
let stack = [];
let index = -1;
let seq = 0;
const scrollMemory = new Map();
// routeKey -> {from, to}, the caret the page was left with, so back and forward put it back
// where it was rather than at the top (N44, N21). The editor is asked for it on the way out
// and handed it on the way in; it ignores what it does not understand.
const caretMemory = new Map();
let closed = [];

/*
 * The history as it was before the oldest navigation that has not been let through yet (C1).
 * `navigate`, `back`, `forward`, `clearRoute` and `reopenClosed` change the stack before the
 * page on screen has been asked whether it can be left; when it says no, `rollback` puts the
 * stack, the index and the closed list back exactly as they were. A navigation that is
 * superseded by a newer one leaves the snapshot where it is, so the newer one, if refused,
 * rolls back past both.
 */
let pending = null;

/** Take the snapshot, unless an earlier navigation still in flight already holds one. */
function begin() {
  if (!pending) pending = { stack: stack.slice(), index, closed: closed.slice() };
}

/** The page refused: the history goes back to the snapshot. */
function rollback() {
  if (!pending) return;
  ({ stack, index, closed } = pending);
  stack = stack.slice();
  closed = closed.slice();
  pending = null;
}

/** The page let go: what the stack says now is the history. */
function commit() { pending = null; }

export function currentRoute() { return current; }
export function routeKey(r) {
  if (!r) return '';
  if (r.type === 'page') return 'page:' + clean(r.path);
  if (r.type === 'own') return 'own:' + clean(r.path);
  return 'view:' + r.name;
}
export function routeLabel(r) {
  if (!r) return '';
  if (r.type === 'page') return clean(r.path);
  if (r.type === 'own') return clean(r.path);
  // The view's own title, which is what the tab and the window title say: the registered name
  // is a route key, not a word the reader knows (`Home`, not `dashboard`).
  const v = views.get(r.name);
  return 'view/' + ((v && v.title) || r.name);
}

function normalize(route) {
  if (!route || typeof route !== 'object') return null;
  if (route.type === 'page' && route.path) {
    const r = { type: 'page', path: clean(route.path) };
    // Only a real line survives: a 0, a float or a string would make the editor guess (C7).
    if (Number.isInteger(route.line) && route.line > 0) r.line = route.line;
    if (Number.isInteger(route.col) && route.col > 0) r.col = route.col;
    // A `#fragment` as the link carried it; `resolveHeading` turns it into a line, once, on
    // the way to the editor, so nothing downstream has to know what a heading is (N3, L13).
    if (typeof route.heading === 'string' && route.heading.trim()) r.heading = route.heading.trim();
    if (typeof route.query === 'string' && route.query) r.query = route.query;
    if (route.selection && Number.isInteger(route.selection.from)) r.selection = route.selection;
    return r;
  }
  if (route.type === 'view' && route.name) return { type: 'view', name: String(route.name) };
  // An owned route (docs/KERNEL.md `ose.route.own`): a path in a pattern a plugin claimed.
  // The kernel keeps no other field; whatever else the caller passed is the plugin's business
  // and is handed to `mount` unchanged.
  if (route.type === 'own' && route.path) {
    const r = { type: 'own', path: clean(route.path) };
    for (const k of Object.keys(route)) if (k !== 'type' && k !== 'path') r[k] = route[k];
    return r;
  }
  return null;
}

/* ------------------------------------------------------- routes a plugin owns (ose.route.own) */

// pattern -> { match(path), mount, owner }. A pattern is a plain glob over vault-ish paths.
// First registration wins a collision, so a plugin cannot silently steal another's pages.
const owners = [];
const indexers = [];

const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const quoteGlob = (s) => s.replace(RE_SPECIAL, '\\$&');

// The two rules, as docs/KERNEL.md states them next to `ose.route.own`:
//
// - a trailing `/*` is greedy: `nsi/*` owns everything under `nsi/`, at any depth, so
//   `nsi/chapitre-1/03-arbres` is its page. This is the normal case, not an edge: an id with a
//   slash in it (`chapitre-N/NN-slug`) is a format a plugin picks, and a pattern that says
//   `routes: ["nsi/*"]` means the section, not one level of it.
// - a `*` anywhere else is one segment: `nsi/*/notes` matches `nsi/chapitre-1/notes` and not
//   `nsi/chapitre-1/03-x/notes`.
//
// `**` is greedy wherever it stands, for the rare pattern that needs depth in the middle
// (`nsi/**/notes`). Everything else in a pattern is literal.
function toMatcher(pattern) {
  let p = String(pattern);
  let tail = '';
  // 'nsi/*' -> '^nsi/.*$'. 'nsi/**' does not end in '/*' and falls to the `**` split below.
  if (p.endsWith('/*')) { p = p.slice(0, -1); tail = '.*'; }
  const source = p.split('**')
    .map((chunk) => chunk.split('*').map(quoteGlob).join('[^/]*'))
    .join('.*') + tail;
  const re = new RegExp('^' + source + '$');
  return (path) => re.test(clean(path));
}

/** `ose.route.own(pattern, mount)`: mount(el, route) -> { title?, unmount? }. */
export function own(pattern, mount) {
  if (typeof mount !== 'function') throw new Error('route.own: mount required');
  const entry = { pattern: String(pattern), match: toMatcher(pattern), mount };
  owners.push(entry);
  return () => {
    const at = owners.indexOf(entry);
    if (at >= 0) owners.splice(at, 1);
  };
}

export function ownerFor(path) {
  return owners.find((o) => o.match(path)) || null;
}

/** `ose.route.index(pattern, fn)`: what quick open lists for an owned pattern. */
export function registerIndex(pattern, fn) {
  if (typeof fn !== 'function') throw new Error('route.index: fn required');
  const entry = { pattern: String(pattern), fn };
  indexers.push(entry);
  return () => {
    const at = indexers.indexOf(entry);
    if (at >= 0) indexers.splice(at, 1);
  };
}

/** Every owned page quick open should offer: [{ path, title, pattern }]. Never throws. */
export function ownedIndex() {
  const out = [];
  for (const { pattern, fn } of indexers) {
    let rows = [];
    try { rows = fn() || []; } catch (e) { console.error('[router] index', pattern, e); }
    for (const row of rows) {
      if (!row || !row.path) continue;
      out.push({ path: clean(row.path), title: row.title || titleOf(row.path), pattern });
    }
  }
  return out;
}

/** `ose.route.on(fn)`: after every change, with the new route (null on the start surface). */
export function onRoute(fn) { return bus.on('route', fn); }

/**
 * The 1-based file line of a route's heading, or 0 when the file has no such heading (and 0
 * when the route carries none). One read; the file is about to be read again by the editor,
 * and a heading link is rare enough that a second read is cheaper than a cache that can lie.
 */
async function resolveHeading(route) {
  if (!route || route.type !== 'page' || !route.heading || route.line) return 0;
  try {
    return headingLineIn(await bridge.readText(route.path), route.heading);
  } catch {
    return 0;
  }
}

/**
 * A line, a column or a heading says where *this* open lands; it is not a property of the
 * page. Once the route has been shown its entry forgets them, so every later back and forward
 * to that page restores the caret it was left with instead of pinning it to the heading a
 * link once jumped to (N44, QA defect 3). The entry in the history stack is this same object.
 */
function spend(route) {
  if (!route || route.type !== 'page') return;
  delete route.line;
  delete route.col;
  delete route.heading;
}

export function recentFiles() {
  const r = stateCache().recent;
  return Array.isArray(r) ? r : [];
}

function pushRecent(path) {
  const list = recentFiles().filter((p) => p !== path);
  list.unshift(path);
  patchState({ recent: list.slice(0, MAX_RECENT) });
}

/**
 * `ose.route.init(el, { start })` — the shell mounts the router into its page column, once.
 *
 * `start: false` skips the empty surface the mount otherwise draws. A shell that opens on a
 * surface of its own (the shell's home page) would otherwise show the kernel's empty
 * surface for as long as its own boot takes, and the user would watch it flash away. The
 * column is simply left blank until the shell navigates. Nothing else changes: `route.close()`
 * still draws the empty surface, which stays what it always was.
 */
export function initRouter(el, { start = true } = {}) {
  mainEl = el;

  // The app no longer opens at a route: drop any route left in .ose/state.json by an older
  // build so nothing resurrects it.
  if (stateCache().route !== undefined) patchState({ route: undefined });

  // On close the editor's own subscriber returns its final save (and may veto, batch 9); the
  // router unmounts what is on screen and then writes the state file. Returning the promise is
  // what lets the adapter await it rather than trusting a timer.
  //
  // The unmount is the third guarantee (docs/KERNEL.md): a page's `unmount` runs on a
  // navigation, on the unload of its plugin, and when the window closes or reloads — a plugin
  // that banks its clock there does not lose the visit to Ctrl+Q. The state file is flushed
  // after it, so whatever the unmount patched is in the write.
  bridge.on('window', (d) => {
    if (d && d.closing) return unmountOnUnload().then(flushState);
    return undefined;
  });

  // A reload (`ose.reload`, after the leave gate) never raises `closing`: the host navigates the web
  // view back to the app's index.html and a browser reloads the document, and both of those
  // are `pagehide` — the same event `state.js` and `kernel.js` already hang their own teardown
  // on. Nothing here can be awaited (the document is going), so the unmount's synchronous half
  // is what banks; `flushState` then writes what it patched, exactly as on the closing path.
  window.addEventListener('pagehide', () => { void unmountOnUnload().then(flushState); });

  // The editor names the open page (its H1, or the file's stem when it has none): the window
  // title follows it, on the mount and on every edit of the title strip (S13, defect 8).
  store.watch('pageTitle', () => { if (current && current.type === 'page') setWindowTitle(current); });

  const refresh = debounce(() => {
    if (mountedView && typeof mountedView.refresh === 'function') {
      try { mountedView.refresh(); } catch (e) { console.error('[shell] view refresh', e); }
    }
  }, 300);
  bus.on('fs', refresh);

  // Mouse buttons 4 and 5 are back and forward everywhere else on Windows, and the webview
  // would otherwise navigate its own history with them, which in a single-page app means
  // nothing at all (N45). `auxclick` and `mousedown` are cancelled so neither happens twice.
  const swallow = (e) => { if (e.button === 3 || e.button === 4) { e.preventDefault(); e.stopPropagation(); } };
  window.addEventListener('mousedown', swallow, true);
  window.addEventListener('auxclick', swallow, true);
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 3) back(); else forward();
  }, true);

  commands.register({
    id: 'app.reopen-closed', title: 'Reopen closed page', group: 'navigate',
    hint: 'the last page closed with Ctrl+W',
    when: canReopenClosed,
    run: () => void reopenClosed(),
  });

  // No startup route (docs/SHELL.md), but not a bare rectangle either: the empty
  // surface is drawn now, without taking focus from the sidebar the user is about to use.
  // A shell with a home of its own asks for `start: false` and draws that instead.
  if (start) void show(null, { focus: false });
}

/* ----------------------------------------------------------- focus and scroll */

/**
 * Where typing should go once something is on the page column: the editor body, else the
 * title, else a view's root, else the first recent row of the empty surface. Every open path
 * (sidebar Enter, Ctrl+P, Alt+Left, a search hit, a followed link) ends here, so the user is
 * never left having to click before typing (B3). `preventScroll` because C16 has just put the
 * scroll position back and a focus jump would undo it.
 */
export function focusMain() {
  if (!mainEl) return false;
  // `.page-title` is a focus target only when it is the editor's title strip, which is
  // editable. A view's own H1 wears the same class and there is nothing to type into it, so
  // focusing it did nothing but draw a ring round the heading — the first thing anyone saw,
  // because the app opens on a view.
  const title = mainEl.querySelector('.page-title');
  const pick = mainEl.querySelector('.ProseMirror')
    // A code page is an editor too: without this the caret landed on the body after every
    // open of a .py, .json or .jsonl file and typing went nowhere.
    || mainEl.querySelector('.cm-content')
    || (title && title.isContentEditable ? title : null)
    || mainEl.querySelector('.view-root')
    || mainEl.querySelector('.start-row')
    || mainEl.querySelector('.miss .btn');   // "create it" / "retry": Enter should reach it
  if (!pick) return false;
  // Views set tabindex=-1 on their root; a page title without an H1 is a plain div. Neither
  // is our DOM, so only the one attribute that makes `focus()` work is touched.
  if (!pick.isContentEditable && !pick.hasAttribute('tabindex') && pick.tagName !== 'BUTTON') pick.tabIndex = -1;
  pick.focus({ preventScroll: true });
  return document.activeElement === pick;
}

/** After a mount: focus the page unless something in it (the editor's new-page title) already has it. */
function settleFocus(scroll) {
  if (document.activeElement && scroll.contains(document.activeElement)) return;
  focusMain();
}

function rememberScroll() {
  if (!current || !scrollEl) return;
  const key = routeKey(current);
  scrollMemory.delete(key);
  scrollMemory.set(key, scrollEl.scrollTop);
  while (scrollMemory.size > MAX_SCROLL_MEMORY) scrollMemory.delete(scrollMemory.keys().next().value);
  // The caret too (N44). `currentSelection` is the editor's (P5); until it exists the page
  // simply comes back scrolled, which is what it did before.
  const host = pageHost();
  if (current.type !== 'page' || !host || typeof host.selection !== 'function') return;
  let sel = null;
  try { sel = host.selection(); } catch (e) { console.warn('[router] selection', e); }
  caretMemory.delete(key);
  if (sel && Number.isInteger(sel.from)) caretMemory.set(key, sel);
  while (caretMemory.size > MAX_SCROLL_MEMORY) caretMemory.delete(caretMemory.keys().next().value);
}

/**
 * Put the scroll back after the editor or the view has mounted. One frame later, because a
 * view lays itself out on mount and the editor's node views settle after openPage resolves;
 * the height has to exist before scrollTop can take it (C16).
 */
function restoreScroll(scroll, key) {
  const top = scrollMemory.get(key);
  if (!top) return;
  requestAnimationFrame(() => { if (scroll.isConnected) scroll.scrollTop = top; });
}

/**
 * The page on screen goes away: the editor is closed, or a view's / an owned route's `unmount`
 * is called — and **awaited**, the way `host.close()` above it always was (docs/KERNEL.md, the
 * three guarantees). A page that banks a clock, saves a buffer or kills a child on the way out
 * needs its last write to finish before the next page mounts, and until this was fixed the
 * router started that work and walked off. A throw is caught and logged rather than left to
 * reject, so the next mount always proceeds. A sync `unmount` still works: `await` on a
 * non-promise is one microtask.
 */
/** How long the router waits for an `unmount` before it draws the next page anyway. */
const UNMOUNT_MS = 5000;

/**
 * The awaited `unmount`, with a bound on the wait. An `unmount` that never settles used to stop
 * every later navigation, Ctrl+W, plugin unload and home for the session, with nothing on screen
 * saying why, and on the host's close path it held the window open for ever. The wait is bounded
 * and the page that would not close is named in a toast: a plugin that hangs is broken, and the
 * owner is told rather than left with a column that no longer moves. A page that counts time
 * banks on a timer as well (docs/PLUGINS.md rule 5), so nothing the contract promised is lost.
 */
async function callUnmount(view, where) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      const what = (current && routeLabel(current)) || 'a page';
      console.error(`[router] ${where}: unmount of ${what} did not finish in ${UNMOUNT_MS / 1000} s`);
      try { toast(`${what} did not finish closing; going on without it`, 'err', 6000); } catch { /* no DOM */ }
      resolve();
    }, UNMOUNT_MS);
  });
  try {
    await Promise.race([Promise.resolve(view.unmount()), late]);
  } catch (e) {
    console.error(`[shell] ${where}`, e);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The page on screen goes. Answers false when the page host's `close()` answered false: the
 * page is still mounted and nothing was torn down, so the column must not be cleared (C1). A
 * `close()` that throws has already been let go by `canLeave` and is logged, not obeyed.
 */
async function teardown() {
  if (!current) return true;
  rememberScroll();
  if (current.type === 'page') {
    const host = pageHost();
    if (host) {
      try {
        if ((await host.close()) === false) return false;
      } catch (e) { console.warn('[router] close page:', e.message || e); }
    }
  } else if (mountedView && typeof mountedView.unmount === 'function') {
    await callUnmount(mountedView, 'view unmount');
  }
  mountedView = null;
  return true;
}

/**
 * The window is going away (a close request, a reload, a change of vault): the view or owned
 * route on screen is unmounted, so its clock is banked and its children are stopped exactly as
 * they would be on a navigation. The editor is left alone — it answers the leave gate
 * (`ose.window.onLeave`, ./leave.js), saving and possibly vetoing, and running its close twice
 * would ask the changed-on-disk question against its own write. The gate awaits this for a
 * reload and a vault change; the `closing` handler above runs it for a close. Everything is best effort: on `pagehide` only
 * the synchronous half of an `unmount` can still run, which is why a plugin banks on a timer as
 * well (docs/PLUGINS.md).
 */
export async function unmountOnUnload() {
  if (!current || current.type === 'page') return;
  if (mountedView && typeof mountedView.unmount === 'function') {
    await callUnmount(mountedView, 'unload unmount');
  }
  mountedView = null;
}

/**
 * `ose.plugins.unload(id)` asks for this when the plugin it is taking apart owns what is on
 * screen: the page is unmounted through the router's own teardown — its clock banked, its
 * editor closed, its processes stopped — before `deactivate` pulls the facade out from under
 * it, and the column is left on nothing. The shell decides what nothing means (its tab strip
 * puts the home page there); the kernel knows no view by name.
 */
export async function dropCurrent() {
  if (!current) return;
  // `show(null)` is the ordinary teardown-and-draw-nothing path, so the unmount is the same one
  // a navigation runs and is awaited with it. Not `clearRoute`: what a plugin is taking with it
  // is not something Ctrl+Shift+T should offer to reopen.
  await show(null, { focus: false });
}

function emptyState(html) {
  const box = document.createElement('div');
  box.className = 'page-col';
  box.innerHTML = html;
  return box;
}

/**
 * Mount a page into the column. The stat, the read and Crepe's boot together take longer than
 * a blink on a cold start, and until now the column was blank for all of it (D9): one
 * "loading…" line goes up if the mount outlasts the shared delay and comes down when it
 * resolves or fails, whichever way it ends, so the column never says loading over a page.
 */
async function renderPage(scroll, route) {
  const stop = loadingOverlay(scroll);
  try {
    await mountPage(scroll, route);
  } finally {
    stop();
  }
}

async function mountPage(scroll, route) {
  const { path, col, query } = route;
  // A heading becomes a line here, once, so the editor is only ever told about lines (N3).
  const line = route.line || (await resolveHeading(route)) || 0;
  if (route.heading && !line) toast(`no heading “${route.heading}” in ${path}`, 'info', 2600);
  // The caret the page was left with, when the caller has not asked for a line instead (N44).
  const selection = route.selection || (line ? null : caretMemory.get(routeKey(route)) || null);
  let st = null;
  // A stat that throws is not the same thing as a file that is not there: the first is a
  // locked file or a bridge fault and must never be offered "Create it", because that button
  // writes a stub over the path.
  try { st = await bridge.stat(path); } catch (e) {
    console.error('[shell] stat', path, e);
    const box = emptyState(`
      <div class="miss">
        <div class="miss-title">could not read that page</div>
        <div class="miss-path mono">${esc(path)}</div>
        <div class="miss-why">${esc(e.message || String(e))}</div>
        <button class="btn" data-act="retry">retry</button>
      </div>`);
    box.querySelector('[data-act="retry"]').addEventListener('click', () => {
      navigate({ type: 'page', path }, { replace: true, force: true });
    });
    scroll.appendChild(box);
    return;
  }
  // A path the page host draws itself when it is missing (a media file, whose own miss says
  // more than "page not found") goes straight to it (M4).
  const pages = pageHost();
  let claimed = false;
  try { claimed = !!(pages && typeof pages.claims === 'function' && pages.claims(path)); } catch { claimed = false; }
  if (!st.exists && !claimed) {
    const box = emptyState(`
      <div class="miss">
        <div class="miss-title">page not found</div>
        <div class="miss-path mono">${esc(path)}</div>
        <button class="btn primary" data-act="create">create it</button>
      </div>`);
    box.querySelector('[data-act="create"]').addEventListener('click', async () => {
      // Exclusive: a file that arrived since the stat is opened, never written over. A `.md`
      // gets its H1 and anything else starts empty (ose.fileops.create).
      try {
        await createFile(dirName(path), baseName(path), {});
      } catch (e) {
        if (!e || e.code !== 'exists') {
          toast(`could not create ${path}: ${(e && e.message) || e}`, 'err', 0);
          return;
        }
      }
      navigate({ type: 'page', path }, { replace: true, force: true });
    });
    scroll.appendChild(box);
    return;
  }

  const host = document.createElement('div');
  host.className = 'page-host';
  scroll.appendChild(host);

  let mounted = false;
  try {
    // The third argument is the route's line (C7). The editor is free to ignore it, and does
    // until it learns to scroll to a line; passing it now is what lets that land editor-side.
    if (pages) await pages.open(host, path, { line, col, query, selection });
    mounted = host.childElementCount > 0;
  } catch (e) {
    console.error('[router] open page', e);
    toast('could not open ' + path + ': ' + (e.message || e), 'err', 0);
  }

  // No page host, or one that drew nothing: show the file as text so navigation is visibly
  // working. Removed automatically as soon as a host renders something.
  if (!mounted) {
    let text = '';
    try { text = await bridge.readText(path); } catch (e) { text = String(e.message || e); }
    host.innerHTML = `
      <div class="page-col fallback">
        <h1 class="page-title">${esc(titleOf(path))}</h1>
        <div class="page-meta"><span>${esc(path)}</span><span>raw · no page editor</span></div>
        <pre class="fallback-md text-select">${esc(text)}</pre>
      </div>`;
  }
}

async function renderOwned(scroll, route, my) {
  const o = ownerFor(route.path);
  if (!o) {
    scroll.appendChild(emptyState(`
      <div class="miss">
        <div class="miss-title">nothing owns that route</div>
        <div class="miss-path mono">${esc(route.path)}</div>
      </div>`));
    return;
  }
  const el = document.createElement('div');
  el.className = 'page-host owned';
  scroll.appendChild(el);
  try {
    // The return value is the plugin's handle: `title` names the window, `unmount` is called
    // on the way out exactly like a view's. A plugin that returns nothing is fine.
    //
    // An `async mount` answers a promise, and the handle is inside it: awaited, so an owned
    // route written the way the PLUGINS.md example writes a view keeps its `unmount` and its
    // title instead of losing both silently.
    const handle = (await Promise.resolve(o.mount(el, route))) || {};
    if (my !== seq) return;
    mountedView = handle;
    if (handle.title) { ownTitles.set(routeKey(route), String(handle.title)); setWindowTitle(route); bus.emit('route:title', { route, title: String(handle.title) }); }
  } catch (e) {
    console.error('[router] own mount', route.path, e);
    if (my !== seq) return;
    scroll.appendChild(emptyState(`<div class="miss"><div class="miss-title">that page failed</div><div class="miss-path mono">${esc(e.message || e)}</div></div>`));
  }
}

const ownTitles = new Map();

async function renderView(scroll, name, my) {
  const v = views.get(name);
  if (!v) {
    scroll.appendChild(emptyState(`
      <div class="miss">
        <div class="miss-title">view not registered</div>
        <div class="miss-path mono">${esc(name)}</div>
      </div>`));
    return;
  }
  mountedView = v;
  try {
    // Awaited, so a view with an `async mount` has drawn before the focus is settled and a
    // rejection lands in the box below rather than as an uncaught error over a blank column.
    // What `mount` answers counts too: a view that returns `{ unmount, refresh }` is the way
    // half the stock views are written, and the router used to throw that object away, so the
    // Maths index left one live copy of itself behind on every visit. What the handle carries
    // wins over the registration; what it leaves out the registration still answers.
    const handle = await v.mount(scroll);
    if (my !== seq) return;
    if (handle && typeof handle === 'object') mountedView = { ...v, ...handle };
  } catch (e) {
    console.error('[shell] view mount', e);
    if (my !== seq) return;
    scroll.appendChild(emptyState(`<div class="miss"><div class="miss-title">view failed</div><div class="miss-path mono">${esc(e.message || e)}</div></div>`));
  }
}

/**
 * The empty surface (D7): what the app boots into and where trashing the open page lands.
 * A `recent` label with the last pages opened, and one quiet line of the three chords that
 * get anywhere from here. Not a dashboard: no counts, no calendar, nothing that competes
 * with the sidebar. Recents that no longer exist are dropped from the list, not from state;
 * the check is one stat per row and runs after the surface is up so nothing waits on it.
 */
async function renderStart(scroll, my, opts) {
  const box = document.createElement('div');
  box.className = 'page-col start';
  const keys = [
    [shortcutFor('app.quickopen'), 'open'],
    [shortcutFor('app.palette'), 'commands'],
    [shortcutFor('page.new'), 'new'],
  ].filter(([k]) => k).map(([k, what]) => `<span><span class="kbd">${esc(k)}</span> ${what}</span>`).join('<span class="start-dot">·</span>');
  box.innerHTML = `<div class="start-recent"></div><div class="start-keys mono-sm">${keys}</div>`;
  scroll.appendChild(box);

  const candidates = recentFiles().slice(0, START_RECENT * 2);
  const alive = await Promise.all(candidates.map((p) => bridge.exists(p).catch(() => false)));
  if (my !== seq) return;
  const list = candidates.filter((_, i) => alive[i]).slice(0, START_RECENT);
  if (!list.length) return;

  const host = box.querySelector('.start-recent');
  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = 'recent';
  host.appendChild(label);
  for (const p of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row start-row';
    row.dataset.path = p;
    row.innerHTML = `<span class="grow">${esc(titleOf(p))}</span>` + (dirName(p) ? `<span class="hint">${esc(dirName(p))}</span>` : '');
    row.addEventListener('click', () => navigate({ type: 'page', path: p }));
    host.appendChild(row);
  }
  // Up/Down walk the list so Enter opens without a Tab per row.
  host.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...host.querySelectorAll('.start-row')];
    const at = rows.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
  });
  if (opts.focus !== false) settleFocus(scroll);
}

/**
 * The window title (S13): `<Note> · <vault>`, `<View> · <vault>`, or the vault's name alone on
 * the start surface. `bridge.setTitle` is P8's; until it lands this is a no-op and the title
 * bar the app draws itself is unchanged either way.
 */
/**
 * `ose.route.title(text)`: the window title of the **owned** route on screen, set after the
 * mount (a plugin that fetches its detail knows the real title a beat later). The router adds
 * ` · <vault>` the way it does for a page, which is what a plugin calling `ose.window.title`
 * itself could not do (QA-K defect 8).
 */
export function setOwnTitle(text) {
  if (!current || current.type !== 'own') return;
  ownTitles.set(routeKey(current), String(text ?? ''));
  setWindowTitle(current);
  // The shell may draw the title elsewhere (a tab strip): one event, no new hose.
  bus.emit('route:title', { route: current, title: String(text ?? '') });
}

function setWindowTitle(route) {
  if (typeof bridge.setTitle !== 'function') return;
  const vault = (store.get('root') && store.get('root').name) || 'os';
  let text = vault;
  if (route && route.type === 'page') {
    // The note's own name, the way quick open, the sidebar and the palette all say it. The
    // editor publishes it on `pageTitle` as soon as it has parsed the file and again on every
    // keystroke in the title strip; until then — the mount is still running — the file's stem
    // stands in, which is what the title bar used to show for ever (QA defect 8).
    const known = store.get('pageTitle');
    const h1 = known && known.path === route.path ? String(known.title || '').trim() : '';
    text = `${h1 || titleOf(route.path)} · ${vault}`;
  } else if (route && route.type === 'own') {
    text = `${ownTitles.get(routeKey(route)) || titleOf(route.path)} · ${vault}`;
  } else if (route && route.type === 'view') {
    const v = views.get(route.name);
    text = `${(v && v.title) || route.name} · ${vault}`;
  }
  try { void bridge.setTitle(text); } catch (e) { console.warn('[shell] setTitle', e); }
}

/**
 * Ask the page on screen whether it can be left (C1). Answers true when there is no page, no
 * page host or no `canLeave`; a `canLeave` that throws is a no, because the one thing that must
 * never happen is a buffer thrown away because its save threw.
 */
async function pageLets() {
  if (!current || current.type !== 'page') return true;
  const host = pageHost();
  if (!host || typeof host.canLeave !== 'function') return true;
  try {
    return (await host.canLeave('navigate')) !== false;
  } catch (e) {
    console.error('[router] canLeave', e);
    return false;
  }
}

/**
 * Put `route` on the column. Answers false, and changes nothing that anybody can see, when the
 * page on screen refuses to be left or a newer `show` took over; true once the new route is up.
 *
 * Nothing happens before the veto: no `route` event, no store change, no DOM change. A refused
 * navigation leaves the column, the tab strip and the title bar exactly as they were, and the
 * history goes back to the snapshot the navigation took (`rollback`).
 */
async function show(route, opts = {}) {
  begin();
  const my = ++seq;
  const ok = await pageLets();
  // Superseded: the newer show decides, and holds the snapshot if it must roll back.
  if (my !== seq) return false;
  if (!ok) {
    rollback();
    bus.emit('route:refused', { from: current, to: route });
    return false;
  }
  const left = await teardown();
  if (!left) {
    // `close()` said no after `canLeave` said yes: undo the freeze, keep everything.
    try { pageHost()?.stay?.(); } catch (e) { console.error('[router] stay', e); }
    if (my === seq) {
      rollback();
      bus.emit('route:refused', { from: current, to: route });
    }
    return false;
  }
  if (my !== seq) return false;
  commit();

  mainEl.textContent = '';
  const scroll = document.createElement('div');
  scroll.className = 'main-scroll';
  mainEl.appendChild(scroll);
  scrollEl = scroll;

  if (!route) {
    current = null;
    store.set('route', null);
    status.set('path', null);
    setWindowTitle(null);
    bus.emit('route', null);
    await renderStart(scroll, my, opts);
    return true;
  }

  current = route;
  store.set('route', route);
  status.set('path', routeLabel(route));
  setWindowTitle(route);
  bus.emit('route', route);

  if (route.type === 'page') {
    pushRecent(route.path);
    await renderPage(scroll, route);
    spend(route);
  } else if (route.type === 'own') {
    await renderOwned(scroll, route, my);
  } else {
    await renderView(scroll, route.name, my);
  }
  if (my !== seq) return true;
  restoreScroll(scroll, routeKey(route));
  // `focus: false` is for callers that navigate while the user is somewhere else on purpose
  // (a tree previewing on arrow keys would be one); every ordinary open lands the caret.
  if (opts.focus !== false) settleFocus(scroll);
  return true;
}

/**
 * navigate(route, { replace, force, focus }) -> Promise<boolean>. `focus: false` leaves focus
 * where it is. False when the page on screen refused to be left (its banner says why); the
 * history is then exactly what it was.
 */
export function navigate(route, opts = {}) {
  const r = normalize(route);
  if (!r) return Promise.resolve(false);

  const same = !!current && routeKey(current) === routeKey(r);
  // The open page asked for again with a line or a heading (a second search hit in the same
  // file, an anchor into it): the request must still reach the editor, so it is shown as if
  // forced, but it is the same page and gets no second history entry; the current entry just
  // learns where to land (C7, N3). The page is not left, so it is not asked.
  if (same && !opts.force && (r.line || r.heading)) {
    // Only a snapshot this jump took is this jump's to settle: one that an earlier navigation
    // still in flight holds stays with it.
    const took = !pending;
    begin();
    if (index >= 0) stack[index] = r;
    // The editor scrolls its mounted page in place; a remount would lose the caret and the
    // undo history for a jump within the same file.
    return (async () => {
      const line = r.line || (await resolveHeading(r));
      let shown = true;
      if (!line) {
        if (r.heading) toast(`no heading “${r.heading}” on this page`, 'info', 2600);
        if (took) commit();
      } else if (pageHost() && typeof pageHost().scrollToLine === 'function' && pageHost().scrollToLine(line, r.col)) {
        if (took) commit();
      } else {
        // The page could not jump in place, so it is remounted, and that does leave it.
        shown = await show({ ...r, line }, opts);
      }
      // Landed or not, the jump is spent: the entry is the page, nothing more (defect 3).
      spend(r);
      return shown;
    })();
  }
  if (same && !opts.force) return Promise.resolve(true);

  begin();
  if (opts.replace && index >= 0) stack[index] = r;
  else { stack = stack.slice(0, index + 1); stack.push(r); index = stack.length - 1; }
  if (stack.length > 100) { stack = stack.slice(-100); index = stack.length - 1; }

  return show(r, opts);
}

/** Back one entry. False when there is none or the page refused to be left. */
export function back() {
  if (index <= 0) return Promise.resolve(false);
  begin();
  index -= 1;
  return show(stack[index]);
}

/** Forward one entry. False when there is none or the page refused to be left. */
export function forward() {
  if (index < 0 || index >= stack.length - 1) return Promise.resolve(false);
  begin();
  index += 1;
  return show(stack[index]);
}

export function canBack() { return index > 0; }
export function canForward() { return index >= 0 && index < stack.length - 1; }

/**
 * Back to the empty surface: nothing drawn in the main column, no route. This is the state
 * the app boots into, and where trashing the open page lands when there is nothing to show
 * in its place. -> Promise<boolean>, false when the page refused to be closed.
 */
export function clearRoute(opts = {}) {
  begin();
  // What was closed can be reopened (N43): the route goes on a small stack that Ctrl+Shift+T
  // pops. Only a real route, and never the same one twice in a row.
  if (current && (!closed.length || routeKey(closed[0]) !== routeKey(current))) {
    closed.unshift(current);
    closed = closed.slice(0, MAX_CLOSED);
  }
  stack = stack.slice(0, index + 1);
  return show(null, opts);
}

/** `app.reopen-closed` (Ctrl+Shift+T): the last route Ctrl+W dropped, back where it was. */
export function reopenClosed() {
  if (!closed.length) { toast('nothing to reopen', 'info', 2000); return Promise.resolve(false); }
  begin();
  const r = closed.shift();
  return navigate(r, { force: true });
}

export function canReopenClosed() { return closed.length > 0; }

/**
 * The route on screen, mounted again. Used by `ose.paths` once a path a view was missing has
 * been chosen, and by a media page that follows its file. It is the ordinary teardown-and-draw
 * path, so the page is asked and the unmount is awaited exactly as a navigation awaits it; the
 * promise is answered so a caller can wait for the new mount.
 */
export function reopenCurrent() {
  return current ? show(current) : Promise.resolve(true);
}

/* ------------------------------------------------------------------- re-pointing (C6) */

/** `path` mapped through `moves`, or null when none of them covers it. */
function mapPath(path, moves) {
  const p = clean(path);
  for (const { from, to } of moves) {
    if (p === from) return to;
    if (p.startsWith(from + '/')) return to + p.slice(from.length);
  }
  return null;
}

/** A Map keyed by route key, with every key under a move renamed; the order is kept. */
function rekey(map, moves) {
  const entries = [...map.entries()];
  map.clear();
  for (const [key, value] of entries) {
    const next = key.startsWith('page:') ? mapPath(key.slice(5), moves) : null;
    map.set(next === null ? key : 'page:' + next, value);
  }
}

/**
 * A file or a folder moved on disk and the page that shows it followed it (C6): every page
 * route at `from`, or under `from/`, now says `to`. Nothing is unmounted and nothing is
 * mounted, so the editor keeps its buffer and its undo history, and no `route` event goes out;
 * `route:repointed` `{ moves, current }` does, for the tab strip and whoever else keeps paths.
 *
 * Updates the current route, every history entry, the closed stack, the recent list, the
 * scroll and caret memories, the store's `route`, the status bar's path and the window title.
 * @param {Array<{from: string, to: string}>} moves
 */
export function repoint(moves) {
  const list = (moves || [])
    .map((m) => ({ from: clean(m && m.from), to: clean(m && m.to) }))
    .filter((m) => m.from && m.to && m.from !== m.to);
  if (!list.length) return;

  // One new object per old one, so an entry that is the same object as `current` (the history
  // holds the routes it shows) stays the same object after.
  const seen = new Map();
  const remap = (r) => {
    if (!r || r.type !== 'page') return r;
    if (seen.has(r)) return seen.get(r);
    const to = mapPath(r.path, list);
    const next = to === null ? r : { ...r, path: to };
    seen.set(r, next);
    return next;
  };

  const before = current;
  current = remap(current);
  stack = stack.map(remap);
  closed = closed.map(remap);
  if (pending) {
    pending.stack = pending.stack.map(remap);
    pending.closed = pending.closed.map(remap);
  }
  rekey(scrollMemory, list);
  rekey(caretMemory, list);

  const recent = recentFiles();
  const nextRecent = [];
  for (const p of recent) {
    const q = mapPath(p, list) ?? p;
    if (!nextRecent.includes(q)) nextRecent.push(q);
  }
  if (nextRecent.length !== recent.length || nextRecent.some((p, i) => p !== recent[i])) patchState({ recent: nextRecent });

  if (current !== before) {
    store.set('route', current);
    status.set('path', routeLabel(current));
    setWindowTitle(current);
  }
  bus.emit('route:repointed', { moves: list, current });
}
