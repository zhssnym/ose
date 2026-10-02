// The window's title bar, which is the app's toolbar: the sidebar's fold, the app mark, back
// and forward, and the path bar. The window has no
// system title bar: its empty parts move the window (`data-tauri-drag-region`; a double click
// maximises), and the window buttons are drawn here on Windows and Linux. On macOS the system's
// traffic lights sit over the row's left end, which leaves them room.
//
// The path bar (M21): the place on screen as segments — the vault's name, each folder, then
// the file — and every folder segment is a button that opens that folder (Ctrl+click: a new
// tab). A page outside the vault reads "Outside the vault", its folder, then its name.

import { ose } from 'ose:core';
import { icon } from 'ose:ui';
import { sidebarVisible } from './layout.js';
import { openInNewTab } from './tabs.js';
import { LOGO } from './logo.js';
import { HOME } from './start.js';
import { clean, baseName, dirName, titleOf, vaultName, isOutside, outsideLabel } from './paths.js';

const { bus, commands, route } = ose;
const currentRoute = () => route.current();

let el = null;
let addrEl = null;
/** The save dot: drawn by the status bar (statusbar.js), kept current from here. */
const dot = () => /** @type {HTMLElement|null} */ (document.querySelector('.tb-dirty'));
let foldEl = null;
let navEls = null;

/* ------------------------------------------------------------------ the address, at rest */

/** A file's name as the chrome shows it (W8): whole, `.md` stripped only when hideMdExt is on. */
const display = (path) => titleOf(path) || baseName(path);

/**
 * The segments of a route: `[{ text, folder?, cur? }]`. The vault's name always leads, so the
 * root is one click away from anywhere; a folder segment carries the folder it opens.
 */
function partsOf(r) {
  /** @typedef {{text: string, folder?: string, home?: boolean, cur?: boolean, outside?: boolean, path?: string}} Part */
  /** @type {Part} */
  const vault = { text: vaultName(), home: true, cur: false };
  /** @type {Part[]} */
  const parts = [vault];
  if (!r) return parts;
  // The empty page: the vault's name alone.
  if (r.type === 'view' && r.name === 'home') { vault.cur = true; return parts; }
  if (r.type === 'view') {
    const v = ose.views.get(r.name);
    parts.push({ text: (v && v.title) || r.name, cur: true });
    return parts;
  }
  if (r.type === 'page' && isOutside(r.path)) {
    // A file outside the vault (X7): no folder of it is a place in the app, so its folder is
    // one plain segment with the whole absolute path, and nothing but the name is current.
    const abs = outsideLabel(clean(r.path));
    parts[0] = { text: 'Outside the vault', outside: true };
    const dir = outsideLabel(dirName(clean(r.path)));
    if (dir) parts.push({ text: dir, path: dir });
    parts.push({ text: display(r.path), cur: true, path: abs });
    return parts;
  }
  const segs = clean(r.path).split('/').filter(Boolean);
  segs.forEach((s, i) => {
    const dir = segs.slice(0, i + 1).join('/');
    const last = i === segs.length - 1;
    if (last && r.type === 'page') parts.push({ text: display(dir), cur: true, path: dir });
    else parts.push({ text: s, folder: dir, cur: last });
  });
  if (!segs.length && r.type === 'folder' && parts[0]) parts[0].cur = true;
  return parts;
}

function renderAddress(r) {
  if (!addrEl) return;
  const crumbs = addrEl.querySelector('.tb-crumbs');
  crumbs.textContent = '';
  const parts = partsOf(r);
  parts.forEach((p, i) => {
    if (i) {
      const s = document.createElement('span');
      s.className = 'tb-sep-ch';
      s.setAttribute('aria-hidden', 'true');
      s.textContent = '›';
      crumbs.appendChild(s);
    }
    const b = document.createElement(p.folder != null || p.home ? 'button' : 'span');
    b.className = 'tb-crumb' + (p.cur ? ' cur' : '') + (p.outside ? ' tb-outside' : '');
    b.textContent = p.text;
    if (p.home) {
      // The vault's name goes to the empty page.
      b.setAttribute('type', 'button');
      b.dataset.home = '1';
      b.title = vaultName();
      if (p.cur) b.setAttribute('aria-current', 'page');
    } else if (p.folder != null) {
      b.setAttribute('type', 'button');
      b.dataset.folder = p.folder;
      b.title = p.folder ? `Open ${p.folder}` : `Open ${vaultName()}`;
      if (p.cur) b.setAttribute('aria-current', 'location');
    } else {
      b.title = p.path || p.text;
      if (p.cur) b.setAttribute('aria-current', 'page');
    }
    crumbs.appendChild(b);
  });
  // What is open can be closed, like a file in Explorer: the × beside its name goes back to the
  // empty page (the leave gate saves first, as for any navigation).
  if (r && !(r.type === 'view' && r.name === 'home')) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'tb-close';
    x.dataset.close = '1';
    x.title = 'Close';
    x.setAttribute('aria-label', 'Close');
    x.innerHTML = icon('close');
    crumbs.appendChild(x);
  }
  // The last segment is the one that matters: it stays in view when the path is long.
  crumbs.scrollLeft = crumbs.scrollWidth;
}

