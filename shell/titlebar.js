// Title bar: app mark, back and forward, New file, the address bar, the unsaved mark, window
// controls. The whole strip is the window drag handle in the host; the buttons are drawn but
// inert in the browser. In a frameless window these buttons are the only way to minimise or
// close, so they are ordinary tab stops (D6). They sit first in the DOM and so first in the
// tab ring; putting them last would take a positive tabindex or a re-ordered shell, neither
// worth it for three buttons.
//
// The address bar (M21) is Explorer's. At rest it is the place on screen as segments — the
// vault's name, each folder, then the file — and every folder segment is a button that opens
// that folder. `app.address` (Ctrl+L, Alt+D), or a click on the bar's empty end, turns it into
// a text field holding the vault path, with the folder's children offered as you type: Tab
// takes the highlighted one, Up and Down move, Enter goes (a folder opens as a folder, a file
// as a page, a path that is not there says so and keeps the field), Esc puts the bar back. A
// full path pasted from Explorer works when it is inside the vault, and so does the leading
// vault name the bar shows at rest; one outside the vault says so.

import { ose } from 'ose:kernel';
import { esc, glyph, icon, hasIcon } from 'ose:ui';
import { sidebarVisible } from './layout.js';
import { isHost, dragWindow, onMaximize } from './host.js';
import * as M from './folder-model.js';
import { openInNewTab } from './tabs.js';
import { clean, baseName, titleOf } from './paths.js';

const { bus, commands, route, focus } = ose;
const currentRoute = () => route.current();
const shortcutFor = (id) => ose.keys.shortcutFor(id);

const vaultName = () => (ose.vault && ose.vault.name) || 'Vault';

let el = null;
let addrEl = null;
let dirtyEl = null;
let maxBtn = null;
let foldEl = null;
let navEls = null;
let focusEl = null;
let maximized = false;

// A real window: WebView2 or Tauri. The browser has its own frame and no window control.
const HOST = isHost;

// What the bar never starts a window drag from, and never maximises on a double click.
const CONTROLS = '.tb-btn, .tb-fold, .tb-focus, .tb-nav-btn, .tb-addr, .tb-addr-menu';

function setMaximized(v) {
  maximized = !!v;
  document.documentElement.classList.toggle('maximized', maximized);
  if (maxBtn) {
    maxBtn.innerHTML = glyph(maximized ? 'restore' : 'max');
    maxBtn.title = maximized ? 'Restore' : 'Maximize';
    maxBtn.setAttribute('aria-label', maxBtn.title);
  }
}

/* ------------------------------------------------------------------ the address, at rest */

/** A file's name as the chrome shows it (W8): whole, `.md` stripped only when hideMdExt is on. */
const display = (path) => titleOf(path) || baseName(path);

/**
 * The segments of a route: `[{ text, folder?, cur? }]`. The vault's name always leads, so the
 * root is one click away from anywhere; a folder segment carries the folder it opens.
 */
function partsOf(r) {
  const parts = [{ text: vaultName(), folder: '' }];
  if (!r) return parts;
  if (r.type === 'view') {
    const v = ose.views.get(r.name);
    parts.push({ text: (v && v.title) || r.name, cur: true });
    return parts;
  }
  const segs = clean(r.path).split('/').filter(Boolean);
  segs.forEach((s, i) => {
    const dir = segs.slice(0, i + 1).join('/');
    const last = i === segs.length - 1;
    if (last && r.type === 'page') parts.push({ text: display(dir), cur: true, path: dir });
    else parts.push({ text: s, folder: dir, cur: last });
  });
  if (!segs.length && r.type === 'folder') parts[0].cur = true;
  return parts;
}

