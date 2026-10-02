// The window's title bar. The corner over the sidebar is the sidebar's: the mark and,
// at its right edge, the sidebar's toggle; folded, only the toggle is left. Then the tabs (tabs.js
// draws them; layout.js puts the strip here) as flat cells, and their +. The window has no system
// title bar: its empty parts move the window (`data-tauri-drag-region`; a double click
// maximises), and the window buttons are drawn here on Windows and Linux. On macOS the system's
// traffic lights sit over the row's left end, which leaves them room.

import { ose } from '../core/core.ts';
import { icon } from '../ui/index.ts';
import { sidebarVisible } from './layout.ts';
import { LOGO } from './logo.ts';

const { bus, commands } = ose;

let el: HTMLElement | null = null;
let foldEl: HTMLButtonElement | null = null;

/* ------------------------------------------------------------------ build */

// The sidebar's toggle: a window with its left panel, the panel filled while the sidebar shows.
const SIDE_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true">'
  + '<rect class="tb-side-fill" x="2.25" y="2.75" width="3.75" height="10.5"/>'
  + '<rect x="2.25" y="2.75" width="11.5" height="10.5"/><path d="M6 2.75v10.5"/></svg>';

/**
 * Build the title bar into `node`: every control, the address bar and its command, and the
 * listeners that keep them in step with the sidebar.
 */
export function initTitlebar(node: HTMLElement) {
  el = node;
  el.className = 'titlebar';
  el.innerHTML = `
    <div class="tb-corner" data-tauri-drag-region>
      <span class="tb-mark" title="Ose" data-tauri-drag-region>${LOGO}</span>
      <span class="tb-space" data-tauri-drag-region></span>
      <button class="tb-fold" type="button">${SIDE_GLYPH}</button>
    </div>
    <span class="tb-tabs-slot"></span>
    <button class="tb-tab-add" type="button" title="New tab" aria-label="New tab">${icon('plus')}</button>
    <span class="tb-space" data-tauri-drag-region></span>
    ${windowButtons()}`;
  el.setAttribute('data-tauri-drag-region', '');
  wireWindowButtons(el);

  // The corner over the sidebar is the sidebar's: the mark, and at its right edge the
  // sidebar's toggle, which runs `app.sidebar` like Ctrl+\. Folded, the toggle is all that is
  // left of it, before the tabs.
  // Every control below was written just above, so none of them is null.
  foldEl = el.querySelector('.tb-fold') as HTMLButtonElement;
  foldEl.addEventListener('click', () => commands.run('app.sidebar'));
  setSidebarShown(sidebarVisible());
  // The window hides the sidebar on its own under 640px (layout.js `fit`, L25), without
  // touching the preference, so the glyph follows what is on screen and not what is stored.
  bus.on('sidebar', setSidebarShown);

  const addEl = el.querySelector('.tb-tab-add') as HTMLButtonElement;
  addEl.addEventListener('click', () => commands.run('tab.new'));


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

/** The buttons' clicks, and the maximise glyph following the window. */
export function wireWindowButtons(root: HTMLElement) {
  const box = root.querySelector('.tb-win');
  if (!box) return;
  const max = box.querySelector('[data-win="max"]') as HTMLElement;
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
