// Part of the folder view (./folder.js). The view: the folder view around its list, where up is,
// and its registration.

import { ose } from 'ose:core';
import { esc, icon, toast } from 'ose:ui';
import * as M from './folder-model.js';
import * as fops from './fileops.js';
import { baseName, clean, dirName, vaultName } from './paths.js';
import {
  bus, commands, folderName, folderRoute, iconSvg, route, showHidden,
} from './folder-sort.js';
import { createList } from './folder-list.js';

/* ------------------------------------------------------------------ small pieces */

export function isCut(path) {
  const c = fops.clipboard();
  return !!c && c.mode === 'cut' && c.paths.some((p) => clean(p) === clean(path));
}

export function hasClipboard() {
  const c = fops.clipboard();
  return !!c && c.paths.length > 0;
}

export const canUndo = () => ose.fileops.journal.canUndo();

function newFileHere(path) { void fops.newFile({ path: clean(path), kind: 'dir' }); }

function newFolderHere(path) { void fops.newFolder(clean(path)); }

/**
 * A menu row from a registered command: its title, its icon and its chord, as the palette and
 * the tree's menu say them, run with `arg` (the rows the menu is for, or a folder path).
 * `chord` names the list's own key for a command the keymap does not bind (Ctrl+X is the
 * list's, so the editor keeps its own); `run` replaces the command's own run for a row that
 * must act on several rows where the command takes one (Pin).
 * @param {string} id
 * @param {*} arg
 * @param {{chord?: string, run?: (() => unknown)|null}} [opts]
 * @returns {object|null} null when the command is not registered
 */
export function commandItem(id, arg, { chord = '', run = null } = {}) {
  const c = commands.get(id);
  if (!c) return null;
  return {
    label: c.title,
    iconSvg: c.icon ? icon(c.icon) : '',
    shortcut: ose.keys.shortcutFor(id) || (chord ? ose.keys.label(chord) : ''),
    danger: id === 'file.trash',
    run: () => {
      const failed = (e) => { console.error('[folder] menu', id, e); toast(String((e && e.message) || e), 'err', 0); };
      try {
        const out = run ? run() : c.run(arg);
        if (out && typeof out.then === 'function') out.then(null, failed);
      } catch (e) { failed(e); }
    },
  };
}

/** The box a folder that cannot be listed gets, in the router's own miss shape. */
export function missHtml(err, path) {
  const denied = err.code === 'permission' || err.code === 'denied' || /denied|permission/i.test(err.message);
  const title = err.code === 'not_found' ? 'This folder is not there'
    : err.code === 'escapes_vault' ? 'This folder is outside the vault'
      : denied ? 'No permission to open this folder'
        : 'This folder could not be read';
  const up = M.parentOf(path);
  return `<div class="miss fv-miss">
    <div class="miss-title">${esc(title)}</div>
    <div class="miss-path mono">${esc(clean(path) || vaultName())}</div>
    ${err.message && err.code !== 'not_found' ? `<div class="miss-why">${esc(err.message)}</div>` : ''}
    ${up != null ? '<button type="button" class="btn fv-up">Go to parent folder</button>' : ''}
  </div>`;
}

export function wireMiss(box, path) {
  const b = box.querySelector('.fv-up');
  if (b) b.addEventListener('click', () => void route.navigate(folderRoute(M.parentOf(path), baseName(path))));
}

/* ------------------------------------------------------------------ the view */

// The one folder view on screen, if any: what the toolbar commands act on.
let current = null;

function toolButton(cls, iconName, fallback, label, title) {
  return `<button type="button" class="btn sm ghost fv-tool ${cls}" title="${esc(title || label)}">${iconSvg(iconName, fallback)}<span>${esc(label)}</span></button>`;
}

/**
 * The folder view, drawn into the page column's scroller: the header, the toolbar, the list
 * and the README under it. Answers the handle the router keeps (docs/CORE.md "Folders").
 * @param {HTMLElement} el
 * @param {string} path
 * @param {{select?: string, scrollTop?: number}} [opts]
 * @returns {Promise<{unmount: Function, refresh: Function, selection: Function}>}
 */
