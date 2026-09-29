// The shell's frame: the toolbar, the sidebar-and-page body, and everything about the window
// itself — how the columns give way, the resizer, the drops and the browser keys the web view
// would otherwise act on. The window's own frame (its title bar, buttons and resize edges) is
// the platform's (X9): the host opens a decorated window, at least 480 by 360.
//
// This is the shell's own layout. The kernel knows none of it: `ose.init({ page })` is handed
// the element this file builds, and from there the router draws into it.

import { ose } from 'ose:kernel';
import { icon } from 'ose:ui';
import { onVaultChangeRequested } from './host.js';
import { initTitlebar } from './titlebar.js';
import { initSidebar } from './sidebar.js';
import { initStatusbar } from './statusbar.js';
import { vaultLost, vaultFound, vaultRequested } from './vault.js';

const { bus, store, commands } = ose;

const MIN_MAIN = 340;
const S_MIN = 200, S_DEFAULT = 260;
// L5, L25: the sidebar can be dragged out to this share of the window and no further, and
// under NARROW it steps out of the way altogether. A deep tree with long names wants the room;
// the page column keeps MIN_MAIN whatever the drag says, and the preference is not touched
// when the window is what gives way, only what is drawn.
const S_SHARE = 0.6;
const NARROW = 640;

// The side panel (search, M25): to the right of the page column, off until something opens it.
const P_MIN = 240, P_DEFAULT = 340;
const P_SHARE = 0.5;

// Per machine, per vault (docs/KERNEL.md `ose.local`, W5): how wide the sidebar is and whether
// it is open is this screen's business, not something the vault carries to the next machine.
// `sidebar.js` writes `expanded` into the same slot. Never the vault's `.ose/state.json`: that
// file is synced, and one screen's layout is not the vault's (W5).
let sidebarState = null;
let panelState = null;

let shell = null;
let mainEl = null;
let wantS = S_DEFAULT;
let wantP = P_DEFAULT;
let autoHidden = false;
// What the last `fit` put on screen, so the `sidebar` event is emitted on a change and not on
// every resize frame.
let shown = null;
// The user overruled the auto-hide at this width (QA-5 finding 3). Without it `fit` re-armed
// `autoHidden` on the very call the toggle made to clear it, so under NARROW the sidebar could
// not be opened at all: Ctrl+\ did nothing, said nothing, and neither chevron was on screen —
// the tree was unreachable. The latch is spent the moment the window is wide again, so the
// auto-hide still happens the next time the window is narrowed.
let overruled = false;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const patchSidebar = (patch) => sidebarState && sidebarState.set({ ...(sidebarState.get() || {}), ...patch });
const patchPanel = (patch) => panelState && panelState.set({ ...(panelState.get() || {}), ...patch });
/** The widest the sidebar may be dragged in this window (L5). */
const sMax = () => Math.max(S_MIN, Math.round(window.innerWidth * S_SHARE));
/** The widest the side panel may be dragged in this window. */
const pMax = () => Math.max(P_MIN, Math.round(window.innerWidth * P_SHARE));

/* ------------------------------------------------------------------ layout */

/**
 * The sidebar gives way before the page column does: the page keeps MIN_MAIN on a narrow
 * window, the sidebar never exceeds S_SHARE of it, and under NARROW it hides itself and comes
 * back when the window is wide again (L25). `sidebar.open` — the user's preference — is never
 * written by any of this; `autoHidden` is what the window did, and toggling the sidebar by
 * hand clears it, so an explicit Ctrl+\ still opens it on a small window — which is what
 * `overruled` is for: the toggle clears `autoHidden`, and without the latch this function put
 * it straight back on the same call.
 */
