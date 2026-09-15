// The shell's frame: the window chrome, the sidebar-and-page body, and everything about the
// window itself — how the columns give way, the resizer, the frameless edges, the drops and
// the browser keys the web view would otherwise act on.
//
// This is the rice's own layout. The kernel knows none of it: `ose.init({ page })` is handed
// the element this file builds, and from there the router draws into it.

import { ose } from 'ose:kernel';
import { isHost, canResizeWindow, resizeWindow, onVaultChange } from './host.js';
import { initTitlebar } from './titlebar.js';
import { initSidebar } from './sidebar.js';
import { initStatusbar } from './statusbar.js';
import { vaultLost, vaultFound, reloadIntoVault } from './vault.js';

const { bus, store, commands } = ose;

const MIN_MAIN = 340;
const S_MIN = 200, S_MAX = 420;
// L25: the sidebar never takes more than this share of the window, and under NARROW it steps
// out of the way altogether. 420px of sidebar in a 700px window is a sidebar with a page
// stapled to it; the preference is not touched, only what is drawn.
const S_SHARE = 0.4;
const NARROW = 640;

// The tree's own slot of `.ose/state.json`; `sidebar.js` writes `expanded` into the same one.
const sidebarState = ose.state('sidebar');

let shell = null;
let mainEl = null;
let wantS = 260;
let autoHidden = false;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const patchSidebar = (patch) => sidebarState.set({ ...(sidebarState.get() || {}), ...patch });

/* ------------------------------------------------------------------ layout */

/**
 * The sidebar gives way before the page column does: the page keeps MIN_MAIN on a narrow
 * window, the sidebar never exceeds S_SHARE of it, and under NARROW it hides itself and comes
 * back when the window is wide again (L25). `sidebar.open` — the user's preference — is never
 * written by any of this; `autoHidden` is what the window did, and toggling the sidebar by
 * hand clears it, so an explicit Ctrl+\ still opens it on a small window.
 */
function fit() {
  if (!shell) return;
  const avail = window.innerWidth;
  const narrow = avail < NARROW;
  const wanted = !!store.get('sidebar.open');
  if (narrow && wanted && !autoHidden) autoHidden = true;
  else if (!narrow && autoHidden) autoHidden = false;

  const sOpen = wanted && !autoHidden;
  shell.classList.toggle('no-sidebar', !sOpen);

  let s = sOpen ? Math.min(wantS, Math.max(S_MIN, Math.round(avail * S_SHARE))) : 0;
  const over = s + MIN_MAIN - avail;
  if (over > 0 && s > 0) { const cut = clamp(over, 0, Math.max(0, s - S_MIN)); s -= cut; }
  shell.style.setProperty('--sidebar-w', (sOpen ? s : wantS) + 'px');
  measureMain();
}

// A resizer is a separator control (D6): focusable, with its width spoken as a value, and the
// arrows move it. 8px a step, 32px with Shift, Home/End to the limits, Enter back to the default.
const RS_STEP = 8, RS_BIG = 32;

function makeResizer(handle, { get, set, min, max, invert, done }) {
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-valuemin', String(min));
  handle.setAttribute('aria-valuemax', String(max));
  handle.tabIndex = 0;
  const apply = (v) => { set(clamp(v, min, max)); handle.setAttribute('aria-valuenow', String(get())); };
  apply(get());

  handle.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const step = e.shiftKey ? RS_BIG : RS_STEP;
    // `invert` means the handle sits on the panel's left edge, where Right shrinks it.
    const sign = invert ? -1 : 1;
    if (e.key === 'ArrowRight') apply(get() + sign * step);
    else if (e.key === 'ArrowLeft') apply(get() - sign * step);
    else if (e.key === 'Home') apply(min);
    else if (e.key === 'End') apply(max);
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

/* -------------------------------------------------------------- page column */

// The page column is a token, not a hard-coded width, so views and the editor follow it for
// free. On a wide main area (a maximised 1920 window) it grows and the side padding scales,
// which is the difference between a column hugging the sidebar and one that sits in the page.
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
    // rem, like the tokens they override, so a wide window zooms with everything else.
    shell.style.setProperty('--page-w', '50rem');
    shell.style.setProperty('--page-pad-x', 'max(3rem, 6vw)');
  } else {
    shell.style.removeProperty('--page-w');
    shell.style.removeProperty('--page-pad-x');
  }
}

