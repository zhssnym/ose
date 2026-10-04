// Router. Two route shapes:
//
//   { type: 'page',   path, line?, col?, heading?, query?, selection? }
//   { type: 'view',   name, arg? }
//
// A folder is not a place of its own: `{ type: 'folder', path }` handed to navigate or
// tabs.open is a request to show that folder in the sidebar, and it never enters a history.
//
// `line` is a 1-based line of the file to land on (C7): a search hit, a task row. `col` is the
// 1-based column inside it (N36), `heading` a `#fragment` the router turns into a line before
// the page mounts (N3), and `query` the search text the editor opens find with, and `arg` what
// a view is asked to show
// (a settings section). None of them is part of a route's identity, and all of them are spent
// once the route has been shown, so two routes to one page are the same page.
//
// The router owns the mount cycle of the page column and every change of what is on it: the
// tabs and their histories (the model is ./tabs.ts), navigate, back and forward, opening,
// activating and closing a tab, the 'route' and 'tabs' events, the window title and the recent
// files. The page on screen is asked before it is left (C1); a page left because another tab
// comes forward is parked instead, buffer and undo kept (M12, M24).
import { bus, store, views, commands, debounce, esc } from './registry.ts';
import { bridge } from './bridge/index.ts';
// The editor (src/editor) is loaded on its own; the core does not import it. The shell
// registers it through ./pagehost.ts.
import { pageHost, headingLineIn } from './pagehost.ts';
import { flushState } from './state.ts';
import { local } from './local.ts';
import { clean, dirName, baseName, isOutside, outsideLabel } from './paths.ts';
import { display } from './names.ts';
import { toast } from '../ui/toast.ts';
import { loadingOverlay } from '../ui/loading.ts';
import * as T from './tabs.ts';
// "Create it" is a file operation like any other (H12, M4): exclusive, any extension, never a
// markdown heading written into a `.json`. Circular with ./fileops.ts, which re-points the
// history through `repoint` below; both only call each other at run time.
import { create as createFile } from './fileops.ts';

const MAX_RECENT = 40;
// Caret positions kept per route key (N44). The caret belongs to the file, not to a tab.
const MAX_CARET_MEMORY = 50;

export type Route = import('./types.ts').Route;
export type TabRecord = import('./types.ts').TabRecord;
export type ShowOpts = { focus?: boolean, park?: boolean, reason?: string };

let mainEl: HTMLElement | null = null;
let scrollEl: HTMLElement | null = null;
let current: any = null;       // the route on screen: the same object as its tab's entry
let mountedTab: any = null;    // the record that route belongs to
let mountedView: any = null;   // a view's merged handle
let seq = 0;
// The edit the show in flight made to its own tab (a navigate's new entry, a back or forward's
// move), so a newer show that overtakes it can take it back: `{ my, rec, before, after, route }`.
let claim: { my: number; rec: TabRecord; before: { stack: Route[]; index: number; }; after: { stack: Route[]; index: number; }; route: Route | null; } | null = null;
// The leave phase (ask, then tear down) of the newest show, while it runs. A newer show waits
// for it before it asks or tears down itself, so a yes the older one got can be undone (`stay`)
// on the page that gave it, not on a page already parked.
let leaving: Promise<void> | null = null;
// routeKey -> {from, to}, the caret the page was left with, so back and forward put it back
// where it was rather than at the top (N44, N21). The editor is asked for it on the way out
// and handed it on the way in; it ignores what it does not understand.
const caretMemory = new Map();

export function currentRoute() { return current; }

/** 'page:<path>' | 'view:<name>'. */
export function routeKey(r) {
  if (!r) return '';
  if (r.type === 'page') return 'page:' + clean(r.path);
  return 'view:' + r.name;
}

/** What a toast calls a route: the path, or the view's title. */
export function routeLabel(r) {
  if (!r) return '';
  if (r.type === 'page') return isOutside(r.path) ? outsideLabel(r.path) : clean(r.path);
  const v = views.get(r.name);
  return (v && v.title) || r.name;
}

/**
 * A route in its one shape, or null when it is not one.
 * @param route  reason: anything a caller hands over, checked field by field below
 */