async function openFolder(el, path, opts = {}) {
  const p = clean(path);
  const root = document.createElement('div');
  root.className = 'page-col folder-view';
  root.innerHTML = `
    <div class="fv-head">
      <h1 class="page-title fv-title"></h1>
      <span class="fv-count mono-sm"></span>
    </div>
    <div class="fv-tools" role="toolbar" aria-label="Folder">
      ${toolButton('fv-new', 'plus', 'plus', 'New file', 'New file…')}
      ${toolButton('fv-mkdir', 'folderPlus', 'folder', 'New folder')}
      ${toolButton('fv-paste', 'clipboard', 'copy', 'Paste')}
      ${toolButton('fv-undo', 'undo', 'back', 'Undo')}
      <span class="fv-tools-gap"></span>
      ${toolButton('fv-hidden', 'eye', 'view', 'Show hidden items')}
    </div>
    <div class="fv-body"></div>
    <div class="fv-readme" hidden>
      <div class="fv-readme-head"><span class="fv-readme-name mono-sm"></span><button type="button" class="btn sm ghost fv-edit">Edit</button></div>
      <div class="fv-readme-body"></div>
    </div>`;
  el.appendChild(root);

  // Drawn just above, as is everything this function looks up in `root`.
  const titleEl = /** @type {HTMLElement} */ (root.querySelector('.fv-title'));
  const countEl = /** @type {HTMLElement} */ (root.querySelector('.fv-count'));
  titleEl.textContent = folderName(p);
  titleEl.title = p || vaultName();

  const btn = (c) => /** @type {HTMLElement} */ (root.querySelector('.' + c));
  const tools = {
    paste: btn('fv-paste'), undo: btn('fv-undo'), hidden: btn('fv-hidden'),
  };
  // The chords are said in the tooltips, never on the buttons: the bar is chrome.
  const chordTitle = (b, label, id) => {
    const chord = ose.keys.shortcutFor(id);
    b.title = chord ? `${label} (${chord})` : label;
  };
  chordTitle(btn('fv-new'), 'New file…', 'file.new');
  chordTitle(btn('fv-mkdir'), 'New folder', 'tree.new-folder');
  btn('fv-new').addEventListener('click', () => newFileHere(p));
  btn('fv-mkdir').addEventListener('click', () => newFolderHere(p));
  tools.paste.addEventListener('click', () => void fops.paste(p));
  tools.undo.addEventListener('click', () => void fops.undo());
  tools.hidden.addEventListener('click', () => toggleHidden());

  let readmeFor = null;
  let readmeSeq = 0;

  function syncTools(list) {
    const n = list ? list.count : 0;
    countEl.textContent = list && !list.error ? `${n} item${n === 1 ? '' : 's'}` : '';
    tools.paste.hidden = !hasClipboard();
    tools.undo.hidden = !canUndo();
    const on = showHidden();
    tools.hidden.setAttribute('aria-pressed', on ? 'true' : 'false');
    tools.hidden.classList.toggle('on', on);
    tools.hidden.innerHTML = `${iconSvg(on ? 'eye' : 'eyeOff', 'view')}<span>Show hidden items</span>`;
  }

  const body = root.querySelector('.fv-body');
  let dead = false;
  const list = createList(body, p, {
    select: opts.select || null,
    onChange: () => syncTools(list),
    onLoad: () => { syncTools(list); void drawReadme(); },
  });

  /** The README under the list: the first of README.md, readme.md, index.md, read-only. */
  async function drawReadme() {
    const box = /** @type {HTMLElement} */ (root.querySelector('.fv-readme'));
    const part = (c) => /** @type {HTMLElement} */ (box.querySelector(c));
    // Every entry, hidden ones too: a folder's README is its own page whatever its attributes.
    const hit = M.readmeOf(list.error ? [] : list.entries());
    const key = hit ? `${hit.path}:${hit.mtime}:${hit.size}` : null;
    if (key === readmeFor) return;
    readmeFor = key;
    const my = ++readmeSeq;
    if (!hit) { box.hidden = true; part('.fv-readme-body').textContent = ''; return; }
    let text = '';
    let render = null;
    try {
      const [t, ed] = await Promise.all([ose.files.read(hit.path), import('ose:editor')]);
      text = t;
      render = ed.render;
    } catch (e) {
      console.warn('[folder] readme', e);
      if (my === readmeSeq) box.hidden = true;
      return;
    }
    if (my !== readmeSeq || dead) return;
    part('.fv-readme-name').textContent = hit.name;
    const edit = part('.fv-edit');
    edit.onclick = () => void route.navigate({ type: 'page', path: hit.path });
    edit.title = `Edit ${hit.name}`;
    const out = part('.fv-readme-body');
    out.textContent = '';
    try {
      out.appendChild(render(text, {
        basePath: hit.path,
        onLink: (target, heading) => void followLink(target, heading),
      }));
    } catch (e) {
      console.warn('[folder] readme render', e);
      out.textContent = text;
    }
    box.hidden = false;
  }

  const me = {
    path: p,
    list,
    toggleHidden,
  };
  current = me;

  const offs = [
    bus.on('fileops:journal', () => syncTools(list)),
    bus.on('settings', () => syncTools(list)),
  ];

  await list.ready;
  syncTools(list);
  // The router keeps the scroll per route; the host puts it back once the rows exist.
  if (typeof opts.scrollTop === 'number' && opts.scrollTop > 0) {
    const top = opts.scrollTop;
    const scroller = el.closest('.main-scroll') || el;
    requestAnimationFrame(() => { if (scroller.isConnected) scroller.scrollTop = top; });
  }

  return {
    unmount() {
      dead = true;
      readmeSeq++;
      for (const off of offs) { try { off && off(); } catch { /* gone */ } }
      list.unmount();
      if (current === me) current = null;
      root.remove();
    },
    refresh() { void list.refresh(); syncTools(list); },
    selection: () => list.selection(),
  };
}

