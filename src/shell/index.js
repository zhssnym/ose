// The shell: window chrome, the sidebar-and-page body, and the wiring that holds the app together.
// Everything else plugs into this. See CONTRACT.md "Module entry points".
import './shell.css';
import { bus, store, commands } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { loadState, stateCache, patchState, flushState } from './state.js';
import { initTheme } from './theme.js';
import { initTitlebar } from './titlebar.js';
import { initSidebar } from './sidebar.js';
import { initStatusbar } from './statusbar.js';
import { initRouter, navigate, back, forward, canBack, canForward, clearRoute, focusMain } from './router.js';
import { initPalette } from './palette.js';
import { initSearch } from './search.js';
import { initSettings } from './settings.js';
import { initUpdate } from './update.js';
import { initKeys } from './keys.js';
import { icon } from './icons.js';
import { initFocus, loadFocus, getFocus, defaultNewFolder } from './focus.js';
import { vaultLost, vaultFound, reloadIntoVault } from './vault.js';
import { loadSources } from '../lib/sources.js';

export { navigate, back, forward, clearRoute };
// Focus mode is shell state; the editor asks for the folder a new page belongs in.
// `scratchFolder()` is the last fallback of page.new: the scratch source, never a folder name
// written out in code (CONTRACT.md batch 5).
export { getFocus, defaultNewFolder };
export { scratchFolder } from './sidebar.js';
// The page picker behind the editor's `Link` item and the `page.link` command.
export { pickPage, pageTitle, copyText } from './dialog.js';
// Settings other modules read: where an attachment goes, whether to spellcheck, where a
// deleted file goes and what to call that place in the confirmation (S35, S36, S37).
export { settings, attachmentFolder, spellcheckOn, trashMode, trashDestination } from './settings.js';
// "The vault is gone": the watcher says it, and anything that reads the root and is told it
// does not exist may say it too (S29).
export { vaultLost } from './vault.js';

const MIN_MAIN = 340;
const S_MIN = 200, S_MAX = 420;
// L25: the sidebar never takes more than this share of the window, and under NARROW it steps
// out of the way altogether. 420px of sidebar in a 700px window is a sidebar with a page
// stapled to it; the preference is not touched, only what is drawn.
const S_SHARE = 0.4;
const NARROW = 640;

let shell = null;
let wantS = 260;
let autoHidden = false;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

let mainRef = null;
let wide = null;

/** Called by the ResizeObserver, and by fit() so a hidden window (no frames, no observer
 *  callbacks) still ends up with the right tokens after a resize or a panel toggle. */