function renderAddress(r) {
  if (!addrEl || editing) return;
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
    b.className = 'tb-crumb' + (p.cur ? ' cur' : '');
    b.textContent = p.text;
    if (p.folder != null) {
      b.type = 'button';
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

/* ------------------------------------------------------------------ the address, typed */

let editing = false;
let inputEl = null;
let menuEl = null;
let noteEl = null;
let items = [];        // [{ name, path, kind }] offered under the field
let pick = -1;         // the highlighted one, -1 for none
let picked = false;    // the highlight was moved by the keyboard, so Enter means it
let listSeq = 0;
const listCache = new Map();   // folder -> Promise<Entry[]>, for the length of one edit

/** The vault path of what is on screen: a page's, a folder's, nothing for a view. */
function pathOf(r) {
  if (!r || r.type === 'view') return '';
  return clean(r.path);
}

function listFolder(folder) {
  const key = clean(folder);
  if (!listCache.has(key)) {
    listCache.set(key, Promise.resolve(ose.files.list(key)).then(
      (list) => M.sortEntries(M.visibleEntries(Array.isArray(list) ? list : [], { showHidden: !!ose.settings.get().showHidden })),
      () => [],
    ));
  }
  return listCache.get(key);
}

/** Drop the `\\?\` a canonical Windows path can carry: it is the same place without it. */
const unverbatim = (p) => p.replace(/^\/\/\?\//, '');

/**
 * What the field says, as vault paths to try in order (slashes one way, none leading; a
 * trailing one is kept, it means "inside"). A full path pasted from Explorer or Finder that is
 * in this vault loses the vault's root (either slash, any case on Windows); a leading
 * `vault-name/`, which is how the bar reads at rest, is tried without it after the path as
 * typed. An absolute path anywhere else is `{ outside: true }`. `..` and `.` are not places.
 * @param {string} text
 * @returns {{paths: string[], outside?: boolean}}
 */
function relOf(text) {
  let t = unverbatim(String(text ?? '').trim().replace(/^"(.*)"$/s, '$1').replace(/\\/g, '/'));
  const win = ose.platform === 'windows';
  const fold = (x) => (win ? x.toLowerCase() : x);
  const root = unverbatim(String(ose.vault.root || '').replace(/\\/g, '/')).replace(/\/+$/, '');
  if (root && (fold(t) === fold(root) || fold(t).startsWith(fold(root) + '/'))) {
    return { paths: [t.slice(root.length).replace(/^\/+/, '')] };
  }
  if (/^[a-z]:(\/|$)/i.test(t) || t.startsWith('//')) return { paths: [], outside: true };
  t = t.replace(/^\/+/, '');
  const paths = [t];
  const name = vaultName();
  if (fold(t) === fold(name) || fold(t).startsWith(fold(name) + '/')) paths.push(t.slice(name.length).replace(/^\/+/, ''));
  return { paths };
}

async function suggest() {
  if (!inputEl) return;
  const { paths, outside } = relOf(inputEl.value);
  const my = ++listSeq;
  let folder = '';
  let stem = '';
  let list = [];
  // The path as typed first; the one without the vault's name only when that lists nothing.
  for (const raw of outside ? [] : paths) {
    const cut = raw.lastIndexOf('/');
    folder = cut < 0 ? '' : raw.slice(0, cut);
    stem = (cut < 0 ? raw : raw.slice(cut + 1)).toLowerCase();
    list = await listFolder(folder);
    if (my !== listSeq || !inputEl) return;
    if (list.length) break;
  }
  if (my !== listSeq || !inputEl) return;
  const starts = list.filter((e) => e.name.toLowerCase().startsWith(stem));
  const within = stem ? list.filter((e) => !e.name.toLowerCase().startsWith(stem) && e.name.toLowerCase().includes(stem)) : [];
  items = starts.concat(within).slice(0, 12).map((e) => ({ name: e.name, path: e.path || (folder ? `${folder}/${e.name}` : e.name), kind: e.kind }));
  pick = items.length ? 0 : -1;
  picked = false;
  drawMenu();
}

function drawMenu() {
  if (!menuEl) return;
  if (!items.length) {
    menuEl.hidden = true;
    if (inputEl) { inputEl.removeAttribute('aria-activedescendant'); inputEl.setAttribute('aria-expanded', 'false'); }
    return;
  }
  menuEl.innerHTML = items.map((it, i) => {
    const name = M.iconName({ name: it.name, kind: it.kind });
    const svg = icon(hasIcon(name) ? name : (it.kind === 'dir' ? 'folder' : 'file'));
    return `<div class="row tb-addr-item${i === pick ? ' active' : ''}" role="option" id="tb-addr-${i}" data-i="${i}" aria-selected="${i === pick}">
      ${svg}<span class="grow">${esc(it.name)}${it.kind === 'dir' ? '/' : ''}</span>
    </div>`;
  }).join('');
  const r = inputEl.getBoundingClientRect();
  menuEl.style.left = `${Math.round(r.left)}px`;
  menuEl.style.top = `${Math.round(r.bottom + 2)}px`;
  menuEl.style.width = `${Math.round(r.width)}px`;
  menuEl.hidden = false;
  inputEl.setAttribute('aria-expanded', 'true');
  if (pick >= 0) inputEl.setAttribute('aria-activedescendant', `tb-addr-${pick}`);
  else inputEl.removeAttribute('aria-activedescendant');
  const on = menuEl.querySelector('.active');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

/** Tab: the highlighted child into the field; a folder gets its slash, so typing goes on inside. */
function accept(i = pick) {
  const it = items[i];
  if (!it || !inputEl) return false;
  inputEl.value = it.kind === 'dir' ? `${it.path}/` : it.path;
  setNote('');
  void suggest();
  return true;
}

function setNote(text) {
  if (!noteEl) return;
  noteEl.textContent = text;
  noteEl.hidden = !text;
  if (inputEl) inputEl.setAttribute('aria-invalid', text ? 'true' : 'false');
}

/** Enter: stat the path and go there. What is not there keeps the field, with the reason. */
async function go() {
  const typed = picked && items[pick] ? { paths: [items[pick].path] } : relOf(inputEl ? inputEl.value : '');
  if (typed.outside) { setNote('That path is outside the vault'); return; }
  for (const target of [...new Set(typed.paths.map(clean))]) {
    if (!target) { finishEdit(); await route.navigate({ type: 'folder', path: '' }); return; }
    let st = null;
    try { st = await ose.files.stat(target); } catch (e) {
      if (/^\[escapes_vault\]/.test(String((e && e.message) || e))) { setNote('That path is outside the vault'); return; }
      continue;
    }
    if (!editing) return;
    if (!st || st.exists === false) continue;
    finishEdit();
    if (st.kind === 'dir') await route.navigate({ type: 'folder', path: target });
    else await route.navigate({ type: 'page', path: target });
    return;
  }
  if (editing) setNote('No such path');
}

function onInputKey(e) {
  if (e.isComposing) return;
  const k = e.key;
  if (k === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    finishEdit({ focusPage: true });
  } else if (k === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    void go();
  } else if (k === 'Tab' && !e.shiftKey && items.length) {
    e.preventDefault();
    accept();
  } else if (k === 'ArrowDown' || k === 'ArrowUp') {
    if (!items.length) return;
    e.preventDefault();
    pick = (pick + (k === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    picked = true;
    drawMenu();
  }
}

/** `app.address`: the bar becomes a field holding the path of what is on screen, selected. */
export function editAddress() {
  if (!addrEl) return;
  if (editing) { inputEl.focus(); inputEl.select(); return; }
  editing = true;
  listCache.clear();
  addrEl.classList.add('editing');
  const crumbs = addrEl.querySelector('.tb-crumbs');
  crumbs.hidden = true;
  inputEl = document.createElement('input');
  inputEl.type = 'text';
  inputEl.className = 'input mono tb-addr-input';
  inputEl.spellcheck = false;
  inputEl.autocomplete = 'off';
  inputEl.setAttribute('role', 'combobox');
  inputEl.setAttribute('aria-autocomplete', 'list');
  inputEl.setAttribute('aria-controls', 'tb-addr-menu');
  inputEl.setAttribute('aria-expanded', 'false');
  inputEl.setAttribute('aria-label', `Address: a path in ${vaultName()}`);
  inputEl.placeholder = `A path in ${vaultName()}`;
  inputEl.value = pathOf(currentRoute());
  noteEl = document.createElement('span');
  noteEl.className = 'tb-addr-note mono-sm';
  noteEl.setAttribute('role', 'status');
  noteEl.hidden = true;
  addrEl.appendChild(inputEl);
  addrEl.appendChild(noteEl);

  menuEl = document.createElement('div');
  menuEl.className = 'tb-addr-menu surface';
  menuEl.id = 'tb-addr-menu';
  menuEl.setAttribute('role', 'listbox');
  menuEl.hidden = true;
  // A click on a row keeps the field's focus: take it, then go on typing or press Enter.
  menuEl.addEventListener('mousedown', (e) => e.preventDefault());
  menuEl.addEventListener('click', (e) => {
    const row = e.target.closest('.tb-addr-item');
    if (!row) return;
    const it = items[+row.dataset.i];
    if (!it) return;
    if (it.kind === 'dir') accept(+row.dataset.i);
    else { pick = +row.dataset.i; picked = true; void go(); }
  });
  document.body.appendChild(menuEl);

  inputEl.addEventListener('keydown', onInputKey);
  inputEl.addEventListener('input', () => { setNote(''); void suggest(); });
  inputEl.addEventListener('blur', () => {
    // Leaving the field by any means is Esc: the bar comes back as it was.
    setTimeout(() => { if (editing && document.activeElement !== inputEl) finishEdit(); }, 0);
  });
  inputEl.focus();
  inputEl.select();
  void suggest();
}

function finishEdit({ focusPage = false } = {}) {
  if (!editing) return;
  editing = false;
  listSeq++;
  items = [];
  pick = -1;
  picked = false;
  listCache.clear();
  if (menuEl) { menuEl.remove(); menuEl = null; }
  if (inputEl) { inputEl.remove(); inputEl = null; }
  if (noteEl) { noteEl.remove(); noteEl = null; }
  if (addrEl) {
    addrEl.classList.remove('editing');
    addrEl.querySelector('.tb-crumbs').hidden = false;
  }
  renderAddress(currentRoute());
  if (focusPage) commands.run('app.focus-page');
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
    <button class="tb-focus mono" type="button" hidden></button>
    <div class="tb-drag"></div>
    <div class="tb-win${HOST() ? '' : ' dim'}">
      <button class="tb-btn" data-w="min" title="Minimize" aria-label="Minimize">${glyph('min')}</button>
      <button class="tb-btn" data-w="max" title="Maximize" aria-label="Maximize">${glyph('max')}</button>
      <button class="tb-btn close" data-w="close" title="Close" aria-label="Close">${glyph('close')}</button>
    </div>`;

  // The sidebar's one control: the far-left corner of the title bar, at the sidebar's own x,
  // in the same place whether the sidebar is open or folded. Only the glyph turns, and the
  // title says which way it goes. It runs `app.sidebar`, the same command Ctrl+\ runs.
  foldEl = el.querySelector('.tb-fold');
  foldEl.addEventListener('mousedown', (e) => e.stopPropagation());
  foldEl.addEventListener('click', () => commands.run('app.sidebar'));
  setSidebarShown(sidebarVisible());
  // The window hides the sidebar on its own under 640px (layout.js `fit`, L25), without
  // touching the preference, so the glyph follows what is on screen and not what is stored.
  bus.on('sidebar', setSidebarShown);

  addrEl = el.querySelector('.tb-addr');
  dirtyEl = el.querySelector('.tb-dirty');
  maxBtn = el.querySelector('[data-w="max"]');

  // A folder segment opens its folder; a click anywhere else in the bar edits the address,
  // which is what a click on Explorer's address bar does.
  addrEl.addEventListener('mousedown', (e) => e.stopPropagation());
  addrEl.addEventListener('click', (e) => {
    if (editing) return;
    const b = e.target.closest('.tb-crumb[data-folder]');
    if (b && !b.classList.contains('cur')) {
      const r = { type: 'folder', path: b.dataset.folder };
      if (e.ctrlKey || e.metaKey) void openInNewTab(r);
      else void route.navigate(r);
      return;
    }
    editAddress();
  });
  addrEl.addEventListener('auxclick', (e) => {
    const b = e.target.closest('.tb-crumb[data-folder]');
    if (!b || e.button !== 1) return;
    e.preventDefault();
    void openInNewTab({ type: 'folder', path: b.dataset.folder });
  });
  const titleAddr = () => {
    const chord = shortcutFor('app.address');
    addrEl.title = chord ? `Click or press ${chord} to type a path` : 'Click to type a path';
  };

  // Back and forward, where every browser and every file manager puts them (N45, L23): the
  // tab in front's own history (M23). The chord is in the tooltip, not on a label.
  navEls = { back: el.querySelector('[data-nav="back"]'), forward: el.querySelector('[data-nav="forward"]') };
  const titleNav = () => {
    for (const name of ['back', 'forward']) {
      const b = navEls[name];
      const chord = shortcutFor('app.' + name);
      const label = name === 'back' ? 'Back' : 'Forward';
      b.title = chord ? `${label} (${chord})` : label;
      b.setAttribute('aria-label', label);
    }
  };
  for (const name of ['back', 'forward']) {
    const b = navEls[name];
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', () => commands.run('app.' + name));
  }
  titleNav();
  updateNav();

  // New file… (H12): the one toolbar button for it, beside back and forward. It runs the same
  // command Ctrl+Alt+N and the tree's menu run (shell/fileops.js), so there is one New file.
  const newBtn = el.querySelector('.tb-new');
  const titleNew = () => {
    const chord = shortcutFor('file.new');
    newBtn.title = chord ? `New file… (${chord})` : 'New file…';
  };
  titleNew();
  titleAddr();
  // The chords come from keys.json, which is read after the bar is built.
  bus.on('booted', () => { titleNew(); titleAddr(); titleNav(); });
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
    if (e.target.closest(CONTROLS)) return;
    if (!HOST()) return;
    dragWindow();
  });

  el.addEventListener('dblclick', (e) => {
    if (e.target.closest(CONTROLS)) return;
    if (!HOST()) return;
    ose.window.maximize();
  });

  onMaximize(setMaximized);

  commands.register({
    id: 'app.address', title: 'Edit address', group: 'navigate',
    hint: 'type a path in the vault',
    run: () => editAddress(),
  });

  renderAddress(currentRoute());
  bus.on('route', (r) => { if (editing) finishEdit(); renderAddress(r); updateNav(); setState(null); });
  bus.on('tabs', () => updateNav());
  bus.on('route:repointed', (d) => { renderAddress(d ? d.current : currentRoute()); });
  bus.on('focus', () => { renderFocus(); });
  // The names follow hideMdExt; a view's title can arrive after it was first drawn.
  bus.on('settings', () => renderAddress(currentRoute()));
  bus.on('booted', () => renderAddress(currentRoute()));
  window.addEventListener('resize', () => { if (editing) drawMenu(); });
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