function fit() {
  if (!shell) return;
  const avail = window.innerWidth;
  const narrow = avail < NARROW;
  const wanted = !!store.get('sidebar.open');
  // Wide again: the window's own decision and the user's overrule of it are both spent, so
  // narrowing the window a second time hides the sidebar a second time.
  if (!narrow) { autoHidden = false; overruled = false; }
  else if (wanted && !autoHidden && !overruled) autoHidden = true;

  const sOpen = wanted && !autoHidden;
  shell.classList.toggle('no-sidebar', !sOpen);
  // The title bar's fold button says which way it goes, and the window hides the sidebar on
  // its own without touching the preference, so what is on screen is announced rather than
  // read off `sidebar.open` (shell/titlebar.js).
  if (sOpen !== shown) { shown = sOpen; bus.emit('sidebar', sOpen); }

  // The side panel takes its share first and gives way the same way: never under P_MIN, and
  // never so wide the page column drops under MIN_MAIN while the sidebar still has room to give.
  const pOpen = !!panelEl && !panelEl.hidden;
  let p = pOpen ? Math.min(wantP, pMax()) : 0;
  let s = sOpen ? Math.min(wantS, sMax()) : 0;
  let over = s + p + MIN_MAIN - avail;
  if (over > 0 && s > 0) { const cut = clamp(over, 0, Math.max(0, s - S_MIN)); s -= cut; over -= cut; }
  if (over > 0 && p > 0) { const cut = clamp(over, 0, Math.max(0, p - P_MIN)); p -= cut; }
  shell.style.setProperty('--sidebar-w', (sOpen ? s : wantS) + 'px');
  shell.style.setProperty('--panel-w', (pOpen ? p : wantP) + 'px');
  measureMain();
}

// A resizer is a separator control (D6): focusable, with its width spoken as a value, and the
// arrows move it. 8px a step, 32px with Shift, Home/End to the limits, Enter back to the default.
const RS_STEP = 8, RS_BIG = 32;

/**
 * @param {HTMLElement} handle
 * @param {{get: () => number, set: (v: number) => void, min: number, max: number | (() => number),
 *   invert?: boolean, done?: (v: number) => void}} opts
 */
function makeResizer(handle, { get, set, min, max, invert, done }) {
  // `max` may be a function: the sidebar's ceiling is a share of the window (L5), so it moves
  // when the window does and is asked for at every step.
  const hi = () => (typeof max === 'function' ? max() : max);
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-valuemin', String(min));
  handle.setAttribute('aria-valuemax', String(hi()));
  handle.tabIndex = 0;
  const apply = (v) => {
    const top = hi();
    handle.setAttribute('aria-valuemax', String(top));
    set(clamp(v, min, top));
    handle.setAttribute('aria-valuenow', String(get()));
  };
  apply(get());

  handle.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const step = e.shiftKey ? RS_BIG : RS_STEP;
    // `invert` means the handle sits on the panel's left edge, where Right shrinks it.
    const sign = invert ? -1 : 1;
    if (e.key === 'ArrowRight') apply(get() + sign * step);
    else if (e.key === 'ArrowLeft') apply(get() - sign * step);
    else if (e.key === 'Home') apply(min);
    else if (e.key === 'End') apply(hi());
    else if (e.key === 'Enter' && handle.dataset.reset) apply(+handle.dataset.reset);
    else return;
    e.preventDefault();
    done && done(get());
  });

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('on');
    document.body.classList.add('resizing');
    const x0 = e.clientX, w0 = get();
    const move = (ev) => apply(w0 + (invert ? x0 - ev.clientX : ev.clientX - x0));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('on');
      document.body.classList.remove('resizing');
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      done && done(get());
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => { apply(handle.dataset.reset ? +handle.dataset.reset : get()); done && done(get()); });
}

/**
 * Whether the sidebar is actually on screen: the user's preference *and* the window being wide
 * enough (L25). The toggle command asks here rather than flipping the preference blind, so the
 * chevron in the title bar opens a sidebar the narrow window had hidden with one press instead
 * of two — the preference itself is still only ever written by the toggle.
 */
export const sidebarVisible = () => !!store.get('sidebar.open') && !autoHidden;

/**
 * The one way the sidebar is opened or closed on purpose: `app.sidebar`, either chevron,
 * `app.focus-sidebar`, a folder revealed in the tree. It clears the window's own auto-hide
 * before it writes, and it does the work itself rather than leaning on the `sidebar.open`
 * watcher — `store.set` returns early when the value has not changed (src/kernel/registry.js),
 * and the whole broken state of QA-5 finding 3 was exactly that: preference open, window
 * hiding it, a toggle writing `true` over `true`, no watcher, nothing on screen, nothing said.
 * `fit` and `patchSidebar` are idempotent, so the watcher running as well costs nothing.
 */
