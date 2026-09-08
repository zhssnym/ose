// Overlays: the one place a floating surface is created. The palette, settings, context menus
// and the prompt/confirm dialogs all sit on this stack so Esc, click-outside and focus
// restoration behave identically. Nobody in the app calls window.prompt/alert/confirm.
import { esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { icon } from './icons.js';
import { isHiddenName, titleOf } from './paths.js';
import { highlight, pageItems } from './fuzzy.js';

const stack = [];

export function overlayCount() { return stack.length; }
export function closeTopOverlay() { stack[stack.length - 1]?.close(); }
/**
 * The element that had focus before any overlay opened, or the active element when none is
 * open. Commands that act on "the focused tree row" ask here: the palette's `when` guards run
 * while the palette input itself holds focus, and the row they should see is the one focus
 * will be handed back to when the palette closes (CONTRACT.md batch 9, D3).
 */
export function focusOrigin() {
  return stack.length ? stack[0].prevFocus : document.activeElement;
}
/**
 * The sidebar rebuilds its rows while a dialog is open (an fs event lands mid-confirm); the
 * node focus would go back to is then detached. It tells us the replacement here (B4).
 */
export function retargetFocusOrigin(el) {
  if (stack.length && el) stack[0].prevFocus = el;
}
export function overlayHasInputFocus() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  const a = document.activeElement;
  return !!a && top.el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * openOverlay({ width, top, at:{x,y}, dim, className, onClose })
 * Returns { el, box, close }. `box` is the .surface to fill.
 */
export function openOverlay(opts = {}) {
  const { width = 420, top = null, at = null, dim = true, className = '', onClose = null } = opts;

  const prevFocus = document.activeElement;
  const el = document.createElement('div');
  el.className = 'ov' + (dim ? ' ov-dim' : '') + (at ? ' ov-at' : '');

  const box = document.createElement('div');
  box.className = 'surface ov-box ' + className;
  box.setAttribute('role', 'dialog');
  box.tabIndex = -1;
  if (width) box.style.width = typeof width === 'number' ? width + 'px' : width;
  if (top) box.style.marginTop = '0';
  el.appendChild(box);

  const entry = { el, box, close, prevFocus };
  stack.push(entry);
  document.body.appendChild(el);

  if (at) {
    // Place at a point, flipped back inside the viewport.
    box.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      const r = box.getBoundingClientRect();
      const x = Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4));
      const y = Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4));
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      box.style.visibility = '';
    });
  } else if (top) {
    el.style.alignItems = 'flex-start';
    el.style.paddingTop = typeof top === 'number' ? top + 'px' : top;
  }

  el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
  el.addEventListener('contextmenu', (e) => { if (e.target === el) { e.preventDefault(); close(); } });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...box.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // Every `.menu` surface (the context menu today) is a list of `.menu-row` buttons, and a
  // list of buttons is arrow-keyed, not tabbed (D4). Enter and Space are the buttons' own.
  if (/\bmenu\b/.test(className)) bindMenuKeys(box);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    el.remove();
    try { onClose && onClose(); } catch (e) { console.error(e); }
    // `entry.prevFocus`, not the captured const: retargetFocusOrigin may have swapped it.
    const back = entry.prevFocus;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
  }

  return entry;
}

/**
 * Menu keys: Up/Down wrap, Home/End, and a letter jumps to the next row whose label starts
 * with it (cycling, so pressing it again moves on). Chords are left alone: the shell's window
 * listener has already had them, and anything with a modifier is not a letter jump.
 */
function bindMenuKeys(box) {
  const rows = () => [...box.querySelectorAll('.menu-row')].filter((n) => !n.disabled && n.offsetParent !== null);
  box.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const list = rows();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % list.length;
    else if (e.key === 'ArrowUp') next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key.length === 1 && e.key !== ' ') {
      const ch = e.key.toLowerCase();
      const starts = (n) => (n.textContent || '').trim().toLowerCase().startsWith(ch);
      for (let i = 1; i <= list.length; i++) {
        const n = (at + i) % list.length;
        if (starts(list[n])) { next = n; break; }
      }
      if (next < 0) return;
    } else return;
    e.preventDefault();
    list[next].focus();
  });
}

