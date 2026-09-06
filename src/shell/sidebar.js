// Sidebar: pinned, agent, views, pages, scratch. One scrolling column, no search box (search
// is the Ctrl+F overlay now). Expansion and pins are persisted; the current page is revealed.
// Rows drag onto folder rows to move files; files dragged in from Explorer are imported.
// In focus mode the pages section is rooted at one folder and the other sections go away.
import { bus, store, commands, views, debounce, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { icon, hasIcon } from './icons.js';
import { patchState, stateCache } from './state.js';
import { navigate, currentRoute, clearRoute } from './router.js';
import { prompt, confirm, contextMenu, pickFolder, toast } from './dialog.js';
import { getFocus, setFocus, exitFocus, isUnderFocus, defaultNewFolder } from './focus.js';
import { clean, join, baseName, dirName, extOf, titleOf, isMd, isHiddenName, segments } from './paths.js';

let el = null, scrollEl = null;
let tree = null;
let expanded = new Set();
let pins = [];

const ARCHIVE = '_Archive';
const SCRATCH = 'Scratchpad';
const AGENT = 'agent';

/* ------------------------------------------------------------------ tree data */

// Files and folders sort together, in natural numeric order, case- and accent-insensitive,
// so `0. Index/` and `00-index.md` land next to each other and before any letter. The bridge
// and the host both hand us folders first; this is where that is undone.
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'accent', caseFirst: 'false' });
export const compareNames = (a, b) => COLLATOR.compare(a, b);

function sortChildren(list, atRoot) {
  const out = list.filter((c) => !isHiddenName(c.name));
  out.sort((a, b) => {
    if (atRoot) {
      const aa = a.name === ARCHIVE, bb = b.name === ARCHIVE;
      if (aa !== bb) return aa ? 1 : -1;
    }
    return COLLATOR.compare(a.name, b.name);
  });
  return out;
}

function findNode(path) {
  const segs = segments(path);
  let node = tree;
  for (const s of segs) {
    if (!node || !node.children) return null;
    node = node.children.find((c) => c.name === s);
  }
  return node || null;
}

function mdFilesOf(node) {
  return node && node.children ? node.children.filter((c) => c.kind === 'file' && isMd(c.name)) : [];
}

/** Every .md path in the vault, for the quick-open palette. Focus mode narrows it. */
export function allPages() {
  const out = [];
  const walk = (n, atRoot) => {
    if (!n.children) return;
    for (const c of sortChildren(n.children, atRoot)) {
      if (c.kind === 'dir') walk(c, false);
      else if (isMd(c.name)) out.push(c.path);
    }
  };
  if (tree) walk(tree, true);
  return getFocus() ? out.filter((p) => isUnderFocus(p)) : out;
}

export function treeRoot() { return tree; }

/* ------------------------------------------------------------------ expansion */

function persistExpanded() {
  const s = stateCache().sidebar || {};
  patchState({ sidebar: { ...s, expanded: [...expanded] } });
}

function expandAncestors(path) {
  const segs = segments(dirName(path));
  let acc = '';
  for (const s of segs) { acc = acc ? acc + '/' + s : s; expanded.add(acc); }
}

/* ------------------------------------------------------------------ pins */

function persistPins() { patchState({ pins: [...pins] }); }

export function isPinned(path) { return pins.includes(clean(path)); }

function pin(path) {
  const p = clean(path);
  if (!p || pins.includes(p)) return;
  pins.push(p);
  persistPins();
  render();
}

function unpin(path) {
  const p = clean(path);
  const i = pins.indexOf(p);
  if (i < 0) return;
  pins.splice(i, 1);
  persistPins();
  render();
}

/** Follow a rename or a move: a pinned path, and anything under it, keeps its pin. */
function repinMoved(from, to) {
  let changed = false;
  pins = pins.map((p) => {
    if (p === from) { changed = true; return to; }
    if (p.startsWith(from + '/')) { changed = true; return to + p.slice(from.length); }
    return p;
  });
  if (changed) persistPins();
}

function dropPinsUnder(path) {
  const before = pins.length;
  pins = pins.filter((p) => p !== path && !p.startsWith(path + '/'));
  if (pins.length !== before) persistPins();
}

/** Drop pins whose file is gone (deleted outside the app). Only when the tree is loaded. */
function prunePins() {
  if (!tree) return;
  const before = pins.length;
  pins = pins.filter((p) => !!findNode(p));
  if (pins.length !== before) persistPins();
}

