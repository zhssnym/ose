// The page editor: a markdown file rendered as a Notion-style column.
//
//   properties strip   only when the file has YAML frontmatter, read-only, raw text preserved
//   title              the file's first H1, editable; the file name when there is no H1
//   meta               folder, word count, last save
//   body               Crepe (Milkdown) over everything after the title
//
// Markdown is the source of truth. Nothing is written on open; a save happens only after the
// user has actually typed, and only when the composed text differs from what is on disk.

import { bus, commands, status, store } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { navigate, clearRoute, defaultNewFolder } from '../shell/index.js';
import { prompt, confirm, patchState } from './deps.js';
import { makeCrepe, readMarkdown, editorView } from './crepe.js';
import { TextSelection } from '@milkdown/kit/prose/state';
import { parseDoc, composeDoc, countWords, detectLang } from './doc.js';
import * as P from './paths.js';
import './editor.css';

const SAVE_DEBOUNCE = 600;

/** @type {null | ReturnType<typeof blankPage>} */
let page = null;
let openToken = 0;
let initialised = false;

const blankPage = () => ({
  path: '', doc: null, title: '', baseline: '',
  el: null, host: null, titleEl: null, metaEl: null, bodyEl: null, crepe: null,
  dirty: false, touched: false, ready: false,
  saveTimer: 0, savedAt: null, selfWriteAt: 0, saving: null,
  cleanups: [],
});

// ---------------------------------------------------------------------------
// public API (CONTRACT.md)

export function getOpenPath() {
  return page ? page.path : null;
}

export async function initEditor() {
  if (initialised) return;
  initialised = true;
  registerCommands();
  void loadShellKeymap();

  // The bridge facade already re-emits 'fs' onto the bus; listening to both would reload twice.
  bus.on('fs', onFsChange);
  bridge.on('window', (d) => { if (d && d.closing) void saveNow(); });
  window.addEventListener('beforeunload', () => { if (page && page.dirty) void saveNow(); });
}

export async function openPage(el, path) {
  const token = ++openToken;
  await closePage();
  if (token !== openToken) return;

  const p = blankPage();
  p.path = path;
  page = p;

  let text;
  try {
    text = await bridge.readText(path);
  } catch (e) {
    page = null;
    el.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = `cannot open ${path}: ${e.message || e}`;
    el.append(empty);
    status.set('path', path);
    status.set('doc', null);
    status.set('save', null);
    return;
  }
  if (token !== openToken) return;

  p.doc = parseDoc(text);
  p.title = p.doc.title;
  p.baseline = text;

  buildDom(p, el);
  updateMeta(p);
  status.set('path', path);
  status.set('save', null);

  p.crepe = await makeCrepe({
    root: p.bodyEl,
    markdown: p.doc.body,
    resolveImage: (src) => resolveImage(p, src),
    uploadImage: (file) => uploadImage(p, file),
    onChange: () => { if (p.ready) markDirty(p); },
    on: (api) => {
      api.blur(() => { if (p.dirty) void saveNow(); });
    },
  });
  if (token !== openToken) { await p.crepe.destroy().catch(() => {}); return; }

  wireEditorEvents(p);
  applySpellcheck(p);
  // Anything the editor does to the document while it is settling (the trailing plugin adds
  // an empty paragraph, node views mount) must not count as a user edit. Two frames is the
  // normal path; the timer is the fallback, because a hidden window fires no frames at all.
  const ready = () => { p.ready = true; };
  requestAnimationFrame(() => requestAnimationFrame(ready));
  setTimeout(ready, 80);

  void patchState({ editor: { last: path } });
}

export async function closePage() {
  const p = page;
  if (!p) return;
  page = null;
  clearTimeout(p.saveTimer);
  if (p.dirty) await saveDoc(p);
  for (const fn of p.cleanups) { try { fn(); } catch (e) { console.error(e); } }
  p.cleanups.length = 0;
  if (p.crepe) { try { await p.crepe.destroy(); } catch (e) { console.error('[editor] destroy', e); } }
  if (p.el && p.el.parentNode) p.el.remove();
  p.crepe = null;
  p.el = p.host = p.titleEl = p.metaEl = p.bodyEl = null;
  status.set('doc', null);
  status.set('save', null);
}

export async function saveNow() {
  if (!page) return;
  clearTimeout(page.saveTimer);
  await saveDoc(page);
}

// ---------------------------------------------------------------------------
// DOM