function dialogShell(box, { title, danger }) {
  box.classList.add('dlg');
  box.innerHTML = `
    <div class="dlg-head">${esc(title || '')}</div>
    <div class="dlg-body"></div>
    <div class="dlg-foot">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok"></button>
    </div>`;
  return {
    body: box.querySelector('.dlg-body'),
    cancel: box.querySelector('[data-act="cancel"]'),
    ok: box.querySelector('[data-act="ok"]'),
  };
}

export function prompt({ title = 'Rename', value = '', placeholder = '', ok = 'OK', body = '' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = openOverlay({ width: 420, className: 'dlg-ov', onClose: () => { if (!done) { done = true; resolve(null); } } });
    const parts = dialogShell(ov.box, { title });
    parts.ok.textContent = ok;
    parts.body.innerHTML = (body ? `<p class="dlg-text">${esc(body)}</p>` : '') + `<input class="input" type="text" spellcheck="false">`;
    const input = parts.body.querySelector('input');
    input.value = value;
    input.placeholder = placeholder;
    parts.ok.addEventListener('click', () => finish(input.value.trim() || null));
    parts.cancel.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); }
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}

export function confirm({ title = 'Are you sure?', body = '', ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = openOverlay({ width: 400, className: 'dlg-ov', onClose: () => { if (!done) { done = true; resolve(false); } } });
    const parts = dialogShell(ov.box, { title, danger });
    parts.ok.textContent = ok;
    parts.body.innerHTML = body ? `<p class="dlg-text">${esc(body)}</p>` : '';
    parts.ok.addEventListener('click', () => finish(true));
    parts.cancel.addEventListener('click', () => finish(false));
    // On the OK button only: on the whole box this fired with Cancel focused too, which
    // turned Enter-to-dismiss into Enter-to-delete.
    parts.ok.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } });
    requestAnimationFrame(() => parts.ok.focus());
  });
}

/* ------------------------------------------------------------------ folder picker */

// A local subsequence matcher so this file stays free of a palette import (palette.js
// imports this one). Same idea, fewer bonuses: enough to rank a path list.
function fuzzyPath(text, q) {
  if (!q) return 0;
  const t = text.toLowerCase();
  let ti = 0, score = 0;
  for (let i = 0; i < q.length; i++) {
    const at = t.indexOf(q[i], ti);
    if (at < 0) return null;
    score += at === ti ? 6 : 2;
    if (at === 0 || /[\s/\\._-]/.test(t[at - 1])) score += 4;
    ti = at + 1;
  }
  return score - text.length * 0.05;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'accent' });

/** Every folder in the vault, root first, as vault-relative paths ('' is the root). */
async function vaultFolders() {
  const out = [''];
  let tree = null;
  try { tree = await bridge.tree(); } catch { return out; }
  const walk = (n) => {
    if (!n || !n.children) return;
    const dirs = n.children.filter((c) => c.kind === 'dir' && !isHiddenName(c.name));
    dirs.sort(byName);
    for (const d of dirs) { out.push(d.path); walk(d); }
  };
  walk(tree);
  return out;
}

/** Every file in the vault, folder by folder, limited to `exts` (lowercase, no dot). */
async function vaultFiles(exts) {
  const out = [];
  let tree = null;
  try { tree = await bridge.tree(); } catch { return out; }
  const ok = (name) => {
    if (!exts || !exts.length) return true;
    const i = name.lastIndexOf('.');
    return i > 0 && exts.includes(name.slice(i + 1).toLowerCase());
  };
  const walk = (n) => {
    if (!n || !n.children) return;
    const kids = n.children.filter((c) => !isHiddenName(c.name));
    const files = kids.filter((c) => c.kind === 'file' && ok(c.name)).sort(byName);
    const dirs = kids.filter((c) => c.kind === 'dir').sort(byName);
    for (const f of files) out.push(f.path);
    for (const d of dirs) walk(d);
  };
  walk(tree);
  return out;
}