/* ------------------------------------------------------------------ rendering */

// Every row is the same three-column grid: 16px chevron slot, 14px glyph, name (plus an
// optional mono tail). Folders and pages at the same depth put their text at the same x.
function rowEl({ cls = '', depth = 0, glyphHtml = '', chevron = null, text, tail = '', hint = '', data = {} }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'row sb-row ' + cls;
  b.style.setProperty('--d', depth);
  for (const k of Object.keys(data)) b.dataset[k] = data[k];
  if (data.path) b.draggable = true; // moves within the vault; see the drag and drop section
  b.innerHTML =
    `<span class="tw${chevron ? ' open' : ''}">${chevron === null ? '' : icon('chevron')}</span>` +
    `<span class="gl">${glyphHtml}</span>` +
    `<span class="grow">${esc(text)}</span>` +
    (tail ? `<span class="par">${esc(tail)}</span>` : '') +
    (hint ? `<span class="hint">${esc(hint)}</span>` : '');
  return b;
}

// A section label doubles as a drop target when `dropPath` is given: '' is the vault root,
// 'Scratchpad' the scratch section. Pass nothing for a label that takes no drops.
function label(text, dropPath) {
  const d = document.createElement('div');
  d.className = 'section-label';
  d.textContent = text;
  if (dropPath !== undefined && dropPath !== null) d.dataset.drop = dropPath;
  return d;
}

// Views may hand us a raw <svg> string, a name from our icon set, or nothing.
function viewIcon(v) {
  const i = v.icon;
  if (typeof i === 'string' && i.trim().startsWith('<')) return i;
  if (typeof i === 'string' && hasIcon(i)) return icon(i);
  return icon(hasIcon(v.name) ? v.name : 'view');
}

/** Pinned pages and folders, in pin order. Hidden entirely while nothing is pinned. */
function renderPinned(frag) {
  if (!pins.length) return;
  const r = currentRoute();
  const curPath = r && r.type === 'page' ? r.path : null;
  const names = new Map();
  for (const p of pins) names.set(baseName(p), (names.get(baseName(p)) || 0) + 1);

  frag.appendChild(label('pinned'));
  for (const p of pins) {
    const node = findNode(p);
    const dir = node ? node.kind === 'dir' : !baseName(p).includes('.');
    const name = dir ? baseName(p) : titleOf(p);
    const ambiguous = (names.get(baseName(p)) || 0) > 1;
    const parent = dirName(p);
    frag.appendChild(rowEl({
      cls: 'sb-pin ' + (dir ? 'dir' : 'file') + (curPath === p ? ' current' : ''),
      depth: 0,
      glyphHtml: icon(dir ? 'folder' : 'page'),
      text: name,
      tail: ambiguous ? (parent ? baseName(parent) : '/') : '',
      data: { path: p, kind: dir ? 'dir' : 'file', md: isMd(p) ? '1' : '0', pin: '1' },
    }));
  }
}

/** The agent row is its own section above the views, and is never listed among them. */
function renderAgent(frag) {
  const v = views.get(AGENT);
  if (!v) return;
  const r = currentRoute();
  frag.appendChild(label('agent'));
  frag.appendChild(rowEl({
    cls: 'sb-view sb-agent' + (r && r.type === 'view' && r.name === AGENT ? ' current' : ''),
    depth: 0,
    glyphHtml: viewIcon(v),
    text: 'Claude',
    data: { view: AGENT },
  }));
}

function renderViews(frag) {
  const list = views.list().filter((v) => v.name !== AGENT);
  if (!list.length) return;
  frag.appendChild(label('views'));
  const r = currentRoute();
  for (const v of list) {
    frag.appendChild(rowEl({
      cls: 'sb-view' + (r && r.type === 'view' && r.name === v.name ? ' current' : ''),
      depth: 0,
      glyphHtml: viewIcon(v),
      text: v.title || v.name,
      data: { view: v.name },
    }));
  }
}