export function normalize(route: any): Route | null {
  if (!route || typeof route !== 'object') return null;
  if (route.type === 'page' && route.path) {
    const r: import('./types.ts').PageRoute = { type: 'page', path: clean(route.path) };
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
  if (route.type === 'folder' && typeof route.path === 'string') {
    const r: import('./types.ts').FolderRoute = { type: 'folder', path: clean(route.path) };
    return r;
  }
  if (route.type === 'view' && route.name) {
    const r: import('./types.ts').ViewRoute = { type: 'view', name: String(route.name) };
    if (typeof route.arg === 'string' && route.arg) r.arg = route.arg;
    return r;
  }
  return null;
}

/** True when a route carries something that says where *this* show lands. */
const carriesSpent = (r) => !!r && (
  (r.type === 'page' && !!(r.line || r.heading))
  || (r.type === 'view' && !!r.arg));

/**
 * A line, a column, a heading, a selection or an argument says where *this* show lands; it is
 * not a property of the route. Once the route has been shown its entry forgets them, so every
 * later back and forward to it restores the caret it was left with instead of pinning it to
 * the heading a link once jumped to (N44). The entry in the history is this same object.
 */
function spend(route) {
  if (!route) return;
  if (route.type === 'page') { delete route.line; delete route.col; delete route.heading; }
  else if (route.type === 'view') delete route.arg;
}

/** `ose.route.on(fn)`: after every change of the route on screen (null on an empty column). */
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

/* --------------------------------------------------------------------------- recent files */

const recentStore = () => local('recent');

/** The pages opened on this machine in this vault, newest first (per machine since W5). */
export function recentFiles() {
  const r = recentStore().get();
  return Array.isArray(r) ? r : [];
}

function pushRecent(path) {
  const list = recentFiles().filter((p) => p !== path);
  list.unshift(path);
  recentStore().set(list.slice(0, MAX_RECENT));
}

/* ----------------------------------------------------------------------------- mounting */

/**
 * `ose.route.init(el)` — the shell mounts the router into its page column, once. Nothing is
 * shown: the column is blank until the shell navigates (Home).
 */
export function initRouter(el) {
  mainEl = el;

  // On close the editor's own subscriber returns its final save (and may veto); the router
  // unmounts the view on screen and then writes the state file. Returning the
  // promise is what lets the adapter await it rather than trusting a timer.
  bridge.on('window', (d) => {
    if (d && d.closing) return unmountOnUnload().then(flushState);
    return undefined;
  });

  // A reload (`ose.reload`, after the leave gate) never raises `closing`: it is `pagehide`,
  // where nothing can be awaited, so the unmount's synchronous half is what banks.
  window.addEventListener('pagehide', () => { void unmountOnUnload().then(flushState); });

  // A view re-reads what it shows after the watcher says something changed.
  const refresh = debounce(() => {
    if (mountedView && typeof mountedView.refresh === 'function') {
      try { mountedView.refresh(); } catch (e) { console.error('[router] refresh', e); }
    }
  }, 300);
  bus.on('fs', refresh);
  bus.on('settings', () => {
    if (current) setWindowTitle(current);
  });

  // A trashed file or folder: every tab showing it, or something under it, goes Home.
  bus.on('paths:trashed', (d) => { void followTrash(d && Array.isArray(d.paths) ? d.paths : []); });

  // Mouse buttons 4 and 5 are back and forward everywhere else on Windows, and the webview
  // would otherwise navigate its own history with them, which in a single-page app means
  // nothing at all (N45). `auxclick` and `mousedown` are cancelled so neither happens twice.
  // They act on the active tab's own history (M23).
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
    id: 'app.reopen-closed', title: 'Reopen closed tab', group: 'navigate',
    hint: 'with its whole history',
    when: canReopenClosed,
    run: () => void reopenClosedTab(),
  });
}

/* ----------------------------------------------------------- focus and scroll */

/**
 * Where the keyboard goes once something is on the page column: for a page, its scroller (a
 * page is read until one clicks into the text; a new page's title already has the focus),
 * else a view's root. Every open path ends here, so the keyboard is never left on <body> (B3).
 * `preventScroll` because the scroll position has just been put back and a focus jump would
 * undo it.
 */
export function focusMain() {
  if (!mainEl) return false;
  const title = mainEl.querySelector('.page-title');
  const found = mainEl.querySelector('.ProseMirror')
    // A code page is an editor too: without this the caret landed on the body after every
    // open of a .py, .json or .jsonl file and typing went nowhere.
    || mainEl.querySelector('.cm-content')
    || (title instanceof HTMLElement && title.isContentEditable ? title : null)
    || mainEl.querySelector('.view-root')
    || mainEl.querySelector('.miss .btn');   // "Create it" / "Retry": Enter should reach it
  if (!(found instanceof HTMLElement)) return false;
  // A page opens to be read, not written: writing is something one goes into on purpose, with
  // a click in the text. So an editor's body is not focused; its scroller is, which keeps the
  // keyboard on the page (arrows and Page Down scroll it) without a caret in the first line.
  const body = found.matches('.ProseMirror, .cm-content');
  const pick = body ? ((found.closest('.main-scroll') as HTMLElement | null) || mainEl) : found;
  // Views set tabindex=-1 on their root; a page title without an H1 is a plain div. Neither
  // is our DOM, so only the one attribute that makes `focus()` work is touched.
  if (!pick.isContentEditable && !pick.hasAttribute('tabindex') && pick.tagName !== 'BUTTON') pick.tabIndex = -1;
  pick.focus({ preventScroll: true });
  return document.activeElement === pick;
}

/** After a mount: focus the page unless something in it (a new page's title) already has it. */
function settleFocus(scroll) {
  if (document.activeElement && scroll.contains(document.activeElement)) return;
  focusMain();
}

/**
 * The route on screen is about to go: its scroll offset goes into its tab's memory, and a
 * page's caret into the caret memory.
 */
function rememberScroll() {
  if (!current || !mountedTab) return;
  const key = routeKey(current);
  if (scrollEl) T.remember(mountedTab.scroll, key, scrollEl.scrollTop);
  const host = pageHost();
  if (current.type !== 'page' || !host || typeof host.selection !== 'function') return;
  let sel: any = null;
  try { sel = host.selection(); } catch (e) { console.warn('[router] selection', e); }
  caretMemory.delete(key);
  if (sel && Number.isInteger(sel.from)) caretMemory.set(key, sel);
  while (caretMemory.size > MAX_CARET_MEMORY) caretMemory.delete(caretMemory.keys().next().value);
}

/**
 * Put the scroll back after the editor or the view has mounted. One frame later,
 * because a view lays itself out on mount and the editor's node views settle after `open`
 * resolves; the height has to exist before scrollTop can take it (C16).
 */
function restoreScroll(scroll, key, rec) {
  const top = rec ? rec.scroll.get(key) : 0;
  if (!top) return;
  requestAnimationFrame(() => { if (scroll.isConnected) scroll.scrollTop = top; });
}