/**
 * The picker both pickFolder and pickFile are: a `.surface` list of vault paths, fuzzy-filtered,
 * arrows to move, Enter to confirm, Esc to cancel. Resolves to a vault-relative path or `null`,
 * so callers must test `=== null`, not falsiness (the vault root is the empty string).
 */
function pickPath({ title, all, current, iconName, mode, enterLabel, rootLabel, empty }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = openOverlay({ width: 560, top: '15vh', className: 'pal pick', onClose: () => { if (!done) { done = true; resolve(null); } } });
    ov.box.innerHTML = `
      <div class="pal-head">
        <span class="pal-icon">${icon(iconName)}</span>
        <input class="pal-input" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(title)}" aria-label="${esc(title)}">
      </div>
      <div class="pal-list" role="listbox"></div>
      <div class="pal-foot mono-sm">
        <span><span class="kbd">↑</span><span class="kbd">↓</span> move</span>
        <span><span class="kbd">Enter</span> ${esc(enterLabel)}</span>
        <span><span class="kbd">Esc</span> cancel</span>
        <span class="grow"></span>
        <span class="pal-mode">${esc(mode)}</span>
      </div>`;

    const input = ov.box.querySelector('.pal-input');
    const list = ov.box.querySelector('.pal-list');
    let items = all;
    let sel = 0;

    function build() {
      const q = input.value.trim().toLowerCase();
      if (!q) items = all;
      else {
        items = all
          .map((p) => ({ p, s: fuzzyPath(p || rootLabel, q) }))
          .filter((x) => x.s !== null)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.p);
      }
      sel = Math.max(0, items.indexOf(current) >= 0 && !q ? items.indexOf(current) : 0);
      paint();
    }

    function paint() {
      list.textContent = '';
      if (!items.length) { list.innerHTML = `<div class="empty">${esc(empty)}</div>`; return; }
      const frag = document.createDocumentFragment();
      items.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'row pal-row' + (i === sel ? ' active' : '');
        row.dataset.i = i;
        row.setAttribute('role', 'option');
        // No glyph per row: the head's icon already says what kind of thing is listed, and the
        // page picker and Ctrl+P draw their rows without one (E13).
        row.innerHTML = `<span class="grow">${esc(p || rootLabel)}</span>`
          + (p === current ? '<span class="pal-hint">current</span>' : '');
        frag.appendChild(row);
      });
      list.appendChild(frag);
      list.querySelector('.pal-row.active')?.scrollIntoView({ block: 'nearest' });
    }

    function move(d) {
      if (!items.length) return;
      sel = (sel + d + items.length) % items.length;
      paint();
    }

    input.addEventListener('input', build);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items.length) finish(items[sel]); }
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.pal-row');
      if (!row) return;
      finish(items[+row.dataset.i]);
    });
    list.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.pal-row');
      if (!row || +row.dataset.i === sel) return;
      sel = +row.dataset.i;
      list.querySelectorAll('.pal-row').forEach((n, i) => n.classList.toggle('active', i === sel));
    });

    build();
    requestAnimationFrame(() => input.focus());
  });
}

/**
 * Folder picker (move to…, and the `plans` source). Resolves to a vault-relative path, `''`
 * for the vault root, or `null` when cancelled. `hide` drops a subtree from the list so a
 * folder cannot be moved into itself.
 */
export async function pickFolder({ title = 'Move to…', current = null, hide = null } = {}) {
  const all = (await vaultFolders()).filter((p) => !hide || (p !== hide && !p.startsWith(hide + '/')));
  return pickPath({
    title, all, current,
    iconName: 'folder', mode: 'folders', enterLabel: 'move here',
    rootLabel: 'vault root', empty: 'no folder matches',
  });
}