function renderNode(node, depth, frag, curPath) {
  if (isHiddenName(node.name)) return;
  if (node.kind === 'dir') {
    const open = expanded.has(node.path);
    frag.appendChild(rowEl({
      cls: 'dir' + (node.name === ARCHIVE ? ' archive' : ''),
      depth, chevron: open, glyphHtml: icon('folder'), text: node.name,
      data: { path: node.path, kind: 'dir' },
    }));
    if (open && node.children) {
      for (const c of sortChildren(node.children, false)) renderNode(c, depth + 1, frag, curPath);
    }
  } else {
    const md = isMd(node.name);
    frag.appendChild(rowEl({
      cls: 'file' + (md ? '' : ' other') + (curPath === node.path ? ' current' : ''),
      depth, glyphHtml: icon('page'), text: md ? titleOf(node.name) : node.name,
      data: { path: node.path, kind: 'file', md: md ? '1' : '0' },
    }));
  }
}

/** Scratchpad, flat: its files as rows, its folders expandable in place. */
function renderScratch(frag, curPath) {
  const node = findNode(SCRATCH);
  if (!node || node.kind !== 'dir') return;
  const kids = sortChildren(node.children || [], false);
  frag.appendChild(label('scratch', SCRATCH));
  if (!kids.length) {
    const d = document.createElement('div');
    d.className = 'empty sb-empty';
    d.textContent = 'nothing here';
    frag.appendChild(d);
    return;
  }
  const box = document.createElement('div');
  box.className = 'sb-scratch';
  for (const c of kids) renderNode(c, 0, box, curPath);
  frag.appendChild(box);
}

/** The mono `focus · <folder>` strip above the tree, with the only way out besides the command. */
function renderFocusHead(frag, focus) {
  const box = document.createElement('div');
  box.className = 'sb-focus mono-sm';
  box.innerHTML = `<span class="sb-focus-key">focus</span><span class="sb-focus-sep">·</span>`
    + `<span class="sb-focus-path" title="${esc(focus)}">${esc(focus)}</span>`;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sb-focus-exit';
  b.textContent = 'exit';
  b.title = 'Leave focus mode';
  b.addEventListener('click', () => exitFocus());
  box.appendChild(b);
  frag.appendChild(box);
}

function renderTree() {
  const frag = document.createDocumentFragment();
  const r = currentRoute();
  const curPath = r && r.type === 'page' ? r.path : null;
  const focus = getFocus();

  // Focused, the sidebar is one folder and the app's own rows: pins and scratch are noise.
  if (!focus) renderPinned(frag);
  renderAgent(frag);
  renderViews(frag);

  frag.appendChild(label('pages', focus || ''));
  if (focus) renderFocusHead(frag, focus);
  if (!tree) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'reading vault…';
    frag.appendChild(d);
  } else {
    const root = focus ? findNode(focus) : tree;
    const pages = document.createElement('div');
    pages.className = 'sb-pages';
    if (focus && (!root || root.kind !== 'dir')) {
      const d = document.createElement('div');
      d.className = 'empty sb-empty';
      d.textContent = 'focus folder is gone';
      pages.appendChild(d);
    } else {
      for (const c of sortChildren((root && root.children) || [], !focus)) {
        if (!focus && c.kind === 'dir' && c.name === SCRATCH) continue; // it has its own section
        renderNode(c, 0, pages, curPath);
      }
    }
    frag.appendChild(pages);
  }

  if (tree && !focus) renderScratch(frag, curPath);

  const keep = scrollEl.scrollTop;
  scrollEl.textContent = '';
  scrollEl.appendChild(frag);
  scrollEl.scrollTop = keep;
}

function render() {
  if (!scrollEl) return;
  renderTree();
}

function rowFor(path) {
  return scrollEl.querySelector(`.sb-row[data-path="${CSS.escape(path)}"]:not(.sb-pin)`);
}