function watchMainWidth(el) {
  measureMain();
  if (typeof ResizeObserver !== 'function') return;
  const ro = new ResizeObserver((entries) => {
    const e = entries[entries.length - 1];
    measureMain(e.contentRect ? e.contentRect.width : undefined);
  });
  ro.observe(el);
}

/**
 * Where typing should go once something is on the page column: the editor body, else the
 * title, else a view's root, else the first recent row of the empty surface (B3). The router
 * does this itself after every navigation; this is the other half — Esc out of the tree, and
 * the `app.focus-page` command — and it is rice, because the page column is the rice's element.
 */
export function focusPage() {
  if (!mainEl) return false;
  const pick = mainEl.querySelector('.ProseMirror')
    || mainEl.querySelector('.page-title')
    || mainEl.querySelector('.view-root')
    || mainEl.querySelector('.start-row')
    || mainEl.querySelector('.miss .btn');
  if (!pick) return false;
  if (!pick.isContentEditable && !pick.hasAttribute('tabindex') && pick.tagName !== 'BUTTON') pick.tabIndex = -1;
  pick.focus({ preventScroll: true });
  return document.activeElement === pick;
}

/* ------------------------------------------------- frameless window edges */

const EDGES = ['top', 'right', 'bottom', 'left', 'topleft', 'topright', 'bottomleft', 'bottomright'];

function buildEdges() {
  if (!canResizeWindow()) return;         // a browser tab has a real frame
  if (ose.platform === 'macos') return;   // decorated window: the OS owns the resize edges
  const frag = document.createDocumentFragment();
  for (const edge of EDGES) {
    const d = document.createElement('div');
    d.className = 'edge edge-' + edge;
    d.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (document.documentElement.classList.contains('maximized')) return;
      e.preventDefault();
      resizeWindow(edge);
    });
    frag.appendChild(d);
  }
  document.body.appendChild(frag);
}

/* --------------------------------------------------------------- file drops */

// A file dropped anywhere but a real target would otherwise navigate the whole window to it,
// which in the host means the app is gone. Anything already handled (the sidebar's folder
// rows, the editor's image drop) has called preventDefault by the time this runs.
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
 * second launch naming a different folder, which the host adopts; the page reloads into it,
 * because every module read its world at boot.
 */
function watchVault() {
  ose.watch((d) => {
    if (!d || typeof d.lost !== 'boolean') return;
    if (d.lost) vaultLost();
    else vaultFound();
  });
  onVaultChange(() => reloadIntoVault());
}

/* --------------------------------------------------- the browser underneath */

