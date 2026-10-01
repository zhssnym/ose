// The toolbar at the top of the window: the sidebar's fold, the app mark, back and forward,
// New file, the address bar, the unsaved mark and the focus chip. The window around it is the
// platform's own (X9, D11): Windows draws the title bar with its minimise, maximise (and Snap
// Layouts) and close, macOS its traffic lights, and both own moving and resizing the window.
// So this row is a plain toolbar, not a drag handle, and there are no window buttons in it.
//
// The path bar (M21): the place on screen as segments — the vault's name, each folder, then
// the file — and every folder segment is a button that opens that folder (Ctrl+click: a new
// tab). A page outside the vault reads "Outside the vault", its folder, then its name.

import { ose } from 'ose:core';
import { esc, icon } from 'ose:ui';
import { sidebarVisible } from './layout.js';
import { openInNewTab } from './tabs.js';
import { clean, baseName, dirName, titleOf, vaultName, isOutside, outsideLabel } from './paths.js';

const { bus, commands, route, focus } = ose;
const currentRoute = () => route.current();
const shortcutFor = (id) => ose.keys.shortcutFor(id);

let el = null;
let addrEl = null;
let dirtyEl = null;
let foldEl = null;
let navEls = null;
let focusEl = null;

/* ------------------------------------------------------------------ the address, at rest */

/** A file's name as the chrome shows it (W8): whole, `.md` stripped only when hideMdExt is on. */
const display = (path) => titleOf(path) || baseName(path);

/**
 * The segments of a route: `[{ text, folder?, cur? }]`. The vault's name always leads, so the
 * root is one click away from anywhere; a folder segment carries the folder it opens.
 */
function partsOf(r) {
  /** @type {{text: string, folder?: string, cur?: boolean, outside?: boolean, path?: string}[]} */
  const parts = [{ text: vaultName(), folder: '' }];
  if (!r) return parts;
  if (r.type === 'view') {
    const v = ose.views.get(r.name);
    parts.push({ text: (v && v.title) || r.name, cur: true });
    return parts;
  }
  if (r.type === 'page' && isOutside(r.path)) {
    // A file outside the vault (X7): no folder of it is a place in the app, so its folder is
    // one plain segment with the whole absolute path, and nothing but the name is current.
    const abs = outsideLabel(clean(r.path));
    parts[0] = { text: 'Outside the vault', outside: true };
    const dir = outsideLabel(dirName(clean(r.path)));
    if (dir) parts.push({ text: dir, path: dir });
    parts.push({ text: display(r.path), cur: true, path: abs });
    return parts;
  }
  const segs = clean(r.path).split('/').filter(Boolean);
  segs.forEach((s, i) => {
    const dir = segs.slice(0, i + 1).join('/');
    const last = i === segs.length - 1;
    if (last && r.type === 'page') parts.push({ text: display(dir), cur: true, path: dir });
    else parts.push({ text: s, folder: dir, cur: last });
  });
  if (!segs.length && r.type === 'folder' && parts[0]) parts[0].cur = true;
  return parts;
}

function renderAddress(r) {
  if (!addrEl) return;
  const crumbs = addrEl.querySelector('.tb-crumbs');
  crumbs.textContent = '';
  const parts = partsOf(r);
  parts.forEach((p, i) => {
    if (i) {
      const s = document.createElement('span');
      s.className = 'tb-sep-ch';
      s.setAttribute('aria-hidden', 'true');
      s.textContent = '›';
      crumbs.appendChild(s);
    }
    const b = document.createElement(p.folder != null ? 'button' : 'span');
    b.className = 'tb-crumb' + (p.cur ? ' cur' : '') + (p.outside ? ' tb-outside' : '');
    b.textContent = p.text;
    if (p.folder != null) {
      b.setAttribute('type', 'button');
      b.dataset.folder = p.folder;
      b.title = p.folder ? `Open ${p.folder}` : `Open ${vaultName()}`;
      if (p.cur) b.setAttribute('aria-current', 'location');
    } else {
      b.title = p.path || p.text;
      if (p.cur) b.setAttribute('aria-current', 'page');
    }
    crumbs.appendChild(b);
  });
  // The last segment is the one that matters: it stays in view when the path is long.
  crumbs.scrollLeft = crumbs.scrollWidth;
}

/* ------------------------------------------------------------------ build */