function scrollToCurrent() {
  const r = currentRoute();
  if (!r || r.type !== 'page') return;
  const node = rowFor(r.path);
  if (node) node.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------ data load */

export async function refreshTree() {
  try {
    tree = await bridge.tree();
  } catch (e) {
    console.error('[shell] tree', e);
    toast('tree failed: ' + (e.message || e), 'err');
    return;
  }
  prunePins();
  render();
  scrollToCurrent();
}

/* ------------------------------------------------------------------ mutations */

export async function newPageIn(folder) {
  const dir = clean(folder || '');
  try {
    let path = join(dir, 'Untitled.md');
    for (let n = 2; n < 500 && await bridge.exists(path); n++) path = join(dir, `Untitled ${n}.md`);
    await bridge.writeText(path, '# Untitled\n');
    if (dir) { expanded.add(dir); expandAncestors(path); persistExpanded(); }
    await refreshTree();
    await navigate({ type: 'page', path });
    return path;
  } catch (e) {
    toast('could not create page: ' + (e.message || e), 'err');
    return null;
  }
}

async function newFolderIn(folder) {
  const name = await prompt({ title: 'New Folder', placeholder: 'folder name', ok: 'Create' });
  if (!name) return;
  const dir = clean(folder || '');
  try {
    await bridge.mkdir(join(dir, name));
    if (dir) expanded.add(dir);
    expanded.add(join(dir, name));
    persistExpanded();
    await refreshTree();
  } catch (e) { toast('could not create folder: ' + (e.message || e), 'err'); }
}

/** Shared tail of rename and move: keep expansion, pins and the open page pointing at `to`. */
async function afterMove(from, to) {
  if (expanded.delete(from)) expanded.add(to);
  repinMoved(from, to);
  persistExpanded();
  const r = currentRoute();
  if (r && r.type === 'page') {
    if (r.path === from) { await refreshTree(); await navigate({ type: 'page', path: to }, { replace: true, force: true }); return; }
    if (r.path.startsWith(from + '/')) { await refreshTree(); await navigate({ type: 'page', path: to + r.path.slice(from.length) }, { replace: true, force: true }); return; }
  }
  await refreshTree();
}

async function renameAt(path, kind) {
  const old = baseName(path);
  const name = await prompt({ title: kind === 'dir' ? 'Rename Folder' : 'Rename Page', value: old, ok: 'Rename' });
  if (!name || name === old) return;
  const to = join(dirName(path), name);
  try {
    await bridge.rename(path, to);
    await afterMove(path, to);
  } catch (e) { toast('rename failed: ' + (e.message || e), 'err'); }
}

/** Move a file to another folder: pick a destination, then bridge.rename. */
async function moveTo(path) {
  const from = clean(path);
  const dir = dirName(from);
  const dest = await pickFolder({ title: 'Move ' + baseName(from) + ' to…', current: dir });
  if (dest === null) return;
  const to = join(dest, baseName(from));
  if (to === from) return;
  try {
    if (await bridge.exists(to)) { toast(baseName(from) + ' already exists in ' + (dest || 'the vault root'), 'err'); return; }
    await bridge.rename(from, to);
    if (dest) { expanded.add(dest); expandAncestors(to); }
    await afterMove(from, to);
    toast('moved to ' + (dest || 'vault root'), 'info', 2200);
  } catch (e) { toast('move failed: ' + (e.message || e), 'err'); }
}

async function trashAt(path, kind) {
  const ok = await confirm({
    title: kind === 'dir' ? 'Move Folder to Trash' : 'Move Page to Trash',
    body: `${path} goes to the Recycle Bin. Nothing is deleted permanently.`,
    ok: 'Move to Trash', danger: true,
  });
  if (!ok) return;
  try {
    await bridge.trash(path);
    expanded.delete(path);
    dropPinsUnder(path);
    const r = currentRoute();
    const hit = r && r.type === 'page' && (r.path === path || r.path.startsWith(path + '/'));
    await refreshTree();
    if (hit) await clearRoute();
  } catch (e) { toast('trash failed: ' + (e.message || e), 'err'); }
}

/** Expand the tree down to a folder and bring it into view. No navigation. */
export function revealFolder(path) {
  const dir = clean(path);
  if (!dir) return;
  store.set('sidebar.open', true);
  expandAncestors(dir + '/x');
  expanded.add(dir);
  persistExpanded();
  render();
  requestAnimationFrame(() => {
    const n = rowFor(dir);
    if (n) n.scrollIntoView({ block: 'center' });
  });
}

/** Breadcrumb click: expand the folder in the tree and open its first page. */
export async function openFolder(path) {
  const dir = clean(path);
  revealFolder(dir);
  const first = mdFilesOf(findNode(dir))[0];
  if (first) await navigate({ type: 'page', path: first.path });
}

/* ------------------------------------------------------------- drag and drop */

// Internal drags carry the vault path in a private type; `dragPath` mirrors it because
// dataTransfer.getData is unreadable during dragover, and the self/descendant guard has to
// run there to decide whether the row may light up at all.
const DRAG_TYPE = 'application/x-os-path';
const TEXT_IMPORT = new Set(['md', 'txt']);

let dragPath = null;
let dropEl = null;

/** A folder row (tree or pin) or a section label that stands for a folder. */
function dropTargetOf(node) {
  if (!node || !node.closest) return null;
  const lab = node.closest('.section-label[data-drop]');
  if (lab) return { el: lab, dir: lab.dataset.drop };
  const row = node.closest('.sb-row.dir');
  if (row && row.dataset.path) return { el: row, dir: row.dataset.path };
  return null;
}

function canDropInto(from, dir) {
  const src = clean(from), target = clean(dir);
  if (!src) return false;
  if (src === target || target.startsWith(src + '/')) return false; // into itself or its subtree
  return dirName(src) !== target;                                   // already there
}

function setDropEl(node) {
  if (dropEl === node) return;
  if (dropEl) dropEl.classList.remove('drop-on');
  dropEl = node;
  if (dropEl) dropEl.classList.add('drop-on');
}

function endDrag() { dragPath = null; setDropEl(null); }

async function moveInto(from, dir) {
  const src = clean(from), target = clean(dir);
  if (!canDropInto(src, target)) return;
  const to = join(target, baseName(src));
  try {
    if (await bridge.exists(to)) { toast(baseName(src) + ' already exists in ' + (target || 'the vault root'), 'err'); return; }
    await bridge.rename(src, to);
    if (target) { expanded.add(target); expandAncestors(to); }
    await afterMove(src, to);
    toast('moved to ' + (target || 'vault root'), 'info', 2200);
  } catch (e) { toast('move failed: ' + (e.message || e), 'err'); }
}

/** `<dir>/name.ext`, numbered when taken, so an import never overwrites a vault file. */
async function freeName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let p = join(dir, name);
  for (let n = 2; n < 500 && await bridge.exists(p); n++) p = join(dir, `${base} ${n}${ext}`);
  return p;
}