/**
 * File picker: the same surface, listing files. `ext` limits it and takes 'md', '.jsonl',
 * 'md,txt' or an array of those. Resolves to a vault-relative path or `null`.
 */
export async function pickFile({ title = 'Choose a file…', ext = null, current = null } = {}) {
  const exts = (Array.isArray(ext) ? ext : String(ext ?? '').split(','))
    .map((e) => String(e).trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  const all = await vaultFiles(exts);
  return pickPath({
    title, all, current,
    iconName: 'page', mode: exts.length ? exts.map((e) => '.' + e).join(' ') : 'files',
    enterLabel: 'choose', rootLabel: 'vault root', empty: 'no file matches',
  });
}

/* -------------------------------------------------------------------- page picker */

// The page list and the recent list belong to the sidebar and the router, and both of those
// import this file. A dynamic import at call time keeps the module graph acyclic and costs
// nothing: by the time anybody picks a page, both modules are long since evaluated.
async function quickOpenData() {
  const [sidebar, router] = await Promise.all([import('./sidebar.js'), import('./router.js')]);
  let recent = [];
  try { recent = router.recentFiles(); } catch { /* no history yet */ }
  return { paths: sidebar.allPages(), recent };
}

/**
 * Pick a markdown page: the quick-open list, the quick-open matcher, Enter to confirm.
 * Resolves to the vault-relative path of the page, or `null` when cancelled.
 * Used by the editor's `Link` slash item and the `page.link` command (CONTRACT.md batch 5).
 */
export async function pickPage({ title = 'Link a page…', current = null } = {}) {
  const { paths, recent } = await quickOpenData();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = openOverlay({ width: 560, top: '15vh', className: 'pal pick', onClose: () => { if (!done) { done = true; resolve(null); } } });
    ov.box.innerHTML = `
      <div class="pal-head">
        <span class="pal-icon">${icon('page')}</span>
        <input class="pal-input" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(title)}" aria-label="${esc(title)}">
      </div>
      <div class="pal-list" role="listbox"></div>
      <div class="pal-foot mono-sm">
        <span><span class="kbd">↑</span><span class="kbd">↓</span> move</span>
        <span><span class="kbd">Enter</span> link</span>
        <span><span class="kbd">Esc</span> cancel</span>
        <span class="grow"></span>
        <span class="pal-mode">pages</span>
      </div>`;

    const input = ov.box.querySelector('.pal-input');
    const list = ov.box.querySelector('.pal-list');
    let items = [];
    let sel = 0;

    function build() {
      const q = input.value.trim();
      items = pageItems(paths, q, { recent });
      const at = current ? items.findIndex((it) => it.path === current) : -1;
      sel = !q && at > 0 ? at : 0;
      paint();
    }

    function paint() {
      list.textContent = '';
      if (!items.length) { list.innerHTML = '<div class="empty">no page matches</div>'; return; }
      const frag = document.createDocumentFragment();
      items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'row pal-row' + (i === sel ? ' active' : '');
        row.dataset.i = i;
        row.setAttribute('role', 'option');
        row.innerHTML = `<span class="grow">${highlight(it.title, it.hits)}</span>`
          + (it.hint ? `<span class="pal-hint">${esc(it.hint)}</span>` : '')
          + (it.path === current ? '<span class="pal-hint">current</span>' : '');
        frag.appendChild(row);
      });
      list.appendChild(frag);
      list.querySelector('.pal-row.active')?.scrollIntoView({ block: 'nearest' });
    }

    function move(d) {
      if (!items.length) return;
      sel = (sel + d + items.length) % items.length;
      paint();
    }

    input.addEventListener('input', build);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items.length) finish(items[sel].path); }
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.pal-row');
      if (!row) return;
      finish(items[+row.dataset.i].path);
    });
    list.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.pal-row');
      if (!row || +row.dataset.i === sel) return;
      sel = +row.dataset.i;
      list.querySelectorAll('.pal-row').forEach((n, i) => n.classList.toggle('active', i === sel));
    });

    build();
    requestAnimationFrame(() => input.focus());
  });
}

