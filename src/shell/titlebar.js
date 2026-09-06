// Title bar: app mark, breadcrumb, unsaved dot, window controls. The whole strip is the
// window drag handle in the host; the buttons are drawn but inert in the browser.
import { bus, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { glyph } from './icons.js';
import { segments, titleOf, clean, baseName } from './paths.js';
import { openFolder } from './sidebar.js';
import { getFocus, isUnderFocus } from './focus.js';
import { currentRoute } from './router.js';

let el = null;
let crumbsEl = null;
let dirtyEl = null;
let maxBtn = null;
let maximized = false;

const HOST = () => bridge.kind === 'webview';

function setMaximized(v) {
  maximized = !!v;
  document.documentElement.classList.toggle('maximized', maximized);
  if (maxBtn) {
    maxBtn.innerHTML = glyph(maximized ? 'restore' : 'max');
    maxBtn.title = maximized ? 'Restore' : 'Maximize';
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
    // The Agent view is a place of its own, not one view among others (CONTRACT.md batch 2).
    parts = route.name === 'agent' ? [{ text: 'claude', cur: true }] : [{ text: 'view' }, { text: route.name, cur: true }];
  } else {
    // In focus mode the trail starts at the focus folder: everything above it is out of play.
    const focus = getFocus();
    const rooted = focus && isUnderFocus(route.path);
    const under = rooted ? clean(route.path).slice(focus.length + 1) : clean(route.path);
    const segs = segments(under);
    parts = segs.map((s, i) => {
      const last = i === segs.length - 1;
      const dir = (rooted ? focus + '/' : '') + segs.slice(0, i + 1).join('/');
      return last ? { text: titleOf(s), cur: true } : { text: s, folder: dir };
    });
    if (rooted) parts.unshift({ text: baseName(focus), folder: focus, focus: true });
    if (!parts.length) parts = [{ text: clean(route.path), cur: true }];
  }

  parts.forEach((p, i) => {
    if (i) crumbsEl.appendChild(sep());
    crumbsEl.appendChild(crumb(p.text, p.folder ? () => openFolder(p.folder) : null, (p.cur ? 'cur' : '') + (p.focus ? ' focus' : '')));
  });
}

export function initTitlebar(node) {
  el = node;
  el.className = 'titlebar';
  el.innerHTML = `
    <div class="tb-mark" title="os editor"><span>os</span></div>
    <nav class="tb-crumbs mono" aria-label="location"></nav>
    <span class="tb-dirty" title="unsaved changes" hidden></span>
    <div class="tb-drag"></div>
    <div class="tb-win${HOST() ? '' : ' dim'}">
      <button class="tb-btn" data-w="min" title="Minimize" tabindex="-1">${glyph('min')}</button>
      <button class="tb-btn" data-w="max" title="Maximize" tabindex="-1">${glyph('max')}</button>
      <button class="tb-btn close" data-w="close" title="Close" tabindex="-1">${glyph('close')}</button>
    </div>`;

  crumbsEl = el.querySelector('.tb-crumbs');
  dirtyEl = el.querySelector('.tb-dirty');
  maxBtn = el.querySelector('[data-w="max"]');

  el.querySelectorAll('.tb-btn').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', () => {
      if (!HOST()) return;
      const w = b.dataset.w;
      if (w === 'min') bridge.win.minimize();
      else if (w === 'max') bridge.win.maximize();
      else bridge.win.close();
    });
  });

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tb-btn, .tb-crumb')) return;
    if (!HOST()) return;
    bridge.win.startDrag();
  });

  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tb-btn, .tb-crumb')) return;
    if (!HOST()) return;
    bridge.win.maximize();
  });

  bridge.on('window', (d) => { if (d && typeof d.maximized === 'boolean') setMaximized(d.maximized); });
  if (HOST()) bridge.win.isMaximized().then(setMaximized).catch(() => { });

  bus.on('route', (r) => { renderCrumbs(r); setDirty(false); });
  bus.on('focus', () => renderCrumbs(currentRoute()));
  bus.on('doc:dirty', (d) => setDirty(d && d.dirty));
  bus.on('doc:saved', () => setDirty(false));
}

export function setDirty(v) { if (dirtyEl) dirtyEl.hidden = !v; }