function base64Of(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  const CHUNK = 0x8000; // apply() has an argument limit; 32k at a time stays under it
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(out);
}

/** Files dragged in from Explorer. Text goes through writeText, everything else as base64. */
async function importFiles(files, dir) {
  const list = [...files];
  if (!list.length) return;
  let done = 0;
  for (const f of list) {
    try {
      const path = await freeName(clean(dir), f.name || 'file');
      if (TEXT_IMPORT.has(extOf(path))) await bridge.writeText(path, await f.text());
      else await bridge.writeBinary(path, base64Of(await f.arrayBuffer()));
      done++;
    } catch (e) {
      toast('could not import ' + (f.name || 'a file') + ': ' + (e.message || e), 'err');
    }
  }
  if (!done) return;
  if (dir) { expanded.add(clean(dir)); persistExpanded(); }
  await refreshTree();
  toast(`imported ${done} file${done === 1 ? '' : 's'}`, 'info', 2600);
}

function bindDnd(host) {
  host.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.sb-row[data-path]');
    if (!row) { e.preventDefault(); return; }
    dragPath = row.dataset.path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, dragPath);
    e.dataTransfer.setData('text/plain', dragPath);
  });

  host.addEventListener('dragend', endDrag);

  host.addEventListener('dragover', (e) => {
    const types = e.dataTransfer ? [...e.dataTransfer.types] : [];
    const internal = !!dragPath || types.includes(DRAG_TYPE);
    const external = types.includes('Files');
    if (!internal && !external) { setDropEl(null); return; }
    const t = dropTargetOf(e.target);
    if (!t || (internal && !canDropInto(dragPath, t.dir))) {
      setDropEl(null);
      e.preventDefault();                       // still ours: no browser navigation
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    setDropEl(t.el);
  });

  host.addEventListener('dragleave', (e) => {
    if (dropEl && !dropEl.contains(e.relatedTarget)) setDropEl(null);
  });

  host.addEventListener('drop', (e) => {
    e.preventDefault();
    const t = dropTargetOf(e.target);
    const from = dragPath || (e.dataTransfer ? e.dataTransfer.getData(DRAG_TYPE) : '');
    const files = e.dataTransfer ? e.dataTransfer.files : null;
    endDrag();
    if (!t) return;
    if (from) void moveInto(from, t.dir);
    else if (files && files.length) void importFiles(files, t.dir);
  });
}

/* ------------------------------------------------------------------ menu */