// S27. The web view is a browser, and a browser's own accelerators are still live in it: F5
// and Ctrl+R reload the app — which throws away an unsaved buffer and every scrap of state
// the page holds — Ctrl+U shows the source, F7 turns on caret browsing. Tauri exposes none of
// wry's `browser_accelerator_keys`, so the page refuses them itself; Chromium lets a page do
// that for all of these (they are not reserved shortcuts). Zoom's own hotkeys are off at the
// web view (`zoomHotkeysEnabled: false` in both window configs), which is what leaves
// Ctrl+= / Ctrl+- / Ctrl+0 free for our zoom commands.
//
// Ctrl+O is deliberately not here: it is quick open, which already takes the event in the
// capture phase, so the web view's Open-file dialog never gets a chance either way. A key this
// guard swallows must be one nothing in the app wants.
//
// Ctrl+R is **not** in the set: it is the rice's own reload (docs/RICE.md: edit a file, press
// Ctrl+R, see the change), bound in keys.json to `app.reload`, which saves the open page
// first. F5 and the rest are the web view's, and they throw the buffer away without asking.
const BROWSER_KEYS = new Set([
  'f5', 'ctrl+f5', 'shift+f5', 'ctrl+u', 'f7',
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
 * Ctrl+R (docs/RICE.md). The rice is files on disk: edit one, reload, see it. A reload gives
 * the editor neither the `closing` notice it saves on nor a chance to ask about a conflict, so
 * the open page is saved and the state file flushed first — the same order the vault change
 * and the update take.
 */
async function reloadRice() {
  try { await commands.run('page.save'); } catch (e) { console.warn('[shell] save before reload', e); }
  await sidebarState.flush();
  void ose.reload();
}

/* ------------------------------------------------------------------ build */

/**
 * Build the shell into `rootEl` and answer its parts. Nothing is navigated to and no module
 * has run yet: `main.js` calls this, then hands `els.main` to `ose.init`.
 */
export function mountShell(rootEl) {
  const saved = sidebarState.get() || {};
  wantS = clamp(+saved.width || 260, S_MIN, S_MAX);

  rootEl.textContent = '';
  shell = document.createElement('div');
  shell.className = 'shell';
  shell.innerHTML = `
    <header class="titlebar"></header>
    <div class="body">
      <aside class="sidebar"></aside>
      <div class="rs rs-sidebar" data-reset="260" title="Drag to resize" aria-label="Sidebar width"></div>
      <main class="main"></main>
    </div>
    <footer class="statusbar"></footer>`;
  rootEl.appendChild(shell);

  const els = {
    titlebar: shell.querySelector('.titlebar'),
    sidebar: shell.querySelector('.sidebar'),
    main: shell.querySelector('.main'),
    statusbar: shell.querySelector('.statusbar'),
  };
  mainEl = els.main;

  // The sidebar tracks the store; its width is a CSS variable so nothing re-lays-out in JS.
  store.set('sidebar.open', saved.open !== false);
  store.watch('sidebar.open', (v) => {
    // An explicit toggle is the user overruling the window's own decision (L25).
    autoHidden = false;
    fit();
    patchSidebar({ open: !!v });
  });
  fit();

  makeResizer(shell.querySelector('.rs-sidebar'), {
    min: S_MIN, max: S_MAX,
    get: () => wantS,
    set: (v) => { wantS = v; fit(); },
    done: (v) => patchSidebar({ width: v }),
  });

  initTitlebar(els.titlebar);
  initSidebar(els.sidebar);
  initStatusbar(els.statusbar);
  buildEdges();
  guardWindowDrops();
  guardBrowserKeys();
  guardContextMenu();
  watchVault();

  commands.register({ id: 'app.back', title: 'Back', group: 'navigate', when: () => ose.route.canBack(), run: () => ose.route.back() });
  commands.register({ id: 'app.forward', title: 'Forward', group: 'navigate', when: () => ose.route.canForward(), run: () => ose.route.forward() });
  // The other half of `app.focus-sidebar` (sidebar.js, Ctrl+Shift+E). No chord: Esc from the
  // tree does it, and the palette has it for everywhere else (D2).
  commands.register({ id: 'app.focus-page', title: 'Focus page', group: 'app', hint: 'the editor, or the view', run: () => { focusPage(); } });
  // Quit goes to the host, which closes the window rather than exiting: the same path the
  // close button takes, so the last save is awaited (S16).
  commands.register({
    id: 'app.quit', title: 'Quit', group: 'app', hint: 'saves the page first',
    when: () => isHost(),
    run: () => { ose.window.quit().catch((e) => console.error('[shell] quit', e)); },
  });
  // The rice is files on disk: edit one, reload, see it (docs/RICE.md). In the host this
  // re-runs the kernel's rice decision; in the browser it is F5 by another name.
  commands.register({
    id: 'app.reload', title: 'Reload the rice', group: 'app', hint: 'after editing a rice file',
    run: () => void reloadRice(),
  });

  watchMainWidth(els.main);

  window.addEventListener('resize', fit);
  window.addEventListener('beforeunload', () => sidebarState.flush());
  fit();

  // Modules registered after the shell may change what is on screen; measure once more.
  bus.on('booted', () => { fit(); });

  return els;
}