/**
 * Build the title bar into `node`: every control, the address bar and its command, and the
 * listeners that keep them in step with the route, the tabs and the page's save state.
 * @param {HTMLElement} node
 */
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
    <div class="tb-addr">
      <nav class="tb-crumbs" aria-label="Location"></nav>
    </div>
    <span class="tb-dirty" role="img" aria-label="unsaved changes" title="unsaved changes" hidden></span>
    <button class="tb-focus mono" type="button" hidden></button>`;

  // The sidebar's one control: the far-left corner of the title bar, at the sidebar's own x,
  // in the same place whether the sidebar is open or folded. Only the glyph turns, and the
  // title says which way it goes. It runs `app.sidebar`, the same command Ctrl+\ runs.
  // Every control below was written just above, so none of them is null.
  foldEl = /** @type {HTMLButtonElement} */ (el.querySelector('.tb-fold'));
  foldEl.addEventListener('click', () => commands.run('app.sidebar'));
  setSidebarShown(sidebarVisible());
  // The window hides the sidebar on its own under 640px (layout.js `fit`, L25), without
  // touching the preference, so the glyph follows what is on screen and not what is stored.
  bus.on('sidebar', setSidebarShown);

  addrEl = /** @type {HTMLElement} */ (el.querySelector('.tb-addr'));
  dirtyEl = /** @type {HTMLElement} */ (el.querySelector('.tb-dirty'));

  // A folder segment opens its folder.
  addrEl.addEventListener('click', (e) => {
    /** @type {HTMLElement|null} */
    const b = e.target instanceof Element ? e.target.closest('.tb-crumb[data-folder]') : null;
    if (b && !b.classList.contains('cur')) {
      const r = { type: 'folder', path: b.dataset.folder };
      if (e.ctrlKey || e.metaKey) void openInNewTab(r);
      else void route.navigate(r);
    }
  });
  addrEl.addEventListener('auxclick', (e) => {
    /** @type {HTMLElement|null} */
    const b = e.target instanceof Element ? e.target.closest('.tb-crumb[data-folder]') : null;
    if (!b || e.button !== 1) return;
    e.preventDefault();
    void openInNewTab({ type: 'folder', path: b.dataset.folder });
  });

  // Back and forward, where every browser and every file manager puts them (N45, L23): the
  // tab in front's own history (M23). The chord is in the tooltip, not on a label.
  navEls = {
    back: /** @type {HTMLButtonElement} */ (el.querySelector('[data-nav="back"]')),
    forward: /** @type {HTMLButtonElement} */ (el.querySelector('[data-nav="forward"]')),
  };
  const titleNav = () => {
    for (const name of ['back', 'forward']) {
      const b = navEls[name];
      const chord = shortcutFor('app.' + name);
      const label = name === 'back' ? 'Back' : 'Forward';
      b.title = chord ? `${label} (${chord})` : label;
      b.setAttribute('aria-label', label);
    }
  };
  for (const [name, b] of Object.entries(navEls)) {
    b.addEventListener('click', () => commands.run('app.' + name));
  }
  titleNav();
  updateNav();

  // New file… (H12): the one toolbar button for it, beside back and forward. It runs the same
  // command Ctrl+Alt+N and the tree's menu run (shell/fileops.js), so there is one New file.
  const newBtn = /** @type {HTMLButtonElement} */ (el.querySelector('.tb-new'));
  const titleNew = () => {
    const chord = shortcutFor('file.new');
    newBtn.title = chord ? `New file… (${chord})` : 'New file…';
  };
  titleNew();
  // The chords come from keys.json, which is read after the bar is built.
  bus.on('booted', () => { titleNew(); titleNav(); });
  newBtn.setAttribute('aria-label', 'New file…');
  newBtn.addEventListener('click', () => commands.run('file.new'));

  // Focus mode's chip (H18): whenever a folder is in focus the bar says so, whether or not the
  // sidebar is open, and pressing it leaves focus. Nothing enters focus but its own command.
  focusEl = /** @type {HTMLButtonElement} */ (el.querySelector('.tb-focus'));
  focusEl.addEventListener('click', () => commands.run('app.focus-exit'));
  renderFocus();

  renderAddress(currentRoute());
  bus.on('route', (r) => { renderAddress(r); updateNav(); setState(null); });
  bus.on('tabs', () => updateNav());
  bus.on('route:repointed', (d) => { renderAddress(d ? d.current : currentRoute()); });
  bus.on('focus', () => { renderFocus(); });
  // The names follow hideMdExt; a view's title can arrive after it was first drawn.
  bus.on('settings', () => renderAddress(currentRoute()));
  bus.on('booted', () => renderAddress(currentRoute()));
  // The mark follows the page in front only: the tabs carry every other page's (H8).
  const mine = (d) => {
    const r = currentRoute();
    return !!d && !!r && r.type === 'page' && clean(d.path) === clean(r.path);
  };
  bus.on('doc:dirty', (d) => { if (mine(d)) setDirty(d.dirty); });
  bus.on('doc:saved', (d) => { if (!d || mine(d)) setDirty(false); });
  bus.on('doc:state', (d) => { if (mine(d)) setState(d); });
}

/** The focus chip: `Focus · <folder>` while a folder is in focus, off screen otherwise. */
function renderFocus() {
  if (!focusEl) return;
  const f = focus.get();
  focusEl.hidden = !f;
  if (!f) return;
  focusEl.innerHTML = `<span class="tb-focus-key">Focus</span><span class="tb-focus-name">${esc(baseName(f))}</span>${icon('close')}`;
  focusEl.title = `Focus: ${f}. Leave focus`;
  focusEl.setAttribute('aria-label', `Leave focus on ${f}`);
}

/**
 * The page's save state beside the address (H8): the dot while it is dirty, the error mark when
 * it could not be written or changed on disk under it, with the editor's sentence as the
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

/**
 * The unsaved dot, on or off, unless the error mark holds the place.
 * @param {boolean} v
 */
export function setDirty(v) {
  if (!dirtyEl || dirtyEl.classList.contains('err')) return;
  dirtyEl.hidden = !v;
}

/** Disabled when there is nowhere to go in the tab in front: the buttons say what the chords knew. */
export function updateNav() {
  if (!navEls) return;
  navEls.back.disabled = !route.canBack();
  navEls.forward.disabled = !route.canForward();
}