/**
 * The title a link to `path` should carry: the file's first H1, else the file name.
 * One read, no cache: it is called once per inserted link. Never throws — a file that cannot
 * be read falls back to its name, which is what the old behaviour was anyway.
 */
export async function pageTitle(path) {
  const fallback = titleOf(path);
  if (!path) return fallback;
  try {
    let text = await bridge.readText(path);
    if (typeof text !== 'string') return fallback;
    // YAML frontmatter is not content; an H1 inside it would not be one.
    if (/^---\r?\n/.test(text)) {
      const end = text.search(/\r?\n---[ \t]*(\r?\n|$)/);
      if (end >= 0) text = text.slice(text.indexOf('\n', end + 1) + 1);
    }
    const m = text.match(/^[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/m);
    const h1 = m && m[1].trim();
    return h1 || fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ clipboard */

/**
 * Put text on the clipboard. `navigator.clipboard` needs a secure context, which both the dev
 * server (127.0.0.1) and the host give us; the textarea fallback is there so a copy never
 * silently does nothing. Resolves true when the text went somewhere.
 */
export async function copyText(text) {
  const s = String(text ?? '');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* fall through to the old way */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (e) {
    console.error('[shell] copy', e);
    return false;
  }
}

/**
 * Context menu: items are {label, iconSvg?, shortcut?, danger?, sep?, run()}. Arrow keys,
 * Home/End and letter jumps come from openOverlay's `.menu` handling; Esc from the shell.
 */
export function contextMenu(x, y, items) {
  const ov = openOverlay({ at: { x, y }, dim: false, width: null, className: 'menu' });
  ov.box.setAttribute('role', 'menu');
  const frag = document.createDocumentFragment();
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { const d = document.createElement('div'); d.className = 'divider'; frag.appendChild(d); continue; }
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute('role', 'menuitem');
    row.className = 'row menu-row' + (it.danger ? ' danger' : '');
    row.innerHTML = `${it.iconSvg || ''}<span class="grow">${esc(it.label)}</span>`
      + (it.shortcut ? `<span class="kbd">${esc(it.shortcut)}</span>` : '');
    row.addEventListener('click', () => { ov.close(); Promise.resolve().then(() => it.run && it.run()); });
    frag.appendChild(row);
  }
  ov.box.appendChild(frag);
  requestAnimationFrame(() => ov.box.querySelector('.menu-row')?.focus());
  return ov;
}

/* ------------------------------------------------------------------ toasts */

// Newest last in the DOM, so `dismissToast` pops the last child. The host is a live region:
// a screen reader hears a save error the way a sighted user sees it (D10).
let toastHost = null;

/** Transient message above the status bar. Errors surface here instead of being swallowed. */
export function toast(text, kind = 'info', ms = 4500) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const t = document.createElement('div');
  t.className = 'toast surface ' + kind;
  t.textContent = String(text);
  toastHost.appendChild(t);
  const kill = () => {
    clearTimeout(timer);
    t.remove();
    if (toastHost && !toastHost.childElementCount) { toastHost.remove(); toastHost = null; }
  };
  t.__kill = kill;
  // Hovering pauses the clock: a message being read must not vanish under the pointer. On
  // leave it gets what was left, and never less than a second to finish the line.
  let timer = setTimeout(kill, ms);
  let left = ms, since = Date.now();
  t.addEventListener('mouseenter', () => { clearTimeout(timer); left = Math.max(0, left - (Date.now() - since)); });
  t.addEventListener('mouseleave', () => { since = Date.now(); timer = setTimeout(kill, Math.max(1000, left)); });
  t.addEventListener('click', kill);
  return kill;
}

/** Esc with no overlay open (keys.js): drop the newest toast. True when there was one. */
export function dismissToast() {
  const t = toastHost && toastHost.lastElementChild;
  if (!t) return false;
  t.__kill();
  return true;
}
