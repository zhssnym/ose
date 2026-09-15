// Title bar: app mark, breadcrumb, unsaved dot, window controls. The whole strip is the
// window drag handle in the host; the buttons are drawn but inert in the browser. In a
// frameless window these buttons are the only way to minimise or close, so they are ordinary
// tab stops (D6). They sit first in the DOM and so first in the tab ring; putting them last
// would take a positive tabindex or a re-ordered shell, neither worth it for three buttons.
import { ose } from 'ose:kernel';
import { esc, glyph, icon } from 'ose:ui';
import { segments, titleOf, clean, baseName } from './paths.js';
import { focusFolder } from './sidebar.js';
import { isHost, dragWindow, onMaximize } from './host.js';

const { bus, commands, route, focus } = ose;
const currentRoute = () => route.current();
const canBack = () => route.canBack();
const canForward = () => route.canForward();
const shortcutFor = (id) => ose.keys.shortcutFor(id);

let el = null;
let crumbsEl = null;
let dirtyEl = null;
let maxBtn = null;
let navEls = null;
let maximized = false;

// A real window: WebView2 or Tauri. The browser has its own frame and no window control.
const HOST = isHost;

function setMaximized(v) {
  maximized = !!v;
  document.documentElement.classList.toggle('maximized', maximized);
  if (maxBtn) {
    maxBtn.innerHTML = glyph(maximized ? 'restore' : 'max');
    maxBtn.title = maximized ? 'Restore' : 'Maximize';
    maxBtn.setAttribute('aria-label', maxBtn.title);
  }
}

function crumb(text, onClick, cls = '') {
  const b = document.createElement(onClick ? 'button' : 'span');
  b.className = 'tb-crumb' + (cls ? ' ' + cls : '');
  b.textContent = text;
  if (onClick) { b.type = 'button'; b.addEventListener('click', onClick); }
  return b;
}

function sep() {
  const s = document.createElement('span');
  s.className = 'tb-sep-ch';
  s.textContent = '›';
  return s;
}

function renderCrumbs(route) {
  crumbsEl.textContent = '';
  if (!route) return;

  let parts;
  if (route.type === 'view') {
    parts = [{ text: 'view' }, { text: route.name, cur: true }];
  } else {
    // In focus mode the trail starts at the focus folder: everything above it is out of play.
    const focused = focus.get();
    const rooted = focused && focus.isUnder(route.path);
    const under = rooted ? clean(route.path).slice(focused.length + 1) : clean(route.path);
    const segs = segments(under);
    parts = segs.map((s, i) => {
      const last = i === segs.length - 1;
      const dir = (rooted ? focused + '/' : '') + segs.slice(0, i + 1).join('/');
      return last ? { text: titleOf(s), cur: true } : { text: s, folder: dir };
    });
    if (rooted) parts.unshift({ text: baseName(focused), folder: focused, focus: true });
    if (!parts.length) parts = [{ text: clean(route.path), cur: true }];
  }

  parts.forEach((p, i) => {
    if (i) crumbsEl.appendChild(sep());
    crumbsEl.appendChild(crumb(p.text, p.folder ? () => focusFolder(p.folder) : null, (p.cur ? 'cur' : '') + (p.focus ? ' focus' : '')));
  });
}

export function initTitlebar(node) {
  el = node;
  el.className = 'titlebar';
  el.innerHTML = `
    <div class="tb-mark" title="Ose"><span>ose</span></div>
    <div class="tb-nav">
      <button class="tb-nav-btn" data-nav="back" type="button">${icon('back')}</button>
      <button class="tb-nav-btn" data-nav="forward" type="button">${icon('forward')}</button>
    </div>
    <nav class="tb-crumbs mono" aria-label="location"></nav>
    <span class="tb-dirty" title="unsaved changes" hidden></span>
    <div class="tb-drag"></div>
    <div class="tb-win${HOST() ? '' : ' dim'}">
      <button class="tb-btn" data-w="min" title="Minimize" aria-label="Minimize">${glyph('min')}</button>
      <button class="tb-btn" data-w="max" title="Maximize" aria-label="Maximize">${glyph('max')}</button>
      <button class="tb-btn close" data-w="close" title="Close" aria-label="Close">${glyph('close')}</button>
    </div>`;

  crumbsEl = el.querySelector('.tb-crumbs');
  dirtyEl = el.querySelector('.tb-dirty');
  maxBtn = el.querySelector('[data-w="max"]');

  // Back and forward, where every browser and every file manager puts them (N45, L23). The
  // chord is in the tooltip, not on a label: the title bar is chrome, not a toolbar.
  navEls = { back: el.querySelector('[data-nav="back"]'), forward: el.querySelector('[data-nav="forward"]') };
  for (const name of ['back', 'forward']) {
    const b = navEls[name];
    const chord = shortcutFor('app.' + name);
    const label = name === 'back' ? 'Back' : 'Forward';
    b.title = chord ? `${label} (${chord})` : label;
    b.setAttribute('aria-label', label);
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', () => commands.run('app.' + name));
  }
  updateNav();

  el.querySelectorAll('.tb-btn').forEach((b) => {
    // Drawn dim and inert in the browser, so not tab stops there either.
    if (!HOST()) b.tabIndex = -1;
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', () => {
      if (!HOST()) return;
      const w = b.dataset.w;
      if (w === 'min') ose.window.minimize();
      else if (w === 'max') ose.window.maximize();
      else ose.window.close();
    });
  });

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tb-btn, .tb-crumb')) return;
    if (!HOST()) return;
    dragWindow();
  });

  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tb-btn, .tb-crumb')) return;
    if (!HOST()) return;
    ose.window.maximize();
  });

  onMaximize(setMaximized);

  bus.on('route', (r) => { renderCrumbs(r); updateNav(); setDirty(false); });
  bus.on('focus', () => renderCrumbs(currentRoute()));
  bus.on('doc:dirty', (d) => setDirty(d && d.dirty));
  bus.on('doc:saved', () => setDirty(false));
}

export function setDirty(v) { if (dirtyEl) dirtyEl.hidden = !v; }

/** Disabled when there is nowhere to go: the buttons say what only the chords knew before. */
export function updateNav() {
  if (!navEls) return;
  navEls.back.disabled = !canBack();
  navEls.forward.disabled = !canForward();
}
