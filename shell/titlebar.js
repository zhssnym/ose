// The window's title bar. The corner over the sidebar is the sidebar's: the vault's name and,
// at its right edge, the sidebar's toggle; folded, only the toggle is left. Then the tabs (tabs.js
// draws them; layout.js puts the strip here) as flat cells, and their +. The window has no system
// title bar: its empty parts move the window (`data-tauri-drag-region`; a double click
// maximises), and the window buttons are drawn here on Windows and Linux. On macOS the system's
// traffic lights sit over the row's left end, which leaves them room.

import { ose } from 'ose:core';
import { icon } from 'ose:ui';
import { sidebarVisible } from './layout.js';
import { clean, vaultName } from './paths.js';

const { bus, commands, route } = ose;
const currentRoute = () => route.current();

let el = null;
/** The save dot: drawn by the status bar (statusbar.js), kept current from here. */
const dot = () => /** @type {HTMLElement|null} */ (document.querySelector('.tb-dirty'));
let foldEl = null;

/* ------------------------------------------------------------------ build */

// The sidebar's toggle: a window with its left panel, the panel filled while the sidebar shows.
const SIDE_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true">'
  + '<rect class="tb-side-fill" x="2.25" y="2.75" width="3.75" height="10.5"/>'
  + '<rect x="2.25" y="2.75" width="11.5" height="10.5"/><path d="M6 2.75v10.5"/></svg>';

/**
 * Build the title bar into `node`: every control, the address bar and its command, and the
 * listeners that keep them in step with the route, the tabs and the page's save state.
 * @param {HTMLElement} node
 */
export function initTitlebar(node) {
  el = node;
  el.className = 'titlebar';
  el.innerHTML = `
    <div class="tb-corner" data-tauri-drag-region>
      <span class="tb-vault" data-tauri-drag-region></span>
      <button class="tb-fold" type="button">${SIDE_GLYPH}</button>
    </div>
    <span class="tb-tabs-slot"></span>
    <button class="tb-tab-add" type="button" title="New tab" aria-label="New tab">${icon('plus')}</button>
    <span class="tb-space" data-tauri-drag-region></span>
    ${windowButtons()}`;
  el.setAttribute('data-tauri-drag-region', '');
  wireWindowButtons(el);

  // The corner over the sidebar is the sidebar's: the vault's name, and at its right edge the
  // sidebar's toggle, which runs `app.sidebar` like Ctrl+\. Folded, the toggle is all that is
  // left of it, before the tabs.
  // Every control below was written just above, so none of them is null.
  foldEl = /** @type {HTMLButtonElement} */ (el.querySelector('.tb-fold'));
  foldEl.addEventListener('click', () => commands.run('app.sidebar'));
  setSidebarShown(sidebarVisible());
  // The window hides the sidebar on its own under 640px (layout.js `fit`, L25), without
  // touching the preference, so the glyph follows what is on screen and not what is stored.
  bus.on('sidebar', setSidebarShown);

  const addEl = /** @type {HTMLButtonElement} */ (el.querySelector('.tb-tab-add'));
  addEl.addEventListener('click', () => commands.run('tab.new'));

  const vaultEl = /** @type {HTMLElement} */ (el.querySelector('.tb-vault'));
  const paintVault = () => { vaultEl.textContent = vaultName(); vaultEl.title = (ose.vault && ose.vault.root) || vaultName(); };
  paintVault();
  bus.on('booted', paintVault);

  bus.on('route', () => { setState(null); });
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
  foldEl.classList.toggle('on', !!shown);
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