/* ------------------------------------------------------------------ build */

/**
 * Build the title bar into `node`: every control, the address bar and its command, and the
 * listeners that keep them in step with the route, the tabs and the page's save state.
 * @param {HTMLElement} node
 */
export function initTitlebar(node) {
  el = node;
  el.className = 'titlebar';
  el.innerHTML = `
    <button class="tb-fold" type="button">${icon('chevron')}</button>
    <div class="tb-mark" title="Ose" data-tauri-drag-region>${LOGO}</div>
    <div class="tb-nav">
      <button class="tb-nav-btn" data-nav="back" type="button">${icon('back')}</button>
      <button class="tb-nav-btn" data-nav="forward" type="button">${icon('forward')}</button>
    </div>
    <div class="tb-addr" data-tauri-drag-region>
      <nav class="tb-crumbs" aria-label="Location" data-tauri-drag-region></nav>
    </div>
    <span class="tb-space" data-tauri-drag-region></span>
    ${windowButtons()}`;
  el.setAttribute('data-tauri-drag-region', '');
  wireWindowButtons(el);

  // The sidebar's one control: the far-left corner of the title bar, at the sidebar's own x,
  // in the same place whether the sidebar is open or folded. Only the glyph turns, and the
  // title says which way it goes. It runs `app.sidebar`, the same command Ctrl+\ runs.
  // Every control below was written just above, so none of them is null.
  foldEl = /** @type {HTMLButtonElement} */ (el.querySelector('.tb-fold'));
  foldEl.addEventListener('click', () => commands.run('app.sidebar'));
  setSidebarShown(sidebarVisible());
  // The window hides the sidebar on its own under 640px (layout.js `fit`, L25), without
  // touching the preference, so the glyph follows what is on screen and not what is stored.
  bus.on('sidebar', setSidebarShown);

  addrEl = /** @type {HTMLElement} */ (el.querySelector('.tb-addr'));

  // A folder segment opens its folder.
  addrEl.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('.tb-close')) { void route.navigate(HOME); return; }
    const home = e.target instanceof Element ? e.target.closest('.tb-crumb[data-home]') : null;
    if (home) { if (!home.classList.contains('cur')) void route.navigate(HOME); return; }
    /** @type {HTMLElement|null} */
    const b = e.target instanceof Element ? e.target.closest('.tb-crumb[data-folder]') : null;
    if (b && !b.classList.contains('cur')) {
      const r = { type: 'folder', path: b.dataset.folder };
      if (e.ctrlKey || e.metaKey) void openInNewTab(r);
      else void route.navigate(r);
    }
  });
  addrEl.addEventListener('auxclick', (e) => {
    /** @type {HTMLElement|null} */
    const b = e.target instanceof Element ? e.target.closest('.tb-crumb[data-folder]') : null;
    if (!b || e.button !== 1) return;
    e.preventDefault();
    void openInNewTab({ type: 'folder', path: b.dataset.folder });
  });

  // Back and forward, where every browser and every file manager puts them (N45, L23): the
  // tab in front's own history (M23).
  navEls = {
    back: /** @type {HTMLButtonElement} */ (el.querySelector('[data-nav="back"]')),
    forward: /** @type {HTMLButtonElement} */ (el.querySelector('[data-nav="forward"]')),
  };
  const titleNav = () => {
    for (const name of ['back', 'forward']) {
      const b = navEls[name];
      const label = name === 'back' ? 'Back' : 'Forward';
      b.title = label;
      b.setAttribute('aria-label', label);
    }
  };
  for (const [name, b] of Object.entries(navEls)) {
    b.addEventListener('click', () => commands.run('app.' + name));
  }
  titleNav();
  updateNav();

  renderAddress(currentRoute());
  bus.on('route', (r) => { renderAddress(r); updateNav(); setState(null); });
  bus.on('tabs', () => updateNav());
  bus.on('route:repointed', (d) => { renderAddress(d ? d.current : currentRoute()); });
  // The names follow hideMdExt; a view's title can arrive after it was first drawn.
  bus.on('settings', () => renderAddress(currentRoute()));
  bus.on('booted', () => renderAddress(currentRoute()));
  // The mark follows the page in front only: the tabs carry every other page's (H8).
  const mine = (d) => {
    const r = currentRoute();
    return !!d && !!r && r.type === 'page' && clean(d.path) === clean(r.path);
  };
  bus.on('doc:dirty', (d) => { if (mine(d)) setDirty(d.dirty); });
  bus.on('doc:saved', (d) => { if (!d || mine(d)) setDirty(false); });
  bus.on('doc:state', (d) => { if (mine(d)) setState(d); });
}

