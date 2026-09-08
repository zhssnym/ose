// Router. Two route shapes: {type:'page', path} and {type:'view', name}.
// Owns the teardown/mount cycle for the main column, the back/forward stack, the 'route'
// event, and the recent-files list the quick-open palette reads.
import { bus, store, status, views, debounce, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { openPage, closePage, saveNow } from '../editor/index.js';
import { patchState, stateCache, flushState } from './state.js';
import { titleOf, clean } from './paths.js';
import { toast } from './dialog.js';

const MAX_RECENT = 40;

let mainEl = null;
let current = null;
let mountedView = null;
let stack = [];
let index = -1;
let seq = 0;

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
  if (route.type === 'page' && route.path) return { type: 'page', path: clean(route.path) };
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

  bridge.on('window', (d) => {
    if (d && d.closing) {
      try { saveNow(); } catch (e) { console.warn('[shell] saveNow on close:', e.message || e); }
      flushState();
    }
  });

  const refresh = debounce(() => {
    if (mountedView && typeof mountedView.refresh === 'function') {
      try { mountedView.refresh(); } catch (e) { console.error('[shell] view refresh', e); }
    }
  }, 300);
  bus.on('fs', refresh);
}

async function teardown() {
  if (!current) return;
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

async function renderPage(scroll, path) {
  let st = null;
  // A stat that throws is not the same thing as a file that is not there: the first is a
  // locked file or a bridge fault and must never be offered "Create it", because that button
  // writes a stub over the path.
  try { st = await bridge.stat(path); } catch (e) {
    console.error('[shell] stat', path, e);
    const box = emptyState(`
      <div class="miss">
        <div class="label">could not read that page</div>
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
        <div class="label">page not found</div>
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
    await openPage(host, path);
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
        <div class="label">view not registered</div>
        <div class="miss-path mono">${esc(name)}</div>
      </div>`));
    return;
  }
  mountedView = v;
  try { v.mount(scroll); } catch (e) {
    console.error('[shell] view mount', e);
    scroll.appendChild(emptyState(`<div class="miss"><div class="label">view failed</div><div class="miss-path mono">${esc(e.message || e)}</div></div>`));
  }
}

async function show(route) {
  const my = ++seq;
  await teardown();
  if (my !== seq) return;

  mainEl.textContent = '';

  if (!route) {
    current = null;
    store.set('route', null);
    status.set('path', null);
    bus.emit('route', null);
    return;
  }

  const scroll = document.createElement('div');
  scroll.className = 'main-scroll';
  mainEl.appendChild(scroll);

  current = route;
  store.set('route', route);
  status.set('path', routeLabel(route));
  bus.emit('route', route);

  if (route.type === 'page') {
    pushRecent(route.path);
    await renderPage(scroll, route.path);
  } else {
    renderView(scroll, route.name);
  }
}

export function navigate(route, opts = {}) {
  const r = normalize(route);
  if (!r) return Promise.resolve();

  if (!opts.force && current && routeKey(current) === routeKey(r)) return Promise.resolve();

  if (opts.replace && index >= 0) stack[index] = r;
  else { stack = stack.slice(0, index + 1); stack.push(r); index = stack.length - 1; }
  if (stack.length > 100) { stack = stack.slice(-100); index = stack.length - 1; }

  return show(r);
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
export function clearRoute() {
  stack = stack.slice(0, index + 1);
  return show(null);
}

/** Used by the sidebar after a rename/trash of the page currently open. */
export function reopenCurrent() {
  if (current) show(current);
}