export function setSidebarOpen(open) {
  autoHidden = false;
  overruled = true;
  store.set('sidebar.open', !!open);
  fit();
  patchSidebar({ open: !!open });
}

/** `app.sidebar` (Ctrl+\): what is on screen, flipped — not the preference, flipped. */
export function toggleSidebar() { setSidebarOpen(!sidebarVisible()); }

/* -------------------------------------------------------------- page column */

// The page column is a token, not a hard-coded width, so views and the editor follow it for
// free. On a wide main area (a maximised 1920 window) the side padding scales, which is the
// difference between a column hugging the sidebar and one that sits in the page. The column
// itself does not grow: DESIGN.md sets it at 720px and it read about 115 characters a line at
// 800, which is past what a printed page sets (R27).
const WIDE_MAIN = 1400;

let wide = null;

/** Called by the ResizeObserver, and by fit() so a hidden window (no frames, no observer
 *  callbacks) still ends up with the right tokens after a resize or a panel toggle. */
function measureMain(w) {
  if (!shell || !mainEl) return;
  const width = typeof w === 'number' ? w : mainEl.getBoundingClientRect().width;
  const next = width > WIDE_MAIN;
  if (next === wide) return;
  wide = next;
  if (next) {
    // rem, like the token it overrides, so a wide window zooms with everything else.
    shell.style.setProperty('--page-pad-x', 'max(3rem, 6vw)');
  } else {
    shell.style.removeProperty('--page-pad-x');
  }
}

function watchMainWidth(el) {
  measureMain();
  if (typeof ResizeObserver !== 'function') return;
  const ro = new ResizeObserver((entries) => {
    const e = /** @type {ResizeObserverEntry} */ (entries[entries.length - 1]);
    measureMain(e.contentRect ? e.contentRect.width : undefined);
  });
  ro.observe(el);
}

/**
 * Where typing should go once something is on the page column: the editor body, else the
 * title, else a view's root, else the first row on Home (B3). The router
 * does this itself after every navigation; this is the other half — Esc out of the tree, and
 * the `app.focus-page` command — and it is the shell's, because the page column is its element.
 */
export function focusPage() {
  if (!mainEl) return false;
  const pick = mainEl.querySelector('.ProseMirror')
    // A code file is a page too, and `.cm-content` is its body the way `.ProseMirror` is prose's.
    || mainEl.querySelector('.cm-content')
    || mainEl.querySelector('.page-title')
    || mainEl.querySelector('.view-root')
    || mainEl.querySelector('.home-row')
    || mainEl.querySelector('.miss .btn');
  if (!pick) return false;
  if (!pick.isContentEditable && !pick.hasAttribute('tabindex') && pick.tagName !== 'BUTTON') pick.tabIndex = -1;
  pick.focus({ preventScroll: true });
  return document.activeElement === pick;
}

/* --------------------------------------------------------------- file drops */

// A file dropped anywhere but a real target would otherwise navigate the whole window to it,
// which in the host means the app is gone. Anything already handled (the tree's folder rows,
// the folder view, the editor's own drop) has called preventDefault by the time this runs;
// what is left is ignored (docs/SHELL.md "Drag in and out").
const EDITABLE = '[contenteditable="true"], .ProseMirror, .milkdown, input, textarea';

// The editor accepts dropped images through Milkdown's own uploader, which relies on the
// native drop behaviour of a contenteditable; leave anything editable alone.
const editableTarget = (e) => !!(e.target && e.target.closest && e.target.closest(EDITABLE));