/**
 * The page's save state beside the address (H8): the dot while it is dirty, the error mark when
 * it could not be written or changed on disk under it, with the editor's sentence as the
 * tooltip. `null` is a page just opened, which is clean until the editor says otherwise.
 */
function setState(d) {
  const dirtyEl = dot();
  if (!dirtyEl) return;
  const bad = !!d && (d.status === 'not-saved' || d.status === 'conflict' || (d.status === 'deleted' && d.dirty));
  dirtyEl.classList.toggle('err', bad);
  const what = bad ? (d.status === 'deleted' ? 'deleted on disk, not saved' : 'not saved') : 'unsaved changes';
  dirtyEl.title = bad && d.message ? `${what}: ${d.message}` : what;
  dirtyEl.setAttribute('aria-label', what);
  dirtyEl.hidden = !(bad || (d && d.dirty));
}

/** The fold button's two states: the glyph is CSS off `.no-sidebar`, the words are here. */
function setSidebarShown(shown) {
  if (!foldEl) return;
  const what = shown ? 'Hide sidebar' : 'Show sidebar';
  foldEl.title = what;
  foldEl.setAttribute('aria-label', what);
  foldEl.setAttribute('aria-expanded', shown ? 'true' : 'false');
}

/**
 * The unsaved dot, on or off, unless the error mark holds the place.
 * @param {boolean} v
 */
export function setDirty(v) {
  const dirtyEl = dot();
  if (!dirtyEl || dirtyEl.classList.contains('err')) return;
  dirtyEl.hidden = !v;
}

/** Disabled when there is nowhere to go in the tab in front: the buttons say what the chords knew. */
export function updateNav() {
  if (!navEls) return;
  navEls.back.disabled = !route.canBack();
  navEls.forward.disabled = !route.canForward();
}

/* ------------------------------------------------------------------ the window buttons */

const GLYPH = {
  min: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10"/></svg>',
  max: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M.5 .5h9v9h-9z"/></svg>',
  restore: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5h7v7h-7z M2.5 2.5v-2h7.5v7.5h-2"/></svg>',
  close: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0 0 10"/></svg>',
};

/** Minimise, maximise and close, drawn by the app: nothing on macOS, whose traffic lights stay. */
export function windowButtons() {
  if (document.documentElement.dataset.os === 'mac') return '';
  return `<div class="tb-win">
    <button type="button" class="tb-win-btn" data-win="min" aria-label="Minimise" title="Minimise">${GLYPH.min}</button>
    <button type="button" class="tb-win-btn" data-win="max" aria-label="Maximise" title="Maximise">${GLYPH.max}</button>
    <button type="button" class="tb-win-btn tb-win-close" data-win="close" aria-label="Close" title="Close">${GLYPH.close}</button>
  </div>`;
}

/** The buttons' clicks, and the maximise glyph following the window. @param {HTMLElement} root */
export function wireWindowButtons(root) {
  const box = root.querySelector('.tb-win');
  if (!box) return;
  const max = /** @type {HTMLElement} */ (box.querySelector('[data-win="max"]'));
  const paint = async () => {
    let on = false;
    try { on = await ose.window.isMaximized(); } catch { on = false; }
    max.innerHTML = on ? GLYPH.restore : GLYPH.max;
    const label = on ? 'Restore' : 'Maximise';
    max.title = label;
    max.setAttribute('aria-label', label);
  };
  box.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-win]') : null;
    if (!(b instanceof HTMLElement)) return;
    if (b.dataset.win === 'min') void ose.window.minimize();
    else if (b.dataset.win === 'max') void ose.window.toggleMaximize();
    else void ose.window.close();
  });
  void paint();
  Promise.resolve(ose.window.onResized(() => { void paint(); })).catch(() => {});
}