/** Follow a link out of a README: a folder opens as a folder, anything else as a page. */
async function followLink(target, heading) {
  let kind = 'file';
  try { const s = await ose.files.stat(target); if (s && s.kind === 'dir') kind = 'dir'; } catch { /* a page route decides */ }
  if (kind === 'dir') void route.navigate(folderRoute(target));
  else void route.navigate(heading ? { type: 'page', path: target, heading } : { type: 'page', path: target });
}

/** Show hidden items: the tree's command, so there is one toggle and it says one thing. */
const toggleHidden = () => commands.run('view.toggle-hidden');

/* ------------------------------------------------------------------ where "up" is */

/** The route one step up from `r`: a folder's parent, a page's folder; null otherwise. */
export function upFrom(r) {
  if (!r) return null;
  if (r.type === 'folder') {
    const up = M.parentOf(r.path);
    return up == null ? null : folderRoute(up, baseName(r.path));
  }
  if (r.type === 'page' && r.path) return folderRoute(dirName(r.path), baseName(r.path));
  return null;
}

/* ------------------------------------------------------------------ registration */

/**
 * Register the folder host and the folder commands. `boot.js` calls it before `ose.init`, so
 * the router can draw a folder route from its first navigation.
 */
export function initFolder() {
  ose.setFolderHost({ open: (el, path, opts) => openFolder(el, path, opts || {}) });

  commands.register({
    id: 'folder.up', title: 'Go to parent folder', group: 'navigate',
    hint: 'the folder this page or folder is in',
    when: () => !!upFrom(route.current()),
    run: () => { const r = upFrom(route.current()); if (r) return route.navigate(r); return undefined; },
  });
  commands.register({
    id: 'folder.show-current', title: 'Show in folder', group: 'navigate',
    hint: 'the page on screen, selected in its folder',
    when: () => { const r = route.current(); return !!r && r.type === 'page'; },
    run: () => { const r = upFrom(route.current()); if (r) return route.navigate(r); return undefined; },
  });

  commands.register({
    id: 'folder.open-root', title: 'Open vault folder', group: 'navigate',
    hint: 'the vault root as a folder',
    run: () => route.navigate(folderRoute('')),
  });
}