/** How long the router waits for an `unmount` before it draws the next page anyway. */
const UNMOUNT_MS = 5000;

/**
 * The awaited `unmount` of a view or a folder, with a bound on the wait (docs/CORE.md, the
 * page lifecycle). A throw is caught and logged rather than left to reject, so the next mount
 * always proceeds; an `unmount` that never settles is named in a toast and left behind.
 */
async function callUnmount(view, where) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late: Promise<void> = new Promise((resolve) => {
    timer = setTimeout(() => {
      const what = (current && routeLabel(current)) || 'A page';
      console.error(`[router] ${where}: unmount of ${what} did not finish in ${UNMOUNT_MS / 1000} s`);
      try { toast(`${what} did not finish closing; going on without it`, 'err', 6000); } catch { /* no DOM */ }
      resolve();
    }, UNMOUNT_MS);
  });
  try {
    await Promise.race([Promise.resolve(view.unmount()), late]);
  } catch (e) {
    console.error(`[router] ${where}`, e);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The route on screen goes. A page is closed, or parked with `mode: 'park'` (it stays alive
 * for the tab that still shows it); a view or a folder is unmounted and awaited. Answers false
 * when the page host's `close()` answered false: the page is still mounted and nothing was
 * torn down, so the column must not be cleared (C1).
 */
async function teardown(mode) {
  if (!current) return true;
  rememberScroll();
  if (current.type === 'page') {
    const host = pageHost();
    if (host && typeof host.close === 'function') {
      try {
        const answer = mode === 'park' ? await host.close({ park: true }) : await host.close();
        if (answer === false) return false;
      } catch (err) { const e = (err as { code?: string, message?: string }); console.warn('[router] close page:', e.message || e); }
    }
  } else if (mountedView && typeof mountedView.unmount === 'function') {
    await callUnmount(mountedView, current.type === 'folder' ? 'folder unmount' : 'view unmount');
  }
  mountedView = null;
  return true;
}

/**
 * The window is going away (a close request, a reload, a change of vault): the view or folder
 * on screen is unmounted exactly as it would be on a navigation. The editor is left alone — it
 * answers the leave gate (`ose.window.onLeave`, ./leave.ts), saving and possibly vetoing.
 */
export async function unmountOnUnload() {
  if (!current || current.type === 'page') return;
  if (mountedView && typeof mountedView.unmount === 'function') {
    await callUnmount(mountedView, 'unload unmount');
  }
  mountedView = null;
}

function emptyState(html) {
  const box = document.createElement('div');
  box.className = 'page-col';
  box.innerHTML = html;
  return box;
}

/**
 * Mount a file into the column. One "loading…" line goes up if the mount outlasts the shared
 * delay and comes down when it resolves or fails, whichever way it ends (D9).
 */
async function renderPage(scroll, route, my) {
  const stop = loadingOverlay(scroll);
  try {
    await mountPage(scroll, route, my);
  } finally {
    stop();
  }
}

async function mountPage(scroll, route, my) {
  const { path, col, query } = route;
  // A heading becomes a line here, once, so the editor is only ever told about lines (N3).
  const line = route.line || (await resolveHeading(route)) || 0;
  if (route.heading && !line) toast(`No heading “${route.heading}” in ${path}`, 'info', 2600);
  // The caret the page was left with, when the caller has not asked for a line instead (N44).
  const selection = route.selection || (line ? null : caretMemory.get(routeKey(route)) || null);
  // A file outside the vault (X7) is registered with the host before anything reads it, every
  // time it mounts: so a tab, Recent and back or forward all work, and a path the
  // host finds inside this vault after all is shown as the vault file it is.
  if (isOutside(path)) {
    let reg: import('./bridge/commands.ts').OutsideFile | null = null;
    try { reg = await bridge.outsideOpen(path); } catch (e) {
      console.error('[router] outsideOpen', path, e);
      if (my !== seq) return;
      const box = emptyState(`
        <div class="miss">
          <div class="miss-title">Could not open this file</div>
          <div class="miss-path mono">${esc(outsideLabel(path))}</div>
          <div class="miss-why">${esc((e && (e as Error).message) || String(e))}</div>
          <button class="btn" data-act="retry">Retry</button>
        </div>`);
      box.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
        void navigate({ type: 'page', path }, { replace: true, force: true });
      });
      scroll.appendChild(box);
      return;
    }
    if (my !== seq) return;
    if (reg && reg.inside && reg.path) {
      const inside = reg.path;
      queueMicrotask(() => { void navigate({ type: reg.kind === 'dir' ? 'folder' : 'page', path: inside }, { replace: true, force: true }); });
      return;
    }
  }
  let st: import('./bridge/commands.ts').Stat_Serialize | null = null;
  // A stat that throws is not the same thing as a file that is not there: the first is a
  // locked file or a bridge fault and must never be offered "Create it", because that button
  // writes a stub over the path.
  try { st = await bridge.stat(path); } catch (err) {
    const e = (err as { code?: string, message?: string });
    console.error('[router] stat', path, e);
    const box = emptyState(`
      <div class="miss">
        <div class="miss-title">Could not read this file</div>
        <div class="miss-path mono">${esc(path)}</div>
        <div class="miss-why">${esc(e.message || String(e))}</div>
        <button class="btn" data-act="retry">Retry</button>
      </div>`);
    box.querySelector('[data-act="retry"]')?.addEventListener('click', () => {
      void navigate({ type: 'page', path }, { replace: true, force: true });
    });
    scroll.appendChild(box);
    return;
  }
  if (my !== seq) return;
  // A page route to a folder that `show` did not catch (it became a folder since): the folder
  // is shown in the sidebar and nothing is handed to the page host.
  if (st && st.exists && st.kind === 'dir') {
    revealFolder(path);
    return;
  }
  // A path the page host draws itself when it is missing (a media file, whose own miss says
  // more than "not found") goes straight to it (M4).
  const pages = pageHost();
  let claimed = false;
  try { claimed = !!(pages && typeof pages.claims === 'function' && pages.claims(path)); } catch { claimed = false; }
  if (!st.exists && !claimed && isOutside(path)) {
    // Nothing is created outside the vault: the file went, and the box says where it was.
    scroll.appendChild(emptyState(`
      <div class="miss">
        <div class="miss-title">Not found</div>
        <div class="miss-path mono">${esc(outsideLabel(path))}</div>
        <div class="miss-why">outside the vault</div>
      </div>`));
    return;
  }
  if (!st.exists && !claimed) {
    const box = emptyState(`
      <div class="miss">
        <div class="miss-title">Not found</div>
        <div class="miss-path mono">${esc(path)}</div>
        <button class="btn primary" data-act="create">Create it</button>
      </div>`);
    box.querySelector('[data-act="create"]')?.addEventListener('click', async () => {
      // Exclusive: a file that arrived since the stat is opened, never written over. A `.md`
      // gets its H1 and anything else starts empty (ose.fileops.create).
      try {
        await createFile(dirName(path), baseName(path), {});
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        if (!e || e.code !== 'exists') {
          toast(`Could not create ${path}: ${(e && e.message) || e}`, 'err', 0);
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
    if (pages) await pages.open(host, path, { line, col, query, selection });
    mounted = host.childElementCount > 0;
  } catch (err) {
    const e = (err as { code?: string, message?: string });
    console.error('[router] open page', e);
    toast('Could not open ' + path + ': ' + (e.message || e), 'err', 0);
  }

  // No page host, or one that drew nothing: show the file as text so navigation is visibly
  // working. Removed automatically as soon as a host renders something.
  if (!mounted && my === seq) {
    let text = '';
    try { text = await bridge.readText(path); } catch (err) { const e = (err as { code?: string, message?: string }); text = String(e.message || e); }
    host.innerHTML = `
      <div class="page-col fallback">
        <h1 class="page-title">${esc(display(path))}</h1>
        <div class="page-meta"><span>${esc(path)}</span><span>Plain text, no editor</span></div>
        <pre class="fallback-md text-select">${esc(text)}</pre>
      </div>`;
  }
}

async function renderView(scroll, route, my) {
  const v = views.get(route.name);
  if (!v) {
    scroll.appendChild(emptyState(`
      <div class="miss">
        <div class="miss-title">No such view</div>
        <div class="miss-path mono">${esc(route.name)}</div>
      </div>`));
    return;
  }
  mountedView = v;
  try {
    // Awaited, so a view with an `async mount` has drawn before the focus is settled and a
    // rejection lands in the box below rather than as an uncaught error over a blank column.
    // What `mount` answers counts too: a handle `{ unmount, refresh }` wins over the
    // registration, and what it leaves out the registration still answers. The route is the
    // second argument, so `arg` reaches the view.
    const handle = await v.mount(scroll, route);
    if (my !== seq) return;
    if (handle && typeof handle === 'object') mountedView = { ...v, ...handle };
  } catch (err) {
    const e = (err as { code?: string, message?: string });
    console.error('[router] view mount', e);
    if (my !== seq) return;
    scroll.appendChild(emptyState(`<div class="miss"><div class="miss-title">This view failed</div><div class="miss-path mono">${esc(e.message || e)}</div></div>`));
  }
}

/**
 * The window title (S13, W8): `<file name> · <vault>`, `<view title> · <vault>`, or the vault's name alone on an empty column.
 * A page is named by its file, never by its H1 (M13).
 */
function setWindowTitle(route) {
  const vault = (store.get('root') && store.get('root').name) || 'Ose';
  let text = vault;
  if (route && route.type === 'page' && isOutside(route.path)) {
    // A file outside the vault says so in the title bar, and says it instead of the vault (X7).
    text = `${display(route.path)} — outside vault`;
  } else if (route && route.type === 'page') {
    text = `${display(route.path)} · ${vault}`;
  } else if (route && route.type === 'view') {
    const v = views.get(route.name);
    text = `${(v && v.title) || route.name} · ${vault}`;
  }
  try { void bridge.setTitle(text); } catch (e) { console.warn('[router] setTitle', e); }
}

/**
 * How the page on screen is left by the change being made (4.3 "How a page is left"): parked
 * when it is still some other tab's current entry (another tab comes forward, or the page is
 * open in a second tab), otherwise asked and closed.
 */
function leaveMode(opts) {
  if (!current || current.type !== 'page') return 'navigate';
  if (opts.park) return 'park';
  const key = routeKey(current);
  for (const rec of T.records()) {
    if (rec === mountedTab) continue;
    const r = T.currentOf(rec);
    if (r && routeKey(r) === key) return 'park';
  }
  return 'navigate';
}

/**
 * Ask the page on screen whether it can be left (C1). A parked page is never asked: it is not
 * being left, only put aside. Answers true when there is no page, no page host or no
 * `canLeave`; a `canLeave` that throws is a no, because the one thing that must never happen
 * is a buffer thrown away because its save threw.
 */
async function pageLets(mode) {
  if (!current || current.type !== 'page' || mode === 'park') return true;
  const host = pageHost();
  if (!host || typeof host.canLeave !== 'function') return true;
  try {
    return (await host.canLeave('navigate')) !== false;
  } catch (e) {
    console.error('[router] canLeave', e);
    return false;
  }
}

/** An older show's leave phase, waited for no longer than an unmount (a save that hangs). */
function bounded(p: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(p).catch(() => {}),
    new Promise<any>((resolve) => { timer = setTimeout(resolve, UNMOUNT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * What a navigate, back or forward is about to do to `rec`, taken before it does it: handed to
 * `show` with the edit made, so a newer show can take it back (`overtake`).
 */
function before(rec) {
  return { rec, before: { stack: rec.stack.slice(), index: rec.index } };
}

/**
 * The edit made: `c` from `before()`, completed with what `rec` holds now.
 */
function made(c: { rec: TabRecord; before: { stack: Route[]; index: number; }; }, route: Route | null = null) {
  return { ...c, after: { stack: c.rec.stack.slice(), index: c.rec.index }, route };
}

/**
 * Take back the edit an overtaken show made to its tab. Untouched since: the tab is exactly
 * what it was before. Changed since (a newer navigate in the same tab): only the entry the
 * overtaken navigate pushed is dropped, and the tab's position follows.
 */
function overtake(c) {
  const rec = c.rec;
  if (!T.records().includes(rec)) return;
  const untouched = rec.index === c.after.index && rec.stack.length === c.after.stack.length
    && rec.stack.every((r, i) => r === c.after.stack[i]);
  if (untouched) {
    rec.stack = c.before.stack.slice();
    rec.index = c.before.index;
    return;
  }
  if (!c.route || c.before.stack.includes(c.route)) return;
  const at = rec.stack.indexOf(c.route);
  if (at < 0 || rec.stack.length < 2) return;
  rec.stack = rec.stack.filter((_, i) => i !== at);
  if (rec.index >= at) rec.index = Math.max(0, rec.index - 1);
}

/**
 * Put the active tab's current entry on the column (or leave it empty when there is none).
 * The model has already been changed under a snapshot (`T.beginChange`). Answers false, and
 * changes nothing that anybody can see, when the page on screen refuses to be left or a newer
 * show took over; true once the new route is up.
 *
 * Nothing happens before the veto: no `route` or `tabs` event, no store change, no DOM change.
 * A refused change leaves the column, the tab strip and the title bar exactly as they were,
 * and the model goes back to the snapshot.
 *
 * opts: { focus, park, reason }. `park`: the page on screen stays alive for the tab that still
 * shows it. `reason` rides on the `tabs` event.
 */
async function show(opts: ShowOpts = {}, own: { rec: TabRecord; before: { stack: Route[]; index: number; }; after: { stack: Route[]; index: number; }; route: Route | null; } | null = null): Promise<boolean> {
  T.beginChange();
  const my = ++seq;
  // An older show still in flight is overtaken: what it did to its own tab is taken back, so
  // its navigate does not survive in a history the user never saw it reach, and the page it
  // was leaving is still that tab's current entry (parked, not orphaned).
  if (claim) { overtake(claim); claim = null; }
  claim = own ? { ...own, my } : null;
  const earlier = leaving;
  let release: () => void = (): void => {};
  const phase: Promise<void> = new Promise((resolve) => { release = () => resolve(); });
  leaving = phase;
  const done = () => { release(); if (leaving === phase) leaving = null; };
  const settle = () => { if (claim && claim.my === my) claim = null; };
  if (earlier) await bounded(earlier);
  if (my !== seq) { done(); return false; }
  // A page route that turns out to be a folder (a link to one, a Go to file of a folder name):
  // a folder is never a place, so the change is taken back before anything is asked or torn
  // down, the folder is revealed in the sidebar, and the page on screen stays as it was.
  // Only a new entry is taken back (a navigate, a tab opened); one already in a history that
  // became a folder since is left to `mountPage`, which reveals it and mounts nothing.
  const adds = opts.reason === 'navigate' || opts.reason === 'open';
  if (adds && await isFolderRoute(T.currentOf(T.activeRecord()))) {
    if (my !== seq) { done(); return false; }
    const to = T.currentOf(T.activeRecord());
    settle();
    T.rollbackChange();
    done();
    if (to) revealFolder(to.path);
    return false;
  }
  if (my !== seq) { done(); return false; }
  const mode = leaveMode(opts);
  // The page this show asks: only it may be handed back if the answer comes too late.
  const asked = current;
  const ok = await pageLets(mode);
  // Superseded: the newer show decides, and holds the snapshot if it must roll back. A yes
  // froze the page, and this navigation will not happen: the page is handed back now, before
  // the newer show (which waits for this) parks it or asks it again.
  //
  // The newer show waits for this one at most UNMOUNT_MS (`bounded`). When a slow save made it
  // stop waiting, it has already moved on, and the page on screen may be another one, perhaps
  // frozen by the newer show's own question: `stay` goes only to the page that was asked, while
  // it is still the page on screen. A page the newer show parked in the meantime is thawed by
  // the editor when it comes back (`reattach`), since nothing holds its leave any more.
  if (my !== seq) {
    if (ok && mode !== 'park' && current === asked) {
      try { pageHost()?.stay?.(); } catch (e) { console.error('[router] stay', e); }
    }
    done();
    return false;
  }
  const rec = T.activeRecord();
  const route = T.currentOf(rec);
  if (!ok) {
    settle();
    T.rollbackChange();
    done();
    bus.emit('route:refused', { from: current, to: route });
    return false;
  }
  let left = false;
  try { left = await teardown(mode); } finally { done(); }
  if (!left) {
    // `close()` said no after `canLeave` said yes: undo the freeze, keep everything.
    try { pageHost()?.stay?.(); } catch (e) { console.error('[router] stay', e); }
    if (my === seq) {
      settle();
      T.rollbackChange();
      bus.emit('route:refused', { from: current, to: route });
    }
    return false;
  }
  if (my !== seq) return false;
  settle();
  T.commitChange();
  // Read again: the model is what it is now, after anything a superseded show left behind.
  const tab = T.activeRecord();
  const next = T.currentOf(tab);
  // Only `initRouter` gives the router a column; a show before it has nowhere to draw.
  const main = mainEl;
  if (!main) return false;

  main.textContent = '';
  const scroll = document.createElement('div');
  scroll.className = 'main-scroll';
  main.appendChild(scroll);
  scrollEl = scroll;
  scroll.addEventListener('scroll', () => bus.emit('route:scroll'), { passive: true });

  current = next;
  mountedTab = next ? tab : null;
  store.set('route', next);
  setWindowTitle(next);
  T.emitTabs(opts.reason || 'route');
  bus.emit('route', next);

  // No tab and no home: an empty column.
  if (!next) return true;

  if (next.type === 'page') {
    pushRecent(next.path);
    await renderPage(scroll, next, my);
  } else {
    await renderView(scroll, next, my);
  }
  spend(next);
  if (my !== seq) return true;
  restoreScroll(scroll, routeKey(next), tab);
  // `focus: false` is for callers that navigate while the user is somewhere else on purpose;
  // every ordinary open lands the caret.
  if (opts.focus !== false) settleFocus(scroll);
  return true;
}

/**
 * True when `route` is a page route whose path is a folder in the vault. A path outside the
 * vault is left to `mountPage` (the host answers for it when it is registered), and a stat that
 * fails is not a folder: the mount says what went wrong.
 */
async function isFolderRoute(route) {
  if (!route || route.type !== 'page' || !route.path || isOutside(route.path)) return false;
  try {
    const st = await bridge.stat(route.path);
    return !!(st && st.exists && st.kind === 'dir');
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- navigating in a tab */

/**
 * A folder is not a place of its own: the sidebar is where folders are. Asking for one shows it
 * there, unfolded and selected, and the page on screen stays.
 */
function revealFolder(path: string) {
  bus.emit('tree:reveal', { path, focus: true, open: true });
}

/**
 * `ose.route.navigate(route, { replace, force, focus, tab })` -> Promise<boolean>. Pushes onto
 * the active tab's history (M23). `tab`: 'current' (the default), 'new' (a tab of its own, as
 * `tabs.open(route, { reuse: false })`), or a tab id, which is brought forward and navigated.
 * False when the page on screen refused to be left (its banner says why); the history is then
 * exactly what it was. Another tab showing the same route is not looked for: that is
 * `tabs.open`'s `reuse`.
 */
export function navigate(route, opts: any = {}) {
  const r = normalize(route);
  if (!r) return Promise.resolve(false);
  if (r.type === 'folder') { revealFolder(r.path); return Promise.resolve(false); }
  const where = opts.tab;
  if (where === 'new') return openTab(r, { reuse: false, focus: opts.focus }).then((x) => x.shown);
  if (where && where !== 'current') {
    const target = T.recordOf(where);
    if (!target) return Promise.resolve(false);
    if (target.id !== T.activeTabId()) {
      return activateTab(target.id, { focus: opts.focus })
        .then((ok) => (ok ? navigate(r, { ...opts, tab: 'current' }) : false));
    }
  }
  const rec = T.activeRecord();
  // No tab at all yet: the route makes the first one.
  if (!rec) return openTab(r, { reuse: false, focus: opts.focus }).then((x) => x.shown);

  const cur = T.currentOf(rec);
  const same = !!current && current === cur && routeKey(current) === routeKey(r);
  // The open page asked for again with a line or a heading (a second search hit in the same
  // file, an anchor into it): the request must still reach the editor, but it is the same page
  // and gets no second history entry; the entry just learns where to land (C7, N3). The page
  // is not left, so it is not asked.
  if (same && !opts.force && r.type === 'page' && (r.line || r.heading)) {
    // Only a snapshot this jump took is this jump's to settle: one that an earlier change
    // still in flight holds stays with it.
    const took = !T.changePending();
    T.beginChange();
    rec.stack[rec.index] = r;
    return (async () => {
      const line = r.line || (await resolveHeading(r));
      let shown = true;
      if (!line) {
        if (r.heading) toast(`No heading “${r.heading}” on this page`, 'info', 2600);
        if (took) T.commitChange();
        current = r;
      } else if (pageHost() && typeof pageHost().scrollToLine === 'function' && pageHost().scrollToLine(line, r.col)) {
        if (took) T.commitChange();
        current = r;
      } else {
        // The page could not jump in place, so it is shown again, and that does leave it.
        r.line = line;
        shown = await show({ ...opts, reason: 'navigate' });
      }
      // Landed or not, the jump is spent: the entry is the page, nothing more.
      spend(r);
      return shown;
    })();
  }
  // The same view with an argument: shown again in place of the entry, so the section lands.
  if (same && !opts.force && carriesSpent(r)) {
    T.beginChange();
    rec.stack[rec.index] = r;
    return show({ ...opts, reason: 'navigate' });
  }
  if (same && !opts.force) return Promise.resolve(true);

  T.beginChange();
  const own = before(rec);
  const replacing = !!opts.replace && rec.index >= 0;
  if (replacing) rec.stack[rec.index] = r;
  else T.pushEntry(rec, r);
  // A replaced entry is only ever put back whole; a pushed one can also be dropped alone.
  return show({ ...opts, reason: 'navigate' }, made(own, replacing ? null : r));
}

/** Back one entry in the active tab. False when there is none or the page refused to be left. */
export function back() {
  const rec = T.activeRecord();
  if (!rec || rec.index <= 0) return Promise.resolve(false);
  T.beginChange();
  const own = before(rec);
  rec.index -= 1;
  return show({ reason: 'back' }, made(own));
}

/** Forward one entry in the active tab. False when there is none or the page refused. */
export function forward() {
  const rec = T.activeRecord();
  if (!rec || rec.index < 0 || rec.index >= rec.stack.length - 1) return Promise.resolve(false);
  T.beginChange();
  const own = before(rec);
  rec.index += 1;
  return show({ reason: 'forward' }, made(own));
}

export function canBack() { const rec = T.activeRecord(); return !!rec && rec.index > 0; }
export function canForward() { const rec = T.activeRecord(); return !!rec && rec.index >= 0 && rec.index < rec.stack.length - 1; }

/** `ose.route.setHome(route)`: the route the last tab falls back to instead of an empty column. */
export function setHome(route) { T.setHome(normalize(route)); }

/**
 * `ose.route.close()`: close the active tab (Ctrl+W). -> Promise<boolean>, false when its page
 * refused to be closed. With no tab open there is nothing to close, and that is true.
 */
export function clearRoute(opts: any = {}) {
  const id = T.activeTabId();
  if (!id) return Promise.resolve(true);
  return closeTab(id, opts);
}

/* ------------------------------------------------------------------------------ tabs */

/** True when another tab than `except` has `route` as its current entry. */
function shownElsewhere(route, except) {
  const key = routeKey(route);
  return T.records().some((rec) => rec !== except && routeKey(T.currentOf(rec)) === key);
}

/** True when a record is nothing but Home: closing it would change nothing worth keeping. */
function onlyHome(rec) {
  const home = T.homeRoute();
  if (!home) return false;
  const key = routeKey(home);
  return rec.stack.length > 0 && rec.stack.every((r) => routeKey(r) === key);
}

/**
 * `ose.tabs.open(route, { activate = true, index, reuse = true, focus })` -> { id, shown }.
 * `reuse`: a tab whose current entry is the same route is brought forward instead, and a line
 * or a heading the route carries still lands in it. A tab opened with `activate: false` is
 * drawn in the strip and mounts nothing until it is brought forward.
 */
export async function openTab(route: unknown, { activate = true, index, reuse = true, focus }: { activate?: boolean; index?: number; reuse?: boolean; focus?: boolean; } = {}): Promise<{ id: string | null; shown: boolean; }> {
  const r = normalize(route);
  if (!r) return { id: null, shown: false };
  if (r.type === 'folder') { revealFolder(r.path); return { id: null, shown: false }; }
  if (reuse) {
    const key = routeKey(r);
    const hit = T.records().find((rec) => routeKey(T.currentOf(rec)) === key);
    if (hit) {
      if (!activate) return { id: hit.id, shown: false };
      let shown = await activateTab(hit.id, { focus });
      if (shown && carriesSpent(r)) shown = await navigate(r, { focus });
      return { id: hit.id, shown };
    }
  }
  const rec = T.newRecord(r);
  if (!activate) {
    T.insertRecord(rec, index, { background: true });
    T.emitTabs('open');
    return { id: rec.id, shown: false };
  }
  T.beginChange();
  T.insertRecord(rec, index);
  T.setActive(rec.id);
  // The page on screen is still its own tab's current entry, so it is parked, never asked.
  const shown = await show({ park: true, focus, reason: 'open' });
  return { id: rec.id, shown };
}

/** `ose.tabs.activate(id)` -> Promise<boolean>. The page it leaves is parked, never asked. */
export function activateTab(id: string, { focus }: { focus?: boolean; } = {}): Promise<boolean> {
  const rec = T.recordOf(id);
  if (!rec) return Promise.resolve(false);
  if (id === T.activeTabId() && current && current === T.currentOf(rec)) return Promise.resolve(true);
  T.beginChange();
  T.setActive(id);
  return show({ park: true, focus, reason: 'activate' });
}

/**
 * `ose.tabs.close(id)` -> Promise<boolean>. The active tab: its page is asked (or parked when
 * another tab shows the same file) and the tab used before it comes forward; the last tab goes
 * to Home instead of disappearing, or to an empty column when there is no Home. A background
 * tab whose page no other tab shows: that page is released (saved and destroyed) first, and a
 * page that cannot be saved keeps its tab. False: nothing changed.
 */
export async function closeTab(id: string, { focus }: { focus?: boolean; } = {}): Promise<boolean> {
  const rec = T.recordOf(id);
  if (!rec) return false;
  if (id !== T.activeTabId()) {
    const r = T.currentOf(rec);
    if (r && r.type === 'page' && !shownElsewhere(r, rec)) {
      const host = pageHost();
      if (host && typeof host.release === 'function') {
        let ok = false;
        try { ok = (await host.release(r.path)) !== false; } catch (e) { console.error('[router] release', e); ok = false; }
        if (!ok) return false;
      }
    }
    if (!T.recordOf(id)) return true;
    T.removeRecord(id, { remember: !onlyHome(rec), background: true });
    T.emitTabs('close');
    return true;
  }
  // The last tab, already on nothing but Home: there is nothing to close.
  if (T.records().length === 1 && onlyHome(rec) && rec.stack.length === 1) return true;
  T.beginChange();
  const next = T.nextAfterClose(id);
  T.removeRecord(id, { remember: !onlyHome(rec) });
  if (next) {
    T.setActive(next.id);
  } else if (T.homeRoute()) {
    const fresh = T.newRecord({ ...T.homeRoute() });
    T.insertRecord(fresh);
    T.setActive(fresh.id);
  } else {
    T.setActive(null);
  }
  return show({ focus, reason: 'close' });
}

/** `ose.tabs.closeOthers(id)` -> Promise<boolean>: `id` comes forward, every other tab closes. */
export async function closeOtherTabs(id) {
  if (!T.recordOf(id)) return false;
  if (id !== T.activeTabId() && !(await activateTab(id))) return false;
  let all = true;
  for (const other of T.records().filter((r) => r.id !== id)) {
    if (!(await closeTab(other.id))) all = false;
  }
  return all;
}

/** `ose.tabs.move(id, index)`: a new place in the strip; nothing is mounted. */
export function moveTab(id, index) {
  if (T.moveRecord(id, index)) T.emitTabs('move');
}

/** `app.reopen-closed` (Ctrl+Shift+T): the last closed tab, with its whole history, where it was. */
export function reopenClosedTab() {
  if (!T.closedRecords().length) { toast('No closed tab to reopen', 'info', 2000); return Promise.resolve(false); }
  T.beginChange();
  const e = T.takeClosed();
  T.insertRecord(e.rec, e.at);
  T.setActive(e.rec.id);
  return show({ park: true, reason: 'reopen' });
}

export function canReopenClosed() { return T.closedRecords().length > 0; }

/**
 * The route on screen, mounted again: a media page that follows its file, a view whose paths
 * changed, the leave gate putting back what it unmounted. The ordinary teardown-and-draw path.
 */
export function reopenCurrent() {
  if (!T.activeRecord()) return Promise.resolve(true);
  return show({ reason: 'reload' });
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

/** A route key under a move, renamed; any other key as it was. */
function mapKey(key, moves) {
  const at = key.indexOf(':');
  const kind = key.slice(0, at);
  if (kind !== 'page') return key;
  const next = mapPath(key.slice(at + 1), moves);
  return next === null ? key : `${kind}:${next}`;
}

/** A Map keyed by route key, with every key under a move renamed; the order is kept. */
function rekey(map, moves) {
  const entries = [...map.entries()];
  map.clear();
  for (const [key, value] of entries) map.set(mapKey(key, moves), value);
}

/**
 * A file or a folder moved on disk and the page that shows it followed it (C6): every page
 * route at `from`, or under `from/`, now says `to` — in every tab, its whole history,
 * the closed tabs and a pending snapshot. Nothing is unmounted and nothing is mounted, so the
 * editor keeps its buffer and its undo history, and no `route` event goes out;
 * `route:repointed` `{ moves, current }` and `tabs` do.
 *
 * Also updates the recent list, the scroll and caret memories, the store's `route`
 * and the window title.
 */
export function repoint(moves: Array<{ from: string; to: string; }>) {
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
    const to = r.path ? mapPath(r.path, list) : null;
    const next = to === null ? r : { ...r, path: to };
    seen.set(r, next);
    return next;
  };

  const before = current;
  current = remap(current);
  T.mapRoutes(remap);
  for (const rec of [...T.records(), ...T.closedRecords().map((e) => e.rec)]) {
    rekey(rec.scroll, list);
  }
  rekey(caretMemory, list);

  const recent = recentFiles();
  const nextRecent: any[] = [];
  for (const p of recent) {
    const q = mapPath(p, list) ?? p;
    if (!nextRecent.includes(q)) nextRecent.push(q);
  }
  if (nextRecent.length !== recent.length || nextRecent.some((p, i) => p !== recent[i])) recentStore().set(nextRecent);

  if (current !== before) {
    store.set('route', current);
    setWindowTitle(current);
  }
  T.emitTabs('repoint');
  bus.emit('route:repointed', { moves: list, current });
}

/**
 * After a trash (4.3): every tab whose current entry is at or under a trashed path goes Home.
 * History entries are left alone. A background
 * tab's parked page is released (the editor has marked it clean: nothing is written); the
 * active tab is shown again, and a page that still refuses keeps its entry.
 */
async function followTrash(paths) {
  const gone = paths.map(clean).filter(Boolean);
  if (!gone.length) return;
  const hit = (r) => {
    if (!r || r.type !== 'page' || !r.path) return null;
    const p = clean(r.path);
    return gone.find((g) => p === g || p.startsWith(g + '/')) || null;
  };
  let activeHit: { rec: any; to: Route; } | null = null;
  let changed = false;
  for (const rec of T.records()) {
    const r = T.currentOf(rec);
    const g = hit(r);
    if (!g) continue;
    // A page that went to the trash: its tab goes Home.
    const to = { ...(T.homeRoute() || { type: 'view', name: 'home' }) };
    if (rec.id === T.activeTabId()) { activeHit = { rec, to }; continue; }
    if (r.type === 'page' && !shownElsewhere(r, rec)) {
      try { await pageHost()?.release?.(r.path); } catch (e) { console.warn('[router] release after trash', e); }
    }
    // Through `mapRoutes`, so a snapshot a pending change holds says the same thing.
    T.mapRoutes((x) => (x === r ? to : x));
    changed = true;
  }
  if (activeHit && T.activeRecord() === activeHit.rec) {
    T.beginChange();
    activeHit.rec.stack[activeHit.rec.index] = activeHit.to;
    await show({ reason: 'trash' });
    return;
  }
  if (changed) T.emitTabs('trash');
}