function buildDom(p, el) {
  el.innerHTML = '';
  const col = document.createElement('div');
  col.className = 'page-col ed';
  p.el = col;
  p.host = col;

  if (p.doc.frontmatterRaw) col.append(propertiesStrip(p));

  if (p.doc.titleLine !== null) {
    col.append(makeTitleEl(p, p.doc.title));
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'page-title untitled';
    wrap.textContent = P.stem(p.path);
    const add = document.createElement('button');
    add.className = 'ed-add-title';
    add.type = 'button';
    add.textContent = 'add title';
    add.title = 'Insert a level-1 heading at the top of the file';
    add.addEventListener('click', () => addTitle(p));
    wrap.append(add);
    col.append(wrap);
  }

  const meta = document.createElement('div');
  meta.className = 'page-meta';
  p.metaEl = meta;
  col.append(meta);

  const body = document.createElement('div');
  body.className = 'ed-body';
  p.bodyEl = body;
  col.append(body);

  el.append(col);
}

/** The editable H1. `plaintext-only` keeps pasted formatting out of a file's title line. */
function makeTitleEl(p, text) {
  const h1 = document.createElement('h1');
  h1.className = 'page-title';
  h1.contentEditable = 'plaintext-only';
  h1.spellcheck = false;
  h1.dataset.placeholder = 'Untitled';
  h1.textContent = text;
  h1.addEventListener('input', () => {
    p.title = h1.textContent.replace(/\s+/g, ' ').trim();
    p.touched = true;
    markDirty(p);
  });
  h1.addEventListener('keydown', onTitleKey);
  h1.addEventListener('blur', () => { if (p.dirty) void saveNow(); });
  p.titleEl = h1;
  return h1;
}

function propertiesStrip(p) {
  const rows = p.doc.frontmatter || [];
  const box = document.createElement('div');
  box.className = 'ed-props';

  const head = document.createElement('button');
  head.className = 'ed-props-head';
  head.type = 'button';
  head.setAttribute('aria-expanded', 'true');
  head.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'
    + `<span>properties</span><span class="ed-props-count">${rows.length}</span>`;

  const list = document.createElement('div');
  list.className = 'ed-props-list';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'ed-prop';
    const k = document.createElement('span');
    k.className = 'ed-prop-key';
    k.textContent = r.key;
    const v = document.createElement('span');
    v.className = 'ed-prop-val text-select';
    v.textContent = r.value;
    row.append(k, v);
    list.append(row);
  }
  head.addEventListener('click', () => {
    const open = box.classList.toggle('closed');
    head.setAttribute('aria-expanded', String(!open));
  });
  box.append(head, list);
  return box;
}

function onTitleKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    focusBody();
  } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault();
    focusBody();
  }
}

function focusBody() {
  const view = page && page.crepe ? editorView(page.crepe) : null;
  if (view) view.focus();
}

/** Give a file with no H1 one. A user action, never automatic. */
function addTitle(p) {
  const doc = p.doc;
  doc.titleLine = '# ';
  doc.title = '';
  doc.gap = doc.body.trim() ? '\n\n' : '\n';
  p.title = P.stem(p.path);
  p.touched = true;
  // Rebuild the header only; the editor keeps its document and its undo history.
  const h1 = makeTitleEl(p, p.title);
  p.el.querySelector('.page-title').replaceWith(h1);
  markDirty(p);
  h1.focus();
  const range = document.createRange();
  range.selectNodeContents(h1);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}

/**
 * Chromium spellchecks a contenteditable against the `lang` in effect on it, so the language
 * is decided per document and put on the page column; the editable root asks for checking
 * explicitly rather than relying on the inherited default.
 */
function applySpellcheck(p) {
  const lang = detectLang(`${p.title || ''} ${p.doc.body}`);
  p.el.setAttribute('lang', lang);
  const view = p.crepe ? editorView(p.crepe) : null;
  // WebView2 spellchecks with the Windows display language only (fr-FR here) and ignores
  // `lang`, so an English page would get every word underlined. Check only when the document's
  // language matches the checker's; see the batch-2 report in CONTRACT.md.
  const checkerLang = (navigator.language || 'fr').slice(0, 2);
  if (view && view.dom) {
    view.dom.setAttribute('spellcheck', String(lang === checkerLang));
    view.dom.setAttribute('lang', lang);
  }
}

// ---------------------------------------------------------------------------
// events inside the page

