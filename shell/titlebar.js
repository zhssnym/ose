// The window's title bar, VS Code's way: back and forward and the command centre in the middle,
// the sidebar's toggle at the right, then the window buttons. Nothing else. The window has no
// system title bar: its empty parts move the window (`data-tauri-drag-region`; a double click
// maximises), and the window buttons are drawn here on Windows and Linux. On macOS the system's
// traffic lights sit over the row's left end, which leaves them room.
//
// The command centre is one box that says where you are — the vault's name, each folder, then
// the file — and pressing it opens Go to file (`app.quickopen`), as VS Code's opens quick open.
// A long place gives way from the left: the file's name is the part that stays. A page outside
// the vault reads "Outside the vault", its folder, then its name.

import { ose } from 'ose:core';
import { esc, icon } from 'ose:ui';
import { LOGO } from './logo.js';
import { sidebarVisible } from './layout.js';
import { clean, baseName, dirName, titleOf, vaultName, isOutside, outsideLabel } from './paths.js';

const { bus, commands, route } = ose;
const currentRoute = () => route.current();

let el = null;
let cmdEl = null;
let placeEl = null;
/** The save dot: drawn by the status bar (statusbar.js), kept current from here. */
const dot = () => /** @type {HTMLElement|null} */ (document.querySelector('.tb-dirty'));
let sideEl = null;
let vaultEl = null;
let navEls = null;

/* ------------------------------------------------------------------ the place, at rest */

/** A file's name as the chrome shows it (W8): whole, `.md` stripped only when hideMdExt is on. */
const display = (path) => titleOf(path) || baseName(path);

/** The words of a route, in order: the vault's name, each folder, then the file or the view. */
function partsOf(r) {
  /** @type {string[]} */
  const parts = [vaultName()];
  if (!r) return parts;
  if (r.type === 'view') {
    const v = ose.views.get(r.name);
    parts.push((v && v.title) || r.name);
    return parts;
  }
  if (r.type === 'page' && isOutside(r.path)) {
    // A file outside the vault (X7): its folder is one segment, the whole absolute path.
    const dir = outsideLabel(dirName(clean(r.path)));
    parts[0] = 'Outside the vault';
    if (dir) parts.push(dir);
    parts.push(display(r.path));
    return parts;
  }
  const segs = clean(r.path).split('/').filter(Boolean);
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    parts.push(last && r.type === 'page' ? display(segs.join('/')) : s);
  });
  return parts;
}

function renderPlace(r) {
  if (!placeEl || !cmdEl) return;
  const parts = partsOf(r);
  placeEl.innerHTML = parts
    .map((p, i) => (i ? '<span class="tb-cmd-sep" aria-hidden="true">›</span>' : '') + `<span class="tb-cmd-part">${esc(p)}</span>`)
    .join('');
  const where = parts.join(' › ');
  const key = ose.keys.shortcutFor('app.quickopen');
  cmdEl.title = `${where}\nGo to file${key ? ` (${key})` : ''}`;
  cmdEl.setAttribute('aria-label', `${where}. Go to file`);
}

/* ------------------------------------------------------------------ build */

// The sidebar's fold: «, or » to bring it back. It shows only while the pointer is over the
// sidebar or its corner (places.css): at rest there is no icon at all.
const FOLD_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.5 4.5 5 8l3.5 3.5M12.5 4.5 9 8l3.5 3.5"/></svg>';

/**
 * Build the title bar into `node`: back and forward, the command centre, the sidebar's toggle
 * and the window buttons, and the listeners that keep them in step with the route, the tabs,
 * the sidebar and the page's save state.
 * @param {HTMLElement} node
 */
export function initTitlebar(node) {
  el = node;
  el.className = 'titlebar tb-main';
  el.innerHTML = `
    <div class="tb-brand" data-tauri-drag-region>
      <span class="tb-mark" data-tauri-drag-region>${LOGO}</span>
      <span class="tb-vault" data-tauri-drag-region></span>
      <button class="tb-nav-btn tb-fold" type="button">${FOLD_GLYPH}</button>
    </div>
    <span class="tb-lead" data-tauri-drag-region></span>
    <div class="tb-center" data-tauri-drag-region>
      <div class="tb-nav">
        <button class="tb-nav-btn" data-nav="back" type="button">${icon('back')}</button>
        <button class="tb-nav-btn" data-nav="forward" type="button">${icon('forward')}</button>
      </div>
      <button class="tb-cmd" type="button">
        <span class="tb-cmd-icon" aria-hidden="true">${icon('search')}</span>
        <span class="tb-cmd-place" dir="rtl"><bdi class="tb-cmd-text" dir="ltr"></bdi></span>
      </button>
    </div>
    <div class="tb-trail" data-tauri-drag-region>
      ${windowButtons()}
    </div>`;
  el.setAttribute('data-tauri-drag-region', '');
  wireWindowButtons(el);

  // Every control below was written just above, so none of them is null.
  cmdEl = /** @type {HTMLButtonElement} */ (el.querySelector('.tb-cmd'));
  placeEl = /** @type {HTMLElement} */ (el.querySelector('.tb-cmd-text'));
  cmdEl.addEventListener('click', () => commands.run('app.quickopen'));

  // The sidebar's toggle runs `app.sidebar`, the same command Ctrl+\ runs. The window hides the
  // sidebar on its own under 640px (layout.js `fit`, L25), without touching the preference, so
  // the glyph follows what is on screen and not what is stored.
  sideEl = /** @type {HTMLButtonElement} */ (el.querySelector('.tb-fold'));
  vaultEl = /** @type {HTMLElement} */ (el.querySelector('.tb-vault'));
  paintVault();
  sideEl.addEventListener('click', () => commands.run('app.sidebar'));
  setSidebarShown(sidebarVisible());
  bus.on('sidebar', setSidebarShown);

  // Back and forward, immediately left of the command centre: the tab in front's own history (M23).
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

  renderPlace(currentRoute());
  bus.on('route', (r) => { renderPlace(r); updateNav(); setState(null); });
  bus.on('tabs', () => updateNav());
  bus.on('route:repointed', (d) => { renderPlace(d ? d.current : currentRoute()); });
  // The names follow hideMdExt; a view's title can arrive after it was first drawn, and the
  // chords come from keys.json, which is read after the bar is built.
  bus.on('settings', () => renderPlace(currentRoute()));
  bus.on('booted', () => { renderPlace(currentRoute()); setSidebarShown(sidebarVisible()); paintVault(); });
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
 * The page's save state (H8): the dot while it is dirty, the error mark when it could not be
 * written or changed on disk under it, with the editor's sentence as the tooltip. `null` is a
 * page just opened, which is clean until the editor says otherwise.
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

/** The vault's name in the corner over the sidebar. */
function paintVault() {
  if (!vaultEl) return;
  const name = vaultName();
  vaultEl.textContent = name;
  vaultEl.title = (ose.vault && ose.vault.root) || name;
}

/** The fold's two states: « hides the sidebar, » brings it back (the glyph turns in CSS). */
function setSidebarShown(shown) {
  if (!sideEl) return;
  const what = shown ? 'Hide sidebar' : 'Show sidebar';
  sideEl.classList.toggle('on', !!shown);
  sideEl.title = what;
  sideEl.setAttribute('aria-label', what);
  sideEl.setAttribute('aria-pressed', shown ? 'true' : 'false');
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