function guardWindowDrops() {
  window.addEventListener('dragover', (e) => {
    if (e.defaultPrevented || editableTarget(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  });
  window.addEventListener('drop', (e) => {
    if (e.defaultPrevented || editableTarget(e)) return;
    e.preventDefault();
  });
}

/* ------------------------------------------------------------- the vault itself */

/**
 * The folder the whole window is open on can stop existing (S29): renamed in Explorer,
 * unmounted, deleted. The watcher says so once — a `lost` notice — instead of failing every
 * call with a toast of its own, and says so again when it comes back. The other half is a
 * second launch naming a different folder: the host only asks now, and the switch is the same
 * one Change vault… makes, after the open page has been saved (C5, shell/vault.js).
 */
function watchVault() {
  ose.watch((d) => {
    if (!d || typeof d.lost !== 'boolean') return;
    if (d.lost) vaultLost();
    else vaultFound();
  });
  onVaultChangeRequested(vaultRequested);
}

/* --------------------------------------------------- the browser underneath */

// S27. Ose runs in Chrome, and the browser's own accelerators are live in it: F5 and Ctrl+R
// reload the app — which throws away an unsaved buffer and every scrap of state the page
// holds — Ctrl+U shows the source, F7 turns on caret browsing. The page refuses them itself;
// Chromium lets a page do that for all of these (they are not reserved shortcuts). A reload
// that gets past this (the toolbar button) still leaves through `beforeunload` and the drafts.
//
// Ctrl+O is deliberately not here: it is quick open, which already takes the event in the
// capture phase, so the web view's Open-file dialog never gets a chance either way. A key this
// guard swallows must be one nothing in the app wants.
//
// Ctrl+R and Ctrl+Shift+R are in the set now (D8, C5). Ctrl+R used to be the app's own reload,
// and a reload typed a moment after a keystroke lost that keystroke. `app.reload` ("Reload
// window") stays in the palette with no chord, and it leaves through the save gate. The
// keyboard's own Back and Forward keys are the web view's history, which is not the app's.
const BROWSER_KEYS = new Set([
  'f5', 'ctrl+f5', 'shift+f5', 'ctrl+shift+f5', 'ctrl+r', 'ctrl+shift+r', 'ctrl+u', 'f7',
  'browserback', 'browserforward', 'browserrefresh',
]);

function guardBrowserKeys() {
  window.addEventListener('keydown', (e) => {
    const k = String(e.key || '').toLowerCase();
    if (!k) return;
    const combo = (e.ctrlKey || e.metaKey ? 'ctrl+' : '') + (e.shiftKey ? 'shift+' : '') + k;
    if (!BROWSER_KEYS.has(combo) && !BROWSER_KEYS.has(k)) return;
    // F5 with no modifier is in the set by its bare name; anything with Alt is not ours.
    if (e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

// The web view's own context menu carries Reload and Back, either of which loses the buffer
// (S11/S27). Anything that has its own menu — the tree, the editor — has called preventDefault
// by the time this runs; what is left is the browser's, and it does not belong in the app.
//
// Shift+right-click is the one way through, and it is deliberate: no browser tells a page
// which word is underlined, so the web view's own menu is the only place a spelling suggestion
// can come from. It is the same escape hatch Chromium itself uses for a page that overrides
// the menu.
function guardContextMenu() {
  window.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented || e.shiftKey) return;
    e.preventDefault();
  });
}

/* ------------------------------------------------------------------ reload */

/**
 * Reload window (`app.reload`). `ose.reload()` leaves through the kernel's gate first (C5): the
 * open page is saved and the state flushed, and a page that cannot be saved keeps the window,
 * with the reason on screen. Nothing here saves on its own.
 */
async function reloadApp() {
  try { await ose.reload(); } catch (e) { console.error('[shell] reload', e); }
}

/* -------------------------------------------------------------- the side panel */

// The side panel (M25): one resizable column to the right of the page column, for a surface
// that stays open while pages are opened from it — search first. It holds one thing at a time,
// by id; opening another replaces it. The panel draws its own head (the title and a close
// button) and hands the body to the caller's `mount`, which answers `{ unmount?, focus? }`.
let panelEl = null;
let panelRs = null;
let panelTitle = null;
let panelBody = null;
// What is in it: `{ id, handle }`, or null while it is closed.
let panelNow = null;

function unmountPanel() {
  const now = panelNow;
  panelNow = null;
  if (now && now.handle && typeof now.handle.unmount === 'function') {
    try { now.handle.unmount(); } catch (e) { console.error('[shell] panel unmount', e); }
  }
  if (panelBody) panelBody.textContent = '';
}

function showPanel(open) {
  if (!panelEl) return;
  panelEl.hidden = !open;
  if (panelRs) panelRs.hidden = !open;
  if (shell) shell.classList.toggle('has-panel', open);
  fit();
}

/**
 * The side panel. `open` replaces whatever is in it; `close(id)` closes it only while `id` is
 * what it holds (no id: whatever it holds); `toggle` answers whether it is open afterwards.
 */
export const panel = {
  /**
   * Put `mount`'s surface in the panel, replacing what was there, and open it.
   * @param {string} id
   * @param {(el: HTMLElement) => ({unmount?: Function, focus?: Function}|void)} mount
   * @param {{title?: string}} [opts]
   */
  open(id, mount, { title } = {}) {
    if (!panelEl || !id || typeof mount !== 'function') return;
    unmountPanel();
    panelTitle.textContent = title || '';
    panelEl.setAttribute('aria-label', title || id);
    panelEl.dataset.id = id;
    showPanel(true);
    let handle = null;
    try { handle = mount(panelBody) || null; } catch (e) { console.error('[shell] panel mount', e); }
    panelNow = { id, handle };
    patchPanel({ open: true, id });
    panel.focus();
  },
  /**
   * Close the panel, if `id` is what it holds (no id: whatever it holds).
   * @param {string} [id]
   */
  close(id) {
    if (!panelNow || (id && panelNow.id !== id)) return;
    const had = !!panelEl && panelEl.contains(document.activeElement);
    unmountPanel();
    if (panelEl) delete panelEl.dataset.id;
    showPanel(false);
    patchPanel({ open: false });
    // The keyboard does not fall to <body> with the panel: it goes back to the page.
    if (had) focusPage();
  },
  /**
   * Open it with `mount` unless `id` is already open, in which case close it.
   * @param {string} id
   * @param {(el: HTMLElement) => ({unmount?: Function, focus?: Function}|void)} mount
   * @param {{title?: string}} [opts]
   * @returns {boolean} whether the panel is open now
   */
  toggle(id, mount, opts) {
    if (panel.isOpen(id)) { panel.close(id); return false; }
    panel.open(id, mount, opts);
    return true;
  },
  /**
   * Whether the panel is open (holding `id`, when one is given).
   * @param {string} [id]
   * @returns {boolean}
   */
  isOpen(id) { return !!panelNow && (!id || panelNow.id === id); },
  /** Put the keyboard in the panel: the mount's own `focus`, else its first control. */
  focus() {
    if (!panelNow || !panelEl) return;
    const h = panelNow.handle;
    if (h && typeof h.focus === 'function') {
      try { h.focus(); return; } catch (e) { console.error('[shell] panel focus', e); }
    }
    const first = panelBody.querySelector('input, textarea, button, [tabindex]:not([tabindex="-1"])');
    (first || panelBody).focus({ preventScroll: true });
  },
};

function buildPanel() {
  panelEl = shell.querySelector('.sidepanel');
  panelRs = shell.querySelector('.rs-panel');
  panelTitle = panelEl.querySelector('.sp-title');
  panelBody = panelEl.querySelector('.sp-body');
  panelBody.tabIndex = -1;
  const x = panelEl.querySelector('.sp-close');
  x.innerHTML = icon('close');
  x.addEventListener('click', () => panel.close());
  makeResizer(panelRs, {
    min: P_MIN, max: pMax, invert: true,
    get: () => wantP,
    set: (v) => { wantP = v; fit(); },
    done: (v) => patchPanel({ width: v }),
  });
}

/* ------------------------------------------------------------------ build */

/**
 * Build the shell into `rootEl` and answer its parts. Nothing is navigated to yet: `boot.js`
 * calls this, then hands `els.main` to `ose.init`.
 * @param {HTMLElement} rootEl
 * @returns {{titlebar: HTMLElement, sidebar: HTMLElement, tabs: HTMLElement, main: HTMLElement, statusbar: HTMLElement, panel: HTMLElement}}
 */
export function mountShell(rootEl) {
  sidebarState = ose.local('sidebar');
  panelState = ose.local('panel');
  const saved = sidebarState.get() || {};
  wantS = clamp(+saved.width || S_DEFAULT, S_MIN, sMax());
  const savedPanel = panelState.get() || {};
  wantP = clamp(+savedPanel.width || P_DEFAULT, P_MIN, pMax());

  rootEl.textContent = '';
  shell = document.createElement('div');
  shell.className = 'shell';
  shell.innerHTML = `
    <header class="titlebar"></header>
    <div class="body">
      <aside class="sidebar"></aside>
      <div class="rs rs-sidebar" data-reset="${S_DEFAULT}" title="Drag to resize" aria-label="Sidebar width"></div>
      <div class="maincol">
        <div class="tabs"></div>
        <main class="main"></main>
      </div>
      <div class="rs rs-panel" data-reset="${P_DEFAULT}" title="Drag to resize" aria-label="Side panel width" hidden></div>
      <aside class="sidepanel" hidden>
        <div class="panel-head sp-head"><span class="grow sp-title"></span><button type="button" class="sp-close" title="Close panel" aria-label="Close panel"></button></div>
        <div class="sp-body"></div>
      </aside>
    </div>
    <footer class="statusbar"></footer>`;
  rootEl.appendChild(shell);

  // The tab strip sits above the page column and outside it: the router clears `.main` on
  // every navigation, so anything that has to survive one lives in the column around it.
  // all of them are in the markup just written
  const part = (sel) => /** @type {HTMLElement} */ (shell.querySelector(sel));
  const els = {
    titlebar: part('.titlebar'),
    sidebar: part('.sidebar'),
    tabs: part('.tabs'),
    main: part('.main'),
    statusbar: part('.statusbar'),
    panel: part('.sidepanel'),
  };
  mainEl = els.main;
  buildPanel();

  // The sidebar tracks the store; its width is a CSS variable so nothing re-lays-out in JS.
  store.set('sidebar.open', saved.open !== false);
  store.watch('sidebar.open', (v) => {
    // An explicit toggle is the user overruling the window's own decision (L25), and it holds
    // until the window is wide again — otherwise `fit` below re-hides it on this very call.
    autoHidden = false;
    overruled = true;
    fit();
    patchSidebar({ open: !!v });
  });
  fit();

  makeResizer(part('.rs-sidebar'), {
    min: S_MIN, max: sMax,
    get: () => wantS,
    set: (v) => { wantS = v; fit(); },
    done: (v) => patchSidebar({ width: v }),
  });

  initTitlebar(els.titlebar);
  initSidebar(els.sidebar);
  initStatusbar(els.statusbar);
  guardWindowDrops();
  guardBrowserKeys();
  guardContextMenu();
  watchVault();

  commands.register({ id: 'app.back', title: 'Back', group: 'navigate', when: () => ose.route.canBack(), run: () => ose.route.back() });
  commands.register({ id: 'app.forward', title: 'Forward', group: 'navigate', when: () => ose.route.canForward(), run: () => ose.route.forward() });
  // The other half of `app.focus-sidebar` (sidebar.js, Ctrl+Shift+E). No chord: Esc from the
  // tree does it, and the palette has it for everywhere else (D2).
  commands.register({ id: 'app.focus-page', title: 'Focus page', group: 'app', hint: 'the editor, or the view', run: () => { focusPage(); } });
  // The window again, once the open page has been saved. No chord: Ctrl+R is gone (D8), so a
  // reload is never one slip of the fingers away from a keystroke; the palette has it.
  commands.register({
    id: 'app.reload', title: 'Reload window', group: 'app', hint: 'saves the page first',
    run: () => reloadApp(),
  });
  // L5: the page column as wide as the window, or back to the readable measure. The same
  // setting Settings › Appearance shows as Full width, flipped in one command.
  commands.register({
    id: 'app.full-width', title: 'Toggle full width', group: 'app',
    hint: 'the page column as wide as the window',
    run: () => { ose.settings.set({ readableWidth: ose.settings.get().readableWidth === false }); },
  });
  commands.register({
    id: 'app.close-panel', title: 'Close side panel', group: 'app',
    when: () => panel.isOpen(),
    run: () => panel.close(),
  });

  watchMainWidth(els.main);

  window.addEventListener('resize', fit);
  window.addEventListener('beforeunload', () => {
    try { sidebarState.flush?.(); panelState.flush?.(); } catch (e) { console.warn('[shell] flush', e); }
  });
  fit();

  // Anything registered after the shell may change what is on screen; measure once more.
  bus.on('booted', () => { fit(); });

  return els;
}