function wireEditorEvents(p) {
  const host = p.host;
  // `touched` means "the user has interacted with this page", and a save needs it as well as
  // a changed document. Mouse counts: ticking a task checkbox or dragging a block never
  // produces a key event. On its own it can never cause a write, because saveDoc also
  // requires a dirty document and text that differs from what is on disk.
  const touch = () => { p.touched = true; };
  for (const ev of ['keydown', 'beforeinput', 'paste', 'drop', 'cut', 'pointerdown']) {
    host.addEventListener(ev, touch, true);
    p.cleanups.push(() => host.removeEventListener(ev, touch, true));
  }
  host.addEventListener('pointerdown', onLinkPointerDown, true);
  host.addEventListener('click', onLinkClick, true);
  p.cleanups.push(() => host.removeEventListener('pointerdown', onLinkPointerDown, true));
  p.cleanups.push(() => host.removeEventListener('click', onLinkClick, true));
  // Some chords belong to the shell; CodeMirror inside a code block would otherwise eat them.
  host.addEventListener('keydown', guardShellKeys, true);
  p.cleanups.push(() => host.removeEventListener('keydown', guardShellKeys, true));
  // Notion behaviour: a click in the empty space below the last block puts the caret at the
  // end of the page instead of leaving the editor unfocused.
  const scroller = host.parentElement;
  const onBlankClick = (e) => {
    if (e.button !== 0) return;
    if (e.target !== host && e.target !== scroller && e.target !== p.bodyEl) return;
    const view = p.crepe ? editorView(p.crepe) : null;
    if (!view) return;
    e.preventDefault();
    const end = view.state.doc.content.size;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end), -1)));
    view.focus();
  };
  host.addEventListener('mousedown', onBlankClick);
  scroller && scroller.addEventListener('mousedown', onBlankClick);
  p.cleanups.push(() => { host.removeEventListener('mousedown', onBlankClick); scroller && scroller.removeEventListener('mousedown', onBlankClick); });
}

/**
 * The shell owns these chords (CONTRACT.md). This copy is only a fallback: initEditor pulls
 * the real map out of shell/keys.js so the two can never drift.
 */
let SHELL_KEYMAP = [
  { combo: 'ctrl+k', cmd: 'app.palette' }, { combo: 'ctrl+p', cmd: 'app.quickopen' },
  { combo: 'ctrl+n', cmd: 'page.new' }, { combo: 'ctrl+s', cmd: 'page.save' },
  { combo: 'ctrl+\\', cmd: 'app.sidebar' }, { combo: 'ctrl+j', cmd: 'claude.toggle' },
  { combo: 'ctrl+shift+f', cmd: 'app.search' }, { combo: 'ctrl+,', cmd: 'app.settings' },
  { combo: 'ctrl+shift+l', cmd: 'app.theme' },
  { combo: 'alt+arrowleft', cmd: 'app.back' }, { combo: 'alt+arrowright', cmd: 'app.forward' },
];

async function loadShellKeymap() {
  try {
    const m = await import('../shell/keys.js');
    if (Array.isArray(m.KEYMAP) && m.KEYMAP.length) SHELL_KEYMAP = m.KEYMAP;
  } catch { /* keep the fallback */ }
}

/** Same shape as the shell's comboOf: ctrl, then shift, then alt, then the lowercased key. */
function chordOf(e) {
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('ctrl');
  if (e.shiftKey) mods.push('shift');
  if (e.altKey) mods.push('alt');
  if (!mods.length) return null;
  return [...mods, String(e.key).toLowerCase()].join('+');
}

/**
 * ProseMirror binds none of the shell's chords, but CodeMirror inside a code block binds
 * Alt+Left/Right (move by word) and, on some platforms, Ctrl+K and Ctrl+P. It handles them on
 * its own content element, below this listener and below the shell's window listener, so the
 * event has to be stopped here — and the shell's command run in its place.
 */
function guardShellKeys(e) {
  if (!(e.target instanceof Element) || !e.target.closest('.cm-editor')) return;
  const combo = chordOf(e);
  if (!combo) return;
  const entry = SHELL_KEYMAP.find((k) => k.combo === combo);
  if (!entry) return;
  e.preventDefault();
  e.stopPropagation();
  commands.run(entry.cmd);
}

const anchorAt = (e) => (e.target instanceof Element ? e.target.closest('a[href], a.link-display') : null);
const inTooltip = (a) => !!a.closest('.milkdown-link-preview, .milkdown-link-edit');

/**
 * Ctrl/Cmd+click follows a link. It has to be caught on pointerdown: ProseMirror treats
 * Ctrl+mousedown as "select this node", re-renders the paragraph, and by the time the click
 * event arrives its target is the paragraph and the anchor is gone.
 */
function onLinkPointerDown(e) {
  if (!page || e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
  const a = anchorAt(e);
  if (!a || inTooltip(a)) return;
  const href = (a.getAttribute('href') || '').trim();
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  void followLink(href);
}

/**
 * The link tooltip's own open action. Crepe renders it as `<a target="_blank">`, which would
 * take the whole app with it, so it is always intercepted. A plain click in the text is left
 * alone: it must still place the caret.
 */
function onLinkClick(e) {
  if (!page) return;
  const a = anchorAt(e);
  if (!a) return;
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); return; }
  if (!inTooltip(a)) return;
  const href = (a.textContent || a.getAttribute('href') || '').trim();
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  void followLink(href);
}

