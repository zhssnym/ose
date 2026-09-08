// Router. Two route shapes: {type:'page', path, line?} and {type:'view', name}. `line` is a
// 1-based line of the file to land on (C7): a search hit, a task row. It is carried, never
// part of a route's identity, so two routes to one page are the same page.
// Owns the teardown/mount cycle for the main column, the back/forward stack, the 'route'
// event, and the recent-files list the quick-open palette reads.
import { bus, store, status, views, debounce, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { openPage, closePage } from '../editor/index.js';
import { patchState, stateCache, flushState } from './state.js';
import { titleOf, clean, dirName } from './paths.js';
import { toast } from './dialog.js';
import { shortcutFor } from './keys.js';
import { loadingOverlay } from '../lib/loading.js';

const MAX_RECENT = 40;
// How many recent pages the empty surface lists (D7). Enough to find yesterday, not a dashboard.
const START_RECENT = 8;
// Scroll positions kept per route key (C16). Fifty is more than the back stack holds.
const MAX_SCROLL_MEMORY = 50;

let mainEl = null;
let scrollEl = null;
let current = null;
let mountedView = null;
let stack = [];
let index = -1;
let seq = 0;
const scrollMemory = new Map();

export function currentRoute() { return current; }
export function routeKey(r) {
  if (!r) return '';
  return r.type === 'page' ? 'page:' + clean(r.path) : 'view:' + r.name;
}
export function routeLabel(r) {
  if (!r) return '';
  return r.type === 'page' ? clean(r.path) : 'view/' + r.name;
}

function normalize(route) {
  if (!route || typeof route !== 'object') return null;
  if (route.type === 'page' && route.path) {
    const r = { type: 'page', path: clean(route.path) };
    // Only a real line survives: a 0, a float or a string would make the editor guess (C7).
    if (Number.isInteger(route.line) && route.line > 0) r.line = route.line;
    return r;
  }
  if (route.type === 'view' && route.name) return { type: 'view', name: String(route.name) };
  return null;
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

export function initRouter(el) {
  mainEl = el;

  // The app no longer opens at a route (CONTRACT.md batch 2): drop any route left in
  // App/state.json by an older build so nothing resurrects it.
  if (stateCache().route !== undefined) patchState({ route: undefined });

  // On close the editor's own subscriber returns its final save (and may veto, batch 9); the
  // router's only duty is the state file. Returning the promise is what lets the adapter await
  // it rather than trusting a timer.
  bridge.on('window', (d) => {
    if (d && d.closing) return flushState();
    return undefined;
  });

  const refresh = debounce(() => {
    if (mountedView && typeof mountedView.refresh === 'function') {
      try { mountedView.refresh(); } catch (e) { console.error('[shell] view refresh', e); }
    }
  }, 300);
  bus.on('fs', refresh);

  // No startup route (CONTRACT.md batch 2), but not a bare rectangle either: the empty
  // surface is drawn now, without taking focus from the sidebar the user is about to use.
  void show(null, { focus: false });
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
  const pick = mainEl.querySelector('.ProseMirror')
    || mainEl.querySelector('.page-title')
    || mainEl.querySelector('.view-root')
    || mainEl.querySelector('.start-row')
    || mainEl.querySelector('.miss .btn');   // "Create it" / "Retry": Enter should reach it
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

async function teardown() {
  if (!current) return;
  rememberScroll();
  if (current.type === 'page') {
    try { await closePage(); } catch (e) { console.warn('[shell] closePage:', e.message || e); }
  } else if (mountedView && typeof mountedView.unmount === 'function') {
    try { mountedView.unmount(); } catch (e) { console.error('[shell] view unmount', e); }
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

async function mountPage(scroll, { path, line }) {
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
        <button class="btn" data-act="retry">Retry</button>
      </div>`);
    box.querySelector('[data-act="retry"]').addEventListener('click', () => {
      navigate({ type: 'page', path }, { replace: true, force: true });
    });
    scroll.appendChild(box);
    return;
  }
  if (!st.exists) {
    const box = emptyState(`
      <div class="miss">
        <div class="miss-title">page not found</div>
        <div class="miss-path mono">${esc(path)}</div>
        <button class="btn primary" data-act="create">Create it</button>
      </div>`);
    box.querySelector('[data-act="create"]').addEventListener('click', async () => {
      await bridge.writeText(path, `# ${titleOf(path)}\n`);
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
    await openPage(host, path, { line });
    mounted = host.childElementCount > 0;
  } catch (e) {
    console.error('[shell] openPage', e);
    toast('could not open ' + path + ': ' + (e.message || e), 'err');
  }

  // Fallback while the editor module is still a placeholder: show the file so navigation
  // is visibly working. Removed automatically once openPage renders something.
  if (!mounted) {
    let text = '';
    try { text = await bridge.readText(path); } catch (e) { text = String(e.message || e); }
    host.innerHTML = `
      <div class="page-col fallback">
        <h1 class="page-title">${esc(titleOf(path))}</h1>
        <div class="page-meta"><span>${esc(path)}</span><span>raw · editor not mounted</span></div>
        <pre class="fallback-md text-select">${esc(text)}</pre>
      </div>`;
  }
}

function renderView(scroll, name) {
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
  try { v.mount(scroll); } catch (e) {
    console.error('[shell] view mount', e);
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

async function show(route, opts = {}) {
  const my = ++seq;
  await teardown();
  if (my !== seq) return;

  mainEl.textContent = '';
  const scroll = document.createElement('div');
  scroll.className = 'main-scroll';
  mainEl.appendChild(scroll);
  scrollEl = scroll;

  if (!route) {
    current = null;
    store.set('route', null);
    status.set('path', null);
    bus.emit('route', null);
    await renderStart(scroll, my, opts);
    return;
  }

  current = route;
  store.set('route', route);
  status.set('path', routeLabel(route));
  bus.emit('route', route);

  if (route.type === 'page') {
    pushRecent(route.path);
    await renderPage(scroll, route);
  } else {
    renderView(scroll, route.name);
  }
  if (my !== seq) return;
  restoreScroll(scroll, routeKey(route));
  // `focus: false` is for callers that navigate while the user is somewhere else on purpose
  // (a tree previewing on arrow keys would be one); every ordinary open lands the caret.
  if (opts.focus !== false) settleFocus(scroll);
}

/** navigate(route, { replace, force, focus }) — `focus: false` leaves focus where it is. */
export function navigate(route, opts = {}) {
  const r = normalize(route);
  if (!r) return Promise.resolve();

  const same = !!current && routeKey(current) === routeKey(r);
  // The open page asked for again with a line (a second search hit in the same file): the
  // request must still reach the editor, so it is shown as if forced, but it is the same
  // page and gets no second history entry; the current entry just learns the line (C7).
  if (same && !opts.force && r.line) {
    if (index >= 0) stack[index] = r;
    return show(r, opts);
  }
  if (same && !opts.force) return Promise.resolve();

  if (opts.replace && index >= 0) stack[index] = r;
  else { stack = stack.slice(0, index + 1); stack.push(r); index = stack.length - 1; }
  if (stack.length > 100) { stack = stack.slice(-100); index = stack.length - 1; }

  return show(r, opts);
}

export function back() {
  if (index <= 0) return;
  index -= 1;
  show(stack[index]);
}

export function forward() {
  if (index < 0 || index >= stack.length - 1) return;
  index += 1;
  show(stack[index]);
}

export function canBack() { return index > 0; }
export function canForward() { return index >= 0 && index < stack.length - 1; }

/**
 * Back to the empty surface: nothing drawn in the main column, no route. This is the state
 * the app boots into, and where trashing the open page lands when there is nothing to show
 * in its place.
 */
export function clearRoute(opts = {}) {
  stack = stack.slice(0, index + 1);
  return show(null, opts);
}

/** Used by the sidebar after a rename/trash of the page currently open. */
export function reopenCurrent() {
  if (current) show(current);
}
