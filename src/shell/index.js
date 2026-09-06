// The shell: window chrome, the three-column body, and the wiring that holds the app together.
// Everything else plugs into this. See CONTRACT.md "Module entry points".
import './shell.css';
import { bus, store, commands } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { mountClaudePane } from '../claude/index.js';
import { loadState, stateCache, patchState, flushState } from './state.js';
import { initTheme } from './theme.js';
import { initTitlebar } from './titlebar.js';
import { initSidebar } from './sidebar.js';
import { initStatusbar } from './statusbar.js';
import { initRouter, navigate, back, forward, canBack, canForward, clearRoute } from './router.js';
import { initPalette } from './palette.js';
import { initSearch } from './search.js';
import { initSettings, settings } from './settings.js';
import { initKeys } from './keys.js';
import { icon } from './icons.js';
import { initFocus, loadFocus, getFocus, defaultNewFolder } from './focus.js';
import { loadSources } from '../lib/sources.js';

export { navigate, back, forward, clearRoute };
// Focus mode is shell state; the editor asks for the folder a new page belongs in, and the
// claude module reads store 'focus' for its session cwd.
export { getFocus, defaultNewFolder };

const MIN_MAIN = 340;
const S_MIN = 200, S_MAX = 420;
const C_MIN = 320, C_MAX = 720;

let shell = null, claudeHost = null;
let wantS = 260, wantC = 400;
let claudeMounted = false;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------------ layout */

/** The right side panel exists only in dock mode; in view mode the pane lives in the main column. */
function claudeDocked() {
  return store.get('claude.mode') === 'dock' && !!store.get('claude.open');
}

function fit() {
  if (!shell) return;
  const avail = window.innerWidth;
  const sOpen = !!store.get('sidebar.open');
  const cOpen = claudeDocked();
  let s = sOpen ? wantS : 0;
  let c = cOpen ? wantC : 0;
  let over = s + c + MIN_MAIN - avail;
  if (over > 0 && c > 0) { const cut = clamp(over, 0, Math.max(0, c - C_MIN)); c -= cut; over -= cut; }
  if (over > 0 && s > 0) { const cut = clamp(over, 0, Math.max(0, s - S_MIN)); s -= cut; }
  shell.style.setProperty('--sidebar-w', (sOpen ? s : wantS) + 'px');
  shell.style.setProperty('--claude-w', (cOpen ? c : wantC) + 'px');
  measureMain();
}

function makeResizer(handle, { get, set, min, max, invert, done }) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('on');
    document.body.classList.add('resizing');
    const x0 = e.clientX, w0 = get();
    const move = (ev) => set(clamp(w0 + (invert ? x0 - ev.clientX : ev.clientX - x0), min, max));
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
  handle.addEventListener('dblclick', () => { set(handle.dataset.reset ? +handle.dataset.reset : get()); done && done(get()); });
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
    shell.style.setProperty('--page-w', '800px');
    shell.style.setProperty('--page-pad-x', 'max(48px, 6vw)');
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

/* ------------------------------------------------------------------ boot */

export async function initShell(rootEl) {
  await loadState();
  // macOS keeps its native traffic lights over the web title bar (TAURI.md "Window"), so the
  // whole shell shifts the bar's contents right and drops our own window buttons.
  if (bridge.platform === 'macos') document.documentElement.classList.add('mac');
  initTheme();
  // Both are read by the views on their first mount, and initViews runs after initShell.
  loadSources(stateCache());
  loadFocus(stateCache());

  const st = stateCache();
  const sb = st.sidebar || {};
  wantS = clamp(+sb.width || 260, S_MIN, S_MAX);
  wantC = clamp(+(st.settings || {}).claudeWidth || 400, C_MIN, C_MAX);

  rootEl.textContent = '';
  shell = document.createElement('div');
  shell.className = 'shell';
  shell.innerHTML = `
    <header class="titlebar"></header>
    <div class="body">
      <aside class="sidebar"></aside>
      <div class="rs rs-sidebar" data-reset="260" title="Drag to resize"></div>
      <main class="main"></main>
      <div class="rs rs-claude" data-reset="400" title="Drag to resize"></div>
      <section class="claude-pane"><div class="claude-host"></div></section>
    </div>
    <footer class="statusbar"></footer>`;
  rootEl.appendChild(shell);

  const els = {
    titlebar: shell.querySelector('.titlebar'),
    sidebar: shell.querySelector('.sidebar'),
    main: shell.querySelector('.main'),
    statusbar: shell.querySelector('.statusbar'),
  };
  claudeHost = shell.querySelector('.claude-host');

  // Panels track the store; widths are CSS variables so nothing re-lays-out in JS.
  store.set('sidebar.open', sb.open !== false);
  const syncSidebar = (v) => { shell.classList.toggle('no-sidebar', !v); fit(); };
  // The pane element is long-lived: the claude module moves it between this host and the main
  // column. The shell only decides whether the side panel is on screen.
  const syncClaude = () => {
    const docked = claudeDocked();
    shell.classList.toggle('no-claude', !docked);
    if (docked) {
      // mountClaudePane moves the one long-lived pane element; it is idempotent, and it must run
      // every time the dock shows because the element may have been in the Agent view meanwhile.
      claudeMounted = true;
      try { mountClaudePane(claudeHost); } catch (e) { console.error('[shell] mountClaudePane', e); }
    }
    fit();
  };
  store.watch('sidebar.open', (v) => { syncSidebar(v); patchState({ sidebar: { ...(stateCache().sidebar || {}), open: !!v } }); });
  store.watch('claude.open', syncClaude);
  store.watch('claude.mode', syncClaude);
  syncSidebar(store.get('sidebar.open'));
  syncClaude();

  makeResizer(shell.querySelector('.rs-sidebar'), {
    min: S_MIN, max: S_MAX,
    get: () => wantS,
    set: (v) => { wantS = v; fit(); },
    done: (v) => patchState({ sidebar: { ...(stateCache().sidebar || {}), width: v } }),
  });
  makeResizer(shell.querySelector('.rs-claude'), {
    min: C_MIN, max: C_MAX, invert: true,
    get: () => wantC,
    set: (v) => { wantC = v; fit(); },
    done: (v) => patchState({ settings: { ...settings(), claudeWidth: v } }),
  });

  initTitlebar(els.titlebar);
  initSidebar(els.sidebar);
  initStatusbar(els.statusbar);
  initRouter(els.main);
  initPalette();
  initSearch();
  initSettings();
  initKeys();
  initFocus();
  buildEdges();
  guardWindowDrops();

  commands.register({ id: 'app.back', title: 'Back', group: 'navigate', when: canBack, run: back });
  commands.register({ id: 'app.forward', title: 'Forward', group: 'navigate', when: canForward, run: forward });

  watchMainWidth(els.main);

  window.addEventListener('resize', fit);
  window.addEventListener('beforeunload', () => flushState());
  fit();

  // The claude module may set claude.open before the pane is asked for; keep them in step.
  bus.on('booted', () => { fit(); });
}

/** Exposed so other modules can render an icon in the shell's style. */
export { icon };