async function followLink(href) {
  if (!page) return;
  if (P.isExternal(href)) { await bridge.openExternal(href); return; }
  const target = P.resolveHref(page.path, href);
  if (!target) return;
  if (/\.md$/i.test(target)) {
    if (await bridge.exists(target)) navigate({ type: 'page', path: target });
    else status.set('save', `no such page: ${target}`);
    return;
  }
  await bridge.reveal(target);
}

// ---------------------------------------------------------------------------
// images

function resolveImage(p, src) {
  const s = String(src || '');
  if (!s || P.isExternal(s) || s.startsWith('blob:')) return s;
  const target = P.resolveHref(p.path, s);
  return target ? bridge.assetUrl(target) : s;
}

const readAsBase64 = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onerror = () => reject(fr.error || new Error('read failed'));
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
  fr.readAsDataURL(file);
});

/**
 * Pasted or dropped images land in `<page folder>/attachments/<yyyy-mm-dd>-<slug>.<ext>` and
 * the markdown gets a path relative to the page, so the folder stays portable.
 */
async function uploadImage(p, file) {
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(file.name || '') || [])[1]
    || (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const base = `${P.today()}-${P.slugify(P.stem(file.name || 'image'))}`;
  const folder = P.joinPath(P.dirname(p.path), 'attachments');
  let target = `${folder}/${base}.${ext.toLowerCase()}`;
  for (let n = 2; await bridge.exists(target); n++) target = `${folder}/${base}-${n}.${ext.toLowerCase()}`;
  await bridge.writeBinary(target, await readAsBase64(file));
  p.touched = true;
  return P.relativeHref(p.path, target);
}

// ---------------------------------------------------------------------------
// saving

function markDirty(p) {
  if (p !== page) return;
  // Editor-internal normalisation (tables, trailing paragraph) is not a user edit: no dirty
  // state, no "unsaved" in the status bar, until the user has actually interacted with the page.
  if (!p.touched) return;
  if (!p.dirty) {
    p.dirty = true;
    bus.emit('doc:dirty', { path: p.path, dirty: true });
    status.set('save', 'unsaved');
  }
  updateMeta(p);
  clearTimeout(p.saveTimer);
  p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
}

function compose(p) {
  const body = readMarkdown(p.crepe, p.doc.body);
  return composeDoc(p.doc, { title: p.title, body });
}

async function saveDoc(p) {
  if (!p || !p.crepe) return;
  clearTimeout(p.saveTimer);
  // Never write a file the user has not touched, whatever the editor thinks it changed while
  // mounting node views.
  if (!p.dirty || !p.touched) return;
  if (p.saving) { await p.saving; }

  let text;
  try {
    text = compose(p);
  } catch (e) {
    console.error('[editor] serialise', e);
    status.set('save', 'serialise failed, not saved');
    return;
  }
  if (text === p.baseline) {
    p.dirty = false;
    bus.emit('doc:dirty', { path: p.path, dirty: false });
    status.set('save', p.savedAt ? 'saved ' + p.savedAt : null);
    return;
  }

  p.saving = (async () => {
    p.selfWriteAt = Date.now();
    await bridge.writeText(p.path, text);
    p.baseline = text;
    p.doc = parseDoc(text);
    p.title = p.doc.titleLine !== null ? p.doc.title : p.title;
    p.dirty = false;
    p.savedAt = P.hhmm();
    bus.emit('doc:dirty', { path: p.path, dirty: false });
    bus.emit('doc:saved', { path: p.path });
    status.set('save', 'saved ' + p.savedAt);
    updateMeta(p);
  })();
  try {
    await p.saving;
  } catch (e) {
    console.error('[editor] save', e);
    status.set('save', 'save failed: ' + (e.message || e));
  } finally {
    p.saving = null;
  }
}

function updateMeta(p) {
  if (!p.metaEl) return;
  const folder = P.dirname(p.path) || store.get('root')?.name || 'vault';
  const words = countWords((p.crepe ? safeMarkdown(p) : p.doc.body) + ' ' + (p.title || ''));
  const bits = [folder, `${words} word${words === 1 ? '' : 's'}`];
  if (p.dirty) bits.push('unsaved');
  else if (p.savedAt) bits.push('saved ' + p.savedAt);
  p.metaEl.textContent = bits.join('  ·  ');
  status.set('doc', `${words} words`);
}