function menuFor(path, kind) {
  const dir = kind === 'dir' ? path : dirName(path);
  const items = [
    { label: 'New Page Here', iconSvg: icon('plus'), run: () => newPageIn(dir) },
    { label: 'New Folder', iconSvg: icon('folderPlus'), run: () => newFolderIn(dir) },
  ];
  if (path) {
    items.push({ sep: true });
    items.push(isPinned(path)
      ? { label: 'Unpin', iconSvg: icon('pin'), run: () => unpin(path) }
      : { label: 'Pin', iconSvg: icon('pin'), run: () => pin(path) });
    if (kind === 'dir') {
      items.push(getFocus() === path
        ? { label: 'Exit Focus', iconSvg: icon('focus'), run: () => exitFocus() }
        : { label: 'Focus', iconSvg: icon('focus'), run: () => setFocus(path) });
    }
    items.push({ label: 'Rename…', iconSvg: icon('rename'), run: () => renameAt(path, kind) });
    if (kind !== 'dir') items.push({ label: 'Move to…', iconSvg: icon('folder'), run: () => moveTo(path) });
    items.push({ label: 'Reveal in Explorer', iconSvg: icon('reveal'), run: () => bridge.reveal(path).catch((e) => toast(e.message || e, 'err')) });
    items.push({ sep: true });
    items.push({ label: 'Move to Trash', iconSvg: icon('trash'), danger: true, run: () => trashAt(path, kind) });
  } else {
    items.push({ sep: true });
    items.push({ label: 'Reveal in Explorer', iconSvg: icon('reveal'), run: () => bridge.reveal('').catch((e) => toast(e.message || e, 'err')) });
  }
  return items;
}

/** Right-click on the empty space under the tree: create in Scratchpad, or in the focus folder. */
function emptyMenu() {
  const dir = getFocus() || SCRATCH;
  const where = baseName(dir);
  return [
    { label: `New Page in ${where}`, iconSvg: icon('plus'), run: () => newPageIn(dir) },
    { label: `New Folder in ${where}`, iconSvg: icon('folderPlus'), run: () => newFolderIn(dir) },
  ];
}

/* ------------------------------------------------------------------ init */

export function initSidebar(node) {
  el = node;
  el.className = 'sidebar';
  el.innerHTML = '<div class="sb-scroll" tabindex="-1"></div>';
  scrollEl = el.querySelector('.sb-scroll');

  const saved = stateCache().sidebar || {};
  if (Array.isArray(saved.expanded)) expanded = new Set(saved.expanded.filter(Boolean));
  const savedPins = stateCache().pins;
  if (Array.isArray(savedPins)) pins = savedPins.filter((p) => typeof p === 'string' && p).map(clean);

  scrollEl.addEventListener('click', (e) => {
    const view = e.target.closest('.sb-view');
    if (view) { navigate({ type: 'view', name: view.dataset.view }); return; }
    const row = e.target.closest('.sb-row');
    if (!row) return;
    const path = row.dataset.path;
    if (row.dataset.kind === 'dir') {
      // A pinned folder reveals itself in the tree; a tree folder toggles.
      if (row.dataset.pin === '1') { revealFolder(path); return; }
      if (expanded.has(path)) expanded.delete(path); else expanded.add(path);
      persistExpanded();
      render();
      return;
    }
    if (row.dataset.md === '1') navigate({ type: 'page', path });
    else bridge.reveal(path).catch((err) => toast(err.message || err, 'err'));
  });

  scrollEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.sb-row:not(.sb-view)');
    e.preventDefault();
    if (row) contextMenu(e.clientX, e.clientY, menuFor(row.dataset.path, row.dataset.kind));
    else contextMenu(e.clientX, e.clientY, emptyMenu());
  });

  bindDnd(scrollEl);

  const onFs = debounce(() => refreshTree(), 350);
  bus.on('fs', onFs);
  bus.on('route', () => { const r = currentRoute(); if (r && r.type === 'page') expandAncestors(r.path); render(); scrollToCurrent(); });
  bus.on('booted', () => render());
  bus.on('focus', () => { render(); scrollToCurrent(); });

  commands.register({
    id: 'app.sidebar', title: 'Toggle sidebar', group: 'app',
    run: () => store.set('sidebar.open', !store.get('sidebar.open')),
  });

  refreshTree();
}

// Focus mode lives in focus.js; re-exported here so callers have one sidebar import.
export { getFocus, setFocus, exitFocus, isUnderFocus, defaultNewFolder } from './focus.js';