function measureMain(w) {
  if (!shell || !mainRef) return;
  const width = typeof w === 'number' ? w : mainRef.getBoundingClientRect().width;
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

function watchMainWidth(mainEl) {
  mainRef = mainEl;
  measureMain();
  if (typeof ResizeObserver !== 'function') return;
  const ro = new ResizeObserver((entries) => {
    const e = entries[entries.length - 1];
    measureMain(e.contentRect ? e.contentRect.width : undefined);
  });
  ro.observe(mainEl);
}

/* ------------------------------------------------- frameless window edges */

const EDGES = ['top', 'right', 'bottom', 'left', 'topleft', 'topright', 'bottomleft', 'bottomright'];

function buildEdges() {
  if (bridge.kind === 'http') return;       // the browser has a real frame
  if (bridge.platform === 'macos') return;  // decorated window: the OS owns the resize edges
  const frag = document.createDocumentFragment();
  for (const edge of EDGES) {
    const d = document.createElement('div');
    d.className = 'edge edge-' + edge;
    d.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (document.documentElement.classList.contains('maximized')) return;
      e.preventDefault();
      bridge.win.startResize(edge);
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
 * unmounted, deleted. The host's watcher says so once — `fs` with `{lost:true}` — instead of
 * failing every call with a toast of its own, and says so again when it comes back. The other
 * half is a second launch naming a different folder, which the host adopts and announces on
 * `vault`; the page reloads into it, because every module read its world at boot.
 */
function watchVault() {
  bridge.on('fs', (d) => {
    if (!d || typeof d.lost !== 'boolean') return;
    if (d.lost) vaultLost();
    else vaultFound();
  });
  bridge.on('vault', (d) => { if (d && d.changed) reloadIntoVault(); });
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
// Ctrl+O is deliberately not here: it is quick open (keys.js), which already takes the event
// in the capture phase, so the web view's Open-file dialog never gets a chance either way. A
// key this guard swallows must be one nothing in the app wants.
const BROWSER_KEYS = new Set([
  'f5', 'ctrl+f5', 'shift+f5', 'ctrl+r', 'ctrl+shift+r', 'ctrl+u', 'f7',
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
// can come from (P3's editor menu leaves that gesture unclaimed for exactly this). It is the
// same escape hatch Chromium itself uses for a page that overrides the menu.
function guardContextMenu() {
  window.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented || e.shiftKey) return;
    e.preventDefault();
  });
}

/* ------------------------------------------------------------------ boot */

export async function initShell(rootEl) {
  await loadState();
  // macOS keeps its native traffic lights over the web title bar (TAURI.md "Window"), so the
  // whole shell shifts the bar's contents right and drops our own window buttons.
  if (bridge.platform === 'macos') document.documentElement.classList.add('mac');
  // `data-os` is set from the user agent in index.html, before first paint, because the mac
  // font stack in tokens.css must be right on the very first frame. Here the host has answered
  // for itself, which is the authority: keys.js branches on it for the mac chords.
  document.documentElement.dataset.os =
    bridge.platform === 'macos' ? 'mac' : bridge.platform === 'linux' ? 'other' : 'win';
  initTheme();
  // Both are read by the views on their first mount, and initViews runs after initShell.
  loadSources(stateCache());
  loadFocus(stateCache());

  const st = stateCache();
  const sb = st.sidebar || {};
  wantS = clamp(+sb.width || 260, S_MIN, S_MAX);

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

  // The sidebar tracks the store; its width is a CSS variable so nothing re-lays-out in JS.
  store.set('sidebar.open', sb.open !== false);
  store.watch('sidebar.open', (v) => {
    // An explicit toggle is the user overruling the window's own decision (L25).
    autoHidden = false;
    fit();
    patchState({ sidebar: { ...(stateCache().sidebar || {}), open: !!v } });
  });
  fit();

  makeResizer(shell.querySelector('.rs-sidebar'), {
    min: S_MIN, max: S_MAX,
    get: () => wantS,
    set: (v) => { wantS = v; fit(); },
    done: (v) => patchState({ sidebar: { ...(stateCache().sidebar || {}), width: v } }),
  });
  initTitlebar(els.titlebar);
  initSidebar(els.sidebar);
  initStatusbar(els.statusbar);
  initRouter(els.main);
  initPalette();
  initSearch();
  initSettings();
  initUpdate();
  initKeys();
  initFocus();
  buildEdges();
  guardWindowDrops();
  guardBrowserKeys();
  guardContextMenu();
  watchVault();

  commands.register({ id: 'app.back', title: 'Back', group: 'navigate', when: canBack, run: back });
  commands.register({ id: 'app.forward', title: 'Forward', group: 'navigate', when: canForward, run: forward });
  // The other half of `app.focus-sidebar` (sidebar.js, Ctrl+Shift+E). No chord: Esc from the
  // tree does it, and the palette has it for everywhere else (D2).
  commands.register({ id: 'app.focus-page', title: 'Focus page', group: 'app', hint: 'the editor, or the view', run: () => { focusMain(); } });
  // Quit goes to the host, which closes the window rather than exiting: the same path the
  // close button takes, so the last save is awaited (S16). P3 binds Ctrl+Q / Cmd+Q.
  commands.register({
    id: 'app.quit', title: 'Quit', group: 'app', hint: 'saves the page first',
    when: () => bridge.kind !== 'http',
    run: () => { bridge.quit().catch((e) => console.error('[shell] quit', e)); },
  });

  watchMainWidth(els.main);

  window.addEventListener('resize', fit);
  window.addEventListener('beforeunload', () => flushState());
  fit();

  // Modules registered after the shell may change what is on screen; measure once more.
  bus.on('booted', () => { fit(); });
}

/** Exposed so other modules can render an icon in the shell's style. */
export { icon };