function safeMarkdown(p) {
  try { return p.crepe.getMarkdown(); } catch { return p.doc.body; }
}

// ---------------------------------------------------------------------------
// external changes

function onFsChange(payload) {
  const p = page;
  if (!p || !payload || !Array.isArray(payload.changes)) return;
  const hit = payload.changes.find((c) => c && c.path === p.path);
  if (!hit) return;
  if (Date.now() - p.selfWriteAt < 2500) return;   // our own write coming back
  if (hit.kind === 'delete') { status.set('save', 'deleted on disk'); return; }
  if (p.dirty) { status.set('save', 'changed on disk, not reloaded'); return; }
  void reloadSilently(p);
}

async function reloadSilently(p) {
  let text;
  try { text = await bridge.readText(p.path); } catch { return; }
  if (p !== page || text === p.baseline) return;
  const host = p.el && p.el.parentNode;
  const scroller = scrollerOf(host);
  const top = scroller ? scroller.scrollTop : 0;
  await openPage(host, p.path);
  if (scroller) scroller.scrollTop = top;
}

function scrollerOf(el) {
  let n = el;
  while (n && n !== document.body) {
    const s = getComputedStyle(n).overflowY;
    if (s === 'auto' || s === 'scroll') return n;
    n = n.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// commands

const hasPage = () => !!page;

function registerCommands() {
  commands.register({
    id: 'page.new', title: 'New page', group: 'page', shortcut: 'Ctrl+N',
    run: () => void newPage(),
  });
  commands.register({
    id: 'page.save', title: 'Save page', group: 'page', shortcut: 'Ctrl+S',
    when: hasPage, run: () => void saveNow(),
  });
  commands.register({
    id: 'page.rename', title: 'Rename page', group: 'page',
    when: hasPage, run: () => void renamePage(),
  });
  commands.register({
    id: 'page.trash', title: 'Move page to trash', group: 'page',
    when: hasPage, run: () => void trashPage(),
  });
  commands.register({
    id: 'page.reveal', title: 'Reveal in Explorer', group: 'page',
    when: hasPage, run: () => { if (page) void bridge.reveal(page.path); },
  });
}

/** Free `<folder>/<base>.md`, numbered if taken. */
async function freePath(folder, base) {
  const dir = folder ? folder + '/' : '';
  let candidate = `${dir}${base}.md`;
  for (let n = 2; await bridge.exists(candidate); n++) candidate = `${dir}${base} ${n}.md`;
  return candidate;
}

async function newPage() {
  // In focus mode a new page belongs to the focus folder; otherwise beside the open page, or
  // in Scratchpad when a view is open (CONTRACT.md batch 4).
  const focused = defaultNewFolder();
  const folder = focused || (page ? P.dirname(page.path) : 'Scratchpad');
  const path = await freePath(folder, 'Untitled');
  await bridge.writeText(path, '# Untitled\n');
  navigate({ type: 'page', path });
  // The router mounts asynchronously; focus the title once it is there.
  const focusTitle = () => {
    if (!page || page.path !== path || !page.titleEl) return void setTimeout(focusTitle, 40);
    page.titleEl.focus();
    const r = document.createRange();
    r.selectNodeContents(page.titleEl);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  };
  setTimeout(focusTitle, 40);
}

async function renamePage() {
  const p = page;
  if (!p) return;
  const name = await prompt({ title: 'Rename page', value: P.basename(p.path), ok: 'Rename' });
  if (!name) return;
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').replace(/\.md$/i, '') + '.md';
  const to = P.joinPath(P.dirname(p.path), clean);
  if (to === p.path) return;
  if (await bridge.exists(to)) { status.set('save', 'a file with that name already exists'); return; }
  await saveNow();
  await bridge.rename(p.path, to);
  navigate({ type: 'page', path: to });
}

async function trashPage() {
  const p = page;
  if (!p) return;
  const ok = await confirm({
    title: 'Move to trash?',
    body: `${p.path} goes to the Recycle Bin. Nothing is deleted permanently.`,
    ok: 'Move to trash', danger: true,
  });
  if (!ok) return;
  const folder = P.dirname(p.path);
  p.dirty = false;              // do not resurrect the file by saving it on close
  await closePage();
  await bridge.trash(p.path);
  const next = await firstPageIn(folder);
  if (next) navigate({ type: 'page', path: next }); else clearRoute();
}

async function firstPageIn(folder) {
  try {
    const list = await bridge.list(folder);
    const md = list.find((n) => n.kind === 'file' && n.ext === 'md');
    return md ? md.path : null;
  } catch { return null; }
}
