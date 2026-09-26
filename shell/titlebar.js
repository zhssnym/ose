// Title bar: app mark, breadcrumb, unsaved dot, window controls. The whole strip is the
// window drag handle in the host; the buttons are drawn but inert in the browser. In a
// frameless window these buttons are the only way to minimise or close, so they are ordinary
// tab stops (D6). They sit first in the DOM and so first in the tab ring; putting them last
// would take a positive tabindex or a re-ordered shell, neither worth it for three buttons.
import { ose } from 'ose:kernel';
import { esc, glyph, icon } from 'ose:ui';
import { segments, titleOf, clean, baseName } from './paths.js';
import { focusFolder } from './sidebar.js';
import { sidebarVisible } from './layout.js';
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
let foldEl = null;
let navEls = null;
let focusEl = null;
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
    // The view's own title, the same name the tab and the window title carry: `dashboard` is a
    // route key and `Home` is what the page is called (R14).
    const v = ose.views.get(route.name);
    parts = [{ text: 'view' }, { text: (v && v.title) || route.name, cur: true }];
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
    <button class="tb-fold" type="button">${icon('chevron')}</button>
    <div class="tb-mark" title="Ose"><img src="logo.png" alt="" width="18" height="18"></div>
    <div class="tb-nav">
      <button class="tb-nav-btn" data-nav="back" type="button">${icon('back')}</button>
      <button class="tb-nav-btn" data-nav="forward" type="button">${icon('forward')}</button>
    </div>
    <button class="tb-nav-btn tb-new" type="button">${icon('plus')}</button>
    <nav class="tb-crumbs mono" aria-label="location"></nav>
    <span class="tb-dirty" role="img" aria-label="unsaved changes" title="unsaved changes" hidden></span>
    <button class="tb-focus mono" type="button" hidden></button>
    <div class="tb-drag"></div>
    <div class="tb-win${HOST() ? '' : ' dim'}">
      <button class="tb-btn" data-w="min" title="Minimize" aria-label="Minimize">${glyph('min')}</button>
      <button class="tb-btn" data-w="max" title="Maximize" aria-label="Maximize">${glyph('max')}</button>
      <button class="tb-btn close" data-w="close" title="Close" aria-label="Close">${glyph('close')}</button>
    </div>`;

  // The sidebar's one control: the far-left corner of the title bar, at the sidebar's own x,
  // in the same place whether the sidebar is open or folded. Only the glyph turns — the
  // chevron points left at an open sidebar and right at a folded one — and the title says
  // which way it goes. It runs `app.sidebar`, the same command Ctrl+\ runs, so `sidebar.open`
  // stays the one truth and there is one thing to find rather than two.
  foldEl = el.querySelector('.tb-fold');
  foldEl.addEventListener('mousedown', (e) => e.stopPropagation());
  foldEl.addEventListener('click', () => commands.run('app.sidebar'));
  setSidebarShown(sidebarVisible());
  // The window hides the sidebar on its own under 640px (layout.js `fit`, L25), without
  // touching the preference, so the glyph follows what is on screen and not what is stored.
  bus.on('sidebar', setSidebarShown);

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

  // New file… (H12): the one toolbar button for it, beside back and forward. It runs the same
  // command Ctrl+Alt+N and the tree's menu run (shell/fileops.js), so there is one New file.
  const newBtn = el.querySelector('.tb-new');
  // Its chord comes from keys.json, which is read after the bar is built: the title is written
  // again once the boot is done.
  const titleNew = () => {
    const chord = shortcutFor('file.new');
    newBtn.title = chord ? `New file… (${chord})` : 'New file…';
  };
  titleNew();
  bus.on('booted', titleNew);
  newBtn.setAttribute('aria-label', 'New file…');
  newBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  newBtn.addEventListener('click', () => commands.run('file.new'));

  // Focus mode's chip (H18): whenever a folder is in focus the bar says so, whether or not the
  // sidebar is open, and pressing it leaves focus. Nothing enters focus but its own command.
  focusEl = el.querySelector('.tb-focus');
  focusEl.addEventListener('mousedown', (e) => e.stopPropagation());
  focusEl.addEventListener('click', () => commands.run('app.focus-exit'));
  renderFocus();

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
    if (e.target.closest('.tb-btn, .tb-crumb, .tb-fold, .tb-focus')) return;
    if (!HOST()) return;
    dragWindow();
  });

  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tb-btn, .tb-crumb, .tb-fold, .tb-focus, .tb-nav-btn')) return;
    if (!HOST()) return;
    ose.window.maximize();
  });

  onMaximize(setMaximized);

  bus.on('route', (r) => { renderCrumbs(r); updateNav(); setState(null); });
  bus.on('route:repointed', (d) => { renderCrumbs(d ? d.current : currentRoute()); });
  bus.on('focus', () => { renderCrumbs(currentRoute()); renderFocus(); });
  // The mark follows the page in front only: the tabs carry every other page's (H8).
  const mine = (d) => {
    const r = currentRoute();
    return !!d && !!r && r.type === 'page' && clean(d.path) === clean(r.path);
  };
  bus.on('doc:dirty', (d) => { if (mine(d)) setDirty(d.dirty); });
  bus.on('doc:saved', (d) => { if (!d || mine(d)) setDirty(false); });
  bus.on('doc:state', (d) => { if (mine(d)) setState(d); });
}

/** The focus chip: `focus · <folder>` while a folder is in focus, off screen otherwise. */
function renderFocus() {
  if (!focusEl) return;
  const f = focus.get();
  focusEl.hidden = !f;
  if (!f) return;
  focusEl.innerHTML = `<span class="tb-focus-key">focus</span><span class="tb-focus-name">${esc(baseName(f))}</span>${icon('close')}`;
  focusEl.title = `Focus: ${f}. Leave focus`;
  focusEl.setAttribute('aria-label', `Leave focus on ${f}`);
}

/**
 * The page's save state beside the breadcrumb (H8): the dot while it is dirty, the error mark
 * when it could not be written or changed on disk under it, with the editor's sentence as the
 * tooltip. `null` is a page just opened, which is clean until the editor says otherwise.
 */
function setState(d) {
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
  const chord = shortcutFor('app.sidebar');
  const what = shown ? 'Hide sidebar' : 'Show sidebar';
  foldEl.title = chord ? `${what} (${chord})` : what;
  foldEl.setAttribute('aria-label', what);
  foldEl.setAttribute('aria-expanded', shown ? 'true' : 'false');
}

export function setDirty(v) {
  if (!dirtyEl || dirtyEl.classList.contains('err')) return;
  dirtyEl.hidden = !v;
}

/** Disabled when there is nowhere to go: the buttons say what only the chords knew before. */
export function updateNav() {
  if (!navEls) return;
  navEls.back.disabled = !canBack();
  navEls.forward.disabled = !canForward();
}
