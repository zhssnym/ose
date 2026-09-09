// The page editor: a markdown file rendered as a Notion-style column.
//
//   properties strip   only when the file has YAML frontmatter; raw text preserved, simple
//                      `key: value` lines editable in place, everything else read-only
//   title              the file's first H1, editable; the file name when there is no H1
//   meta               folder, word count, last save
//   body               Crepe (Milkdown) over everything after the title
//
// Markdown is the source of truth. Nothing is written on open; a save happens only after the
// user has actually typed, and only when the composed text differs from what is on disk.
// Before every write the file is read again: if it no longer matches the text this page was
// opened from (or last wrote), the user decides, never the editor (CONTRACT.md batch 9, B1).

import { bus, commands, status, store } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { navigate, clearRoute, defaultNewFolder, scratchFolder, copyText, icon } from '../shell/index.js';
import { prompt, confirm, choose, patchState, toast } from './deps.js';
import { makeCrepe, readMarkdown, editorView } from './crepe.js';
import { bindPagePath, insertPageLink } from './link.js';
import { DRAG_TYPE, dropInto, payloadOf } from './drop.js';
import { createFind } from './find.js';
import { pickHeading } from './outline.js';
import { bodyStartLine, titleLineNo, posForBodyLine } from './lines.js';
import { caretAt, scrollerOf } from './reveal.js';
import { TextSelection } from '@milkdown/kit/prose/state';
import { parseDoc, composeDoc, countWords, detectLang, frontmatterEditable, setFrontmatterValue } from './doc.js';
import * as P from './paths.js';
import './editor.css';

// `lib/links.js` (C13, the shell side of a rename) may not be in the tree yet. A glob resolves
// to nothing at build time when the file is missing, where a literal import() would not build.
const LINKS_MODULE = import.meta.glob('../lib/links.js');

const SAVE_DEBOUNCE = 600;
/** A file still carrying the name `newPage` gave it: the first real title renames it (C12). */
const UNTITLED = /^Untitled( \d+)?$/i;

/** @type {null | ReturnType<typeof blankPage>} */
let page = null;
let openToken = 0;
let initialised = false;

const blankPage = () => ({
  path: '', doc: null, title: '', baseline: '',
  el: null, host: null, titleEl: null, metaEl: null, bodyEl: null, crepe: null, find: null,
  dirty: false, touched: false, ready: false,
  // rev counts user edits, so a write can tell whether the document moved on under it.
  // readOnly: the file is gone from disk; nothing is written again (C18). hold: the user
  // answered "cancel" to the changed-on-disk question; autosave stays quiet until an explicit
  // save asks again. warnedDisk: the disk text the last toast was about, so one external
  // change produces one toast.
  rev: 0, readOnly: false, hold: false, asking: false, warnedDisk: null, titleToBody: false,
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
  // link.js turns a picked page into an href relative to the page being edited.
  bindPagePath(() => (page ? page.path : null));
  void loadShellKeymap();

  // The bridge facade already re-emits 'fs' onto the bus; listening to both would reload twice.
  bus.on('fs', onFsChange);
  // The returned promise is what the Tauri adapter waits on before destroying the window
  // (B2). It resolves `false` when the save needs the user (the file changed on disk): the
  // adapter then keeps the window, the question is on screen, and closing again retries.
  bridge.on('window', (d) => {
    if (d && d.closing) return saveNow({ explicit: true, closing: true });
    return undefined;
  });
  window.addEventListener('beforeunload', () => { if (page && page.dirty) void saveNow({ explicit: true }); });
}

/**
 * Mount the file at `path` into `el`. `opts.line` (1-based, a line of the file as the search
 * overlay counts them) puts the caret in the block that holds that line once the editor is
 * up (C7). The same path with a new line does not remount: the open page just scrolls.
 */
export async function openPage(el, path, opts = {}) {
  if (opts.line && page && page.path === path && page.crepe && page.el && page.el.parentNode === el) {
    scrollToLine(opts.line);
    return;
  }
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
    attachFile: (file) => attachFile(p, file),
    pagePath: () => p.path,
    onChange: () => { if (p.ready) markDirty(p); },
    on: (api) => {
      api.blur(() => { if (p.dirty) void saveNow(); });
    },
  });
  if (token !== openToken) { await p.crepe.destroy().catch(() => {}); return; }

  wireEditorEvents(p);
  wireDrops(p);
  applySpellcheck(p);
  p.find = createFind(p.el, () => (p.crepe ? editorView(p.crepe) : null));
  p.cleanups.push(() => { if (p.find) p.find.destroy(); p.find = null; });
  // Anything the editor does to the document while it is settling (the trailing plugin adds
  // an empty paragraph, node views mount) must not count as a user edit. Two frames is the
  // normal path; the timer is the fallback, because a hidden window fires no frames at all.
  const ready = () => { p.ready = true; };
  requestAnimationFrame(() => requestAnimationFrame(ready));
  setTimeout(ready, 80);
  // The line jump waits for the same two frames: node views have to be laid out before a
  // block has a height to scroll to, and the router puts a remembered scroll back one frame
  // after the mount — the jump must come after that, not be undone by it.
  if (opts.line) requestAnimationFrame(() => requestAnimationFrame(() => { if (p === page) scrollToLine(opts.line); }));

  void patchState({ editor: { last: path } });
}

/**
 * Put the caret in the block holding file line `line` (1-based) and bring it into view. A
 * line above the body — frontmatter, the title — scrolls to the top, with the caret in the
 * title when the line is the title's. True when there was a page to scroll.
 */
export function scrollToLine(line) {
  const p = page;
  const n = Math.floor(Number(line) || 0);
  if (!p || !p.crepe || !p.el || n < 1) return false;
  const view = editorView(p.crepe);
  if (!view) return false;
  const start = bodyStartLine(p.doc);
  if (n < start) {
    const scroller = scrollerOf(p.el);
    if (scroller) scroller.scrollTop = 0;
    if (n === titleLineNo(p.doc)) focusTitle(p);
    return true;
  }
  const pos = posForBodyLine(p.crepe, view, p.doc.body, n - start + 1);
  caretAt(view, pos, { block: 'start', always: true, focus: true });
  return true;
}

/** The top of the page, caret at the start of the title (when the file has one). */
function focusTitle(p) {
  const scroller = scrollerOf(p.el);
  if (scroller) scroller.scrollTop = 0;
  if (!p.titleEl) return;
  p.titleEl.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(p.titleEl);
  range.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}

export async function closePage() {
  const p = page;
  if (!p) return;
  page = null;
  clearTimeout(p.saveTimer);
  // Leaving the page is deliberate: a held changed-on-disk question is asked now, and the
  // route change waits for the answer.
  if (p.dirty) await saveDoc(p, { explicit: true });
  for (const fn of p.cleanups) { try { fn(); } catch (e) { console.error(e); } }
  p.cleanups.length = 0;
  if (p.crepe) { try { await p.crepe.destroy(); } catch (e) { console.error('[editor] destroy', e); } }
  if (p.el && p.el.parentNode) p.el.remove();
  p.crepe = null;
  p.el = p.host = p.titleEl = p.metaEl = p.bodyEl = null;
  status.set('doc', null);
  status.set('save', null);
}

/**
 * Flush now. `explicit` is a user gesture (Ctrl+S, leaving the page, closing the window):
 * it lifts a `hold` and asks the changed-on-disk question again. `closing` means the window
 * is about to go, so the question cannot be awaited: the save resolves `false` instead, the
 * bridge keeps the window, and the dialog is shown for the user to answer.
 * Resolves true when nothing stands in the way of closing.
 */
export async function saveNow(opts = {}) {
  if (!page) return true;
  clearTimeout(page.saveTimer);
  return saveDoc(page, opts);
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
  // Enter and Tab leave the title through focusBody, so blur is the one place a finished
  // title is handled: save it, then let it name the file if the file is still `Untitled`.
  h1.addEventListener('blur', () => { void onTitleDone(p); });
  p.titleEl = h1;
  return h1;
}

async function onTitleDone(p) {
  // Enter/Tab/Down set this before moving the caret into the body; a rename remounts the
  // page, and the caret the user just asked for must come back afterwards.
  const toBody = p.titleToBody;
  p.titleToBody = false;
  if (p.dirty) await saveNow();
  if (await renameUntitledFromTitle(p) && toBody) focusBody();
}

/**
 * The YAML block above the title. Every row is shown; a row whose value sits on one plain
 * `key: value` line is editable in place (C6). The edit rewrites that line only, inside the
 * raw block that composeDoc writes back verbatim, so unknown keys, comments and multi-line
 * values are never reformatted — the block is still never parsed as YAML.
 */
function propertiesStrip(p) {
  const rows = p.doc.frontmatter || [];
  const box = document.createElement('div');
  box.className = 'ed-props';

  const head = document.createElement('button');
  head.className = 'ed-props-head';
  head.type = 'button';
  head.setAttribute('aria-expanded', 'true');
  // The shell's chevron, so the fold glyph is the sidebar's (same grid, same weight).
  head.innerHTML = `${icon('chevron')}<span>properties</span><span class="ed-props-count">${rows.length}</span>`;

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
    if (r.key && frontmatterEditable(p.doc.frontmatterRaw, r.key)) wirePropEdit(p, v, r.key);
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

/** One editable value: plain text, one line; Enter or Esc leaves, blur saves. */
function wirePropEdit(p, v, key) {
  v.contentEditable = 'plaintext-only';
  v.spellcheck = false;
  v.classList.add('editable');
  v.dataset.placeholder = 'empty';
  v.title = 'Click to edit';
  v.addEventListener('input', () => {
    if (p !== page || p.readOnly) return;
    // After a save `p.doc` is re-parsed from what was written, so the raw block here is always
    // the current one; a line that stopped being locatable (it cannot, from this edit alone,
    // but be safe) leaves the file untouched.
    const raw = setFrontmatterValue(p.doc.frontmatterRaw, key, v.textContent);
    if (raw === null || raw === p.doc.frontmatterRaw) return;
    p.doc.frontmatterRaw = raw;
    p.touched = true;
    markDirty(p);
  });
  v.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); v.blur(); }
  });
  v.addEventListener('blur', () => {
    v.textContent = v.textContent.replace(/[\r\n]+/g, ' ').trim();
    if (p.dirty) void saveNow();
  });
}

function onTitleKey(e) {
  if (e.key === 'Enter' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault();
    if (page) page.titleToBody = true;
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
  // requires a dirty document and text that differs from what is on disk. Typing into the
  // find bar is not touching the page.
  const touch = (e) => { if (!(e.target instanceof Element && e.target.closest('.ed-find'))) p.touched = true; };
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
  { combo: 'ctrl+\\', cmd: 'app.sidebar' },
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
  // A page link always navigates, whether or not the file exists: the router draws a
  // "page not found" screen with a Create button for a missing path, which is both the
  // explanation and the fix (C8). A status word here was neither.
  if (/\.md$/i.test(target)) { navigate({ type: 'page', path: target }); return; }
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
 * A pasted or dropped file lands in `<page folder>/attachments/<yyyy-mm-dd>-<slug>.<ext>`,
 * numbered when taken, so the folder stays portable. Resolves to the vault path of the copy.
 * Images and every other kind of file get the same name (drop.js links the others).
 */
async function attachFile(p, file) {
  const image = /^image\//.test(file.type || '');
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(file.name || '') || [])[1]
    || (image ? (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg') : 'bin');
  const base = `${P.today()}-${P.slugify(P.stem(file.name || ''), image ? 'image' : 'file')}`;
  const folder = P.joinPath(P.dirname(p.path), 'attachments');
  let target = `${folder}/${base}.${ext.toLowerCase()}`;
  for (let n = 2; await bridge.exists(target); n++) target = `${folder}/${base}-${n}.${ext.toLowerCase()}`;
  await bridge.writeBinary(target, await readAsBase64(file));
  p.touched = true;
  return target;
}

/** Milkdown's uploader (crepe.js onUpload): the attachment as a markdown src relative to the page. */
async function uploadImage(p, file) {
  return P.relativeHref(p.path, await attachFile(p, file));
}

/**
 * The drops the body's own handler (drop.js) never sees. On the title or the meta line the
 * browser would put the payload's text into the title, or the shell's window guard would
 * refuse the drop; both are the page, so the links go at the top of the body (position 0).
 * Inside a node view that keeps its events — the code block, where CodeMirror would insert
 * the sidebar's `text/plain` paths as code — or any other non-editable node, the drop is
 * taken here at the pointer, and drop.js puts the blocks after the node. A read-only page
 * takes nothing anywhere: Milkdown's editable-only handlers no longer cover the body then,
 * and an unhandled file drop navigates the window to the file. Text drags are left alone.
 */
function wireDrops(p) {
  const host = p.host;
  const above = (t) => t instanceof Element && !!(t.closest('.page-title') || t.closest('.page-meta'));
  const held = (t) => t instanceof Element && !!t.closest('.ProseMirror [contenteditable="false"]');
  const opts = { pagePath: () => p.path, attach: (file) => attachFile(p, file) };
  const onOver = (e) => {
    const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : [];
    const ours = types.includes(DRAG_TYPE) || types.includes('Files');
    if (!p.readOnly && !(ours && (above(e.target) || held(e.target)))) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = p.readOnly ? 'none' : types.includes(DRAG_TYPE) ? 'move' : 'copy';
  };
  const onDrop = (e) => {
    if (p.readOnly) { e.preventDefault(); return; }
    const top = above(e.target);
    if (!top && !held(e.target)) return;
    const payload = payloadOf(e.dataTransfer);
    if (!payload) return;
    e.preventDefault();
    e.stopPropagation();
    const view = p.crepe ? editorView(p.crepe) : null;
    if (!view) return;
    const at = top ? null : view.posAtCoords({ left: e.clientX, top: e.clientY });
    p.touched = true;
    void dropInto(view, payload, at ? at.pos : 0, opts);
  };
  host.addEventListener('dragover', onOver, true);
  host.addEventListener('drop', onDrop, true);
  p.cleanups.push(() => { host.removeEventListener('dragover', onOver, true); host.removeEventListener('drop', onDrop, true); });
}

// ---------------------------------------------------------------------------
// saving

function markDirty(p) {
  if (p !== page) return;
  // Editor-internal normalisation (tables, trailing paragraph) is not a user edit: no dirty
  // state, no "unsaved" in the status bar, until the user has actually interacted with the page.
  if (!p.touched) return;
  p.rev++;
  if (!p.dirty) {
    p.dirty = true;
    bus.emit('doc:dirty', { path: p.path, dirty: true });
  }
  status.set('save', p.hold ? 'unsaved · changed on disk' : 'unsaved');
  updateMeta(p);
  clearTimeout(p.saveTimer);
  p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
}

/** The file exactly as a save would write it. `page.copy-markdown` copies this (C14). */
function compose(p) {
  const body = readMarkdown(p.crepe, p.doc.body);
  return composeDoc(p.doc, { title: p.title, body });
}

const clean = (p) => {
  p.dirty = false;
  bus.emit('doc:dirty', { path: p.path, dirty: false });
  status.set('save', p.savedAt ? 'saved ' + p.savedAt : null);
  updateMeta(p);
};

/**
 * Save the page. Resolves `true` when the caller may move on (written, nothing to write,
 * or nothing that can be written) and `false` when the save is waiting on the user.
 *
 * The write is guarded three ways (B1, C18). The file is read back first and must equal
 * `baseline`, the text this page was opened from or last wrote; otherwise something else
 * edited it and the user chooses between keeping theirs and reloading. A file that is no
 * longer there is never recreated from the buffer: the page turns read-only. And the whole
 * check-then-write runs inside one `saving` promise, so a blur and a debounce firing together
 * ask one question and write once; edits made while the write was in flight reschedule it
 * instead of being marked clean by mistake (`rev`).
 */
async function saveDoc(p, opts = {}) {
  if (!p || !p.crepe) return true;
  clearTimeout(p.saveTimer);
  // Never write a file the user has not touched, whatever the editor thinks it changed while
  // mounting node views.
  if (!p.dirty || !p.touched) return true;
  if (p.readOnly) { status.set('save', 'not saved · file is gone'); return true; }
  if (p.saving) {
    // A question already on screen cannot be answered by a window that is closing: veto now.
    if (opts.closing && p.asking) return false;
    await p.saving;
    // Typed during that write, or the question was cancelled: a deliberate save goes again.
    if (p.dirty && opts.explicit && !p.saving) return saveDoc(p, opts);
    return !p.hold;
  }
  // "Cancel" at the question means "let me keep working": autosave stays quiet, the status
  // bar keeps saying so, and only a deliberate save (Ctrl+S, leaving, closing) asks again.
  if (p.hold && !opts.explicit) return true;
  p.hold = false;

  const rev = p.rev;
  let text;
  try {
    text = compose(p);
  } catch (e) {
    console.error('[editor] serialise', e);
    status.set('save', 'serialise failed, not saved');
    toast('could not serialise the page, nothing was written: ' + (e.message || e), 'err');
    return true;
  }
  if (text === p.baseline) { clean(p); return true; }

  let outcome = true;
  p.saving = (async () => {
    let onDisk = null;
    try {
      onDisk = await bridge.readText(p.path);
    } catch (e) {
      // Gone, or unreadable for the moment (a sync client holding it). Only "gone" is final.
      let there = true;
      try { there = await bridge.exists(p.path); } catch { /* assume it is */ }
      if (!there) { fileGone(p); return; }
      throw e;
    }
    if (onDisk !== p.baseline) {
      if (opts.closing) {
        // The window is on its way out and a modal cannot be awaited into it. Refuse the
        // close (the bridge reads `false`), show the question, and let the user close again.
        outcome = false;
        void resolveConflict(p, text, rev, onDisk);
        return;
      }
      outcome = await resolveConflict(p, text, rev, onDisk);
      return;
    }
    await writeOut(p, text, rev);
  })();
  try {
    await p.saving;
  } catch (e) {
    saveFailed(p, e);
  } finally {
    p.saving = null;
  }
  return outcome;
}

/** A write or read-back threw. The buffer stays dirty, so the next autosave tries again. */
function saveFailed(p, e) {
  console.error('[editor] save', e);
  status.set('save', 'save failed');
  toast(`save failed for ${p.path}: ${e && e.message ? e.message : e}`, 'err');
}

/** The write itself. `rev` is the edit count `text` was composed at. */
async function writeOut(p, text, rev) {
  p.selfWriteAt = Date.now();
  await bridge.writeText(p.path, text);
  p.baseline = text;
  p.warnedDisk = null;
  p.doc = parseDoc(text);
  p.title = p.doc.titleLine !== null ? p.doc.title : p.title;
  p.savedAt = P.hhmm();
  bus.emit('doc:saved', { path: p.path });
  if (p.rev === rev) {
    clean(p);
  } else if (p === page) {
    // Typed during the write: still dirty, and the debounce runs again.
    clearTimeout(p.saveTimer);
    p.saveTimer = setTimeout(() => { void saveDoc(p); }, SAVE_DEBOUNCE);
  }
}

/**
 * The file on disk is not the file this page was opened from. Ask. "Keep mine" writes the
 * buffer over it; "Reload from disk" drops the buffer and reopens the page (or, when the page
 * is already being closed, just drops it); "Cancel" keeps both as they are and holds
 * autosave. Resolves `true` unless the user cancelled.
 */
async function resolveConflict(p, text, rev, onDisk) {
  p.asking = true;
  let choice;
  try {
    choice = await choose({
      title: 'Changed on disk',
      body: `${p.path} was modified by something else since this page was opened. `
        + 'Keep your version and overwrite the file, or reload the file and lose your edits?',
      options: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Reload from disk', value: 'reload' },
        { label: 'Keep mine', value: 'keep', kind: 'primary' },
      ],
      cancel: 'cancel',
    });
  } finally {
    p.asking = false;
  }
  if (choice === 'keep') {
    try {
      await writeOut(p, text, rev);
    } catch (e) {
      saveFailed(p, e);
    }
    return true;
  }
  if (choice === 'reload') {
    p.dirty = false;
    p.hold = false;
    bus.emit('doc:dirty', { path: p.path, dirty: false });
    // An open page is reopened from disk; a page already being closed just lets go of its
    // buffer (the disk text is what the next open reads anyway).
    if (p === page) await reopenInPlace(p); else p.baseline = onDisk;
    return true;
  }
  p.hold = true;
  p.warnedDisk = onDisk;
  status.set('save', 'unsaved · changed on disk');
  return false;
}

/**
 * The file has left the disk (deleted, or moved somewhere the watcher did not tell us).
 * Nothing is written again: `writeText` creates parent folders, so a save from the stale
 * buffer would silently put the file back where the user just removed it (C18). The text is
 * still on screen; `page.copy-markdown` gets it out.
 */
function fileGone(p) {
  if (p.readOnly) return;
  p.readOnly = true;
  clearTimeout(p.saveTimer);
  try { if (p.crepe) p.crepe.setReadonly(true); } catch (e) { console.error('[editor] readonly', e); }
  if (p.titleEl) p.titleEl.contentEditable = 'false';
  for (const v of (p.el ? p.el.querySelectorAll('.ed-prop-val.editable') : [])) v.contentEditable = 'false';
  status.set('save', 'file is gone · read-only');
  toast(`${p.path} was deleted or moved on disk. The page is read-only and nothing was written; copy as markdown keeps your text.`, 'err', 9000);
}

/** The file is back under its name (recreated, moved back): editing may resume. */
function fileBack(p) {
  if (!p.readOnly) return;
  p.readOnly = false;
  try { if (p.crepe) p.crepe.setReadonly(false); } catch (e) { console.error('[editor] readonly', e); }
  if (p.titleEl) p.titleEl.contentEditable = 'plaintext-only';
  for (const v of (p.el ? p.el.querySelectorAll('.ed-prop-val.editable') : [])) v.contentEditable = 'plaintext-only';
  status.set('save', p.dirty ? 'unsaved' : null);
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

/**
 * Something touched the open file from outside (the watcher, CONTRACT.md `fs`). Renames of
 * our own making never arrive here: renamePage and the title rename move `p.path` to the new
 * name before the event can, so the old path no longer matches (C18).
 */
function onFsChange(payload) {
  const p = page;
  if (!p || !payload || !Array.isArray(payload.changes)) return;
  const hit = payload.changes.find((c) => c && c.path === p.path);
  if (!hit) return;
  if (hit.kind === 'rename') {
    if (hit.to) void followRename(p, hit.to);
    else fileGone(p);                 // renamed to somewhere the watcher could not pair
    return;
  }
  if (hit.kind === 'delete') { fileGone(p); return; }
  // create or modify
  if (p.readOnly) fileBack(p);
  if (Date.now() - p.selfWriteAt < 2500) return;   // our own write coming back
  if (p.dirty) { void warnChanged(p); return; }
  void reloadSilently(p);
}

/**
 * The file was renamed or moved under us. The page follows: every later save goes to the new
 * name (the old one must never be recreated), and the route is replaced so the breadcrumb,
 * the sidebar and back/forward agree. The router remounts, which flushes a dirty buffer to
 * the new path first — the text survives, the undo history does not.
 */
async function followRename(p, to) {
  if (!/\.md$/i.test(to)) { fileGone(p); return; }
  const from = p.path;
  p.path = to;
  status.set('path', to);
  updateMeta(p);
  toast(`moved on disk: ${from} → ${to}`);
  await navigate({ type: 'page', path: to }, { replace: true });
}

/**
 * Modified on disk while the buffer is dirty: the user's version stays, and the next save
 * will ask (B1). Read first, because a late echo of our own write is not a change at all,
 * and toast once per distinct disk text rather than once per event.
 */
async function warnChanged(p) {
  let onDisk;
  try { onDisk = await bridge.readText(p.path); } catch { return; }
  if (p !== page || onDisk === p.baseline || onDisk === p.warnedDisk) return;
  p.warnedDisk = onDisk;
  status.set('save', 'unsaved · changed on disk');
  toast(`${p.path} changed on disk — your next save will ask what to keep`, 'warn', 6000);
}

async function reloadSilently(p) {
  let text;
  try { text = await bridge.readText(p.path); } catch { return; }
  if (p !== page || text === p.baseline) return;
  await reopenInPlace(p);
}

/** Reopen the page from disk in the same host, keeping the scroll position. */
async function reopenInPlace(p) {
  if (p !== page || !p.el) return;
  const host = p.el.parentNode;
  const scroller = scrollerOf(host);
  const top = scroller ? scroller.scrollTop : 0;
  await openPage(host, p.path);
  if (scroller) scroller.scrollTop = top;
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
    when: hasPage, run: () => void saveExplicit(),
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
  commands.register({
    id: 'page.link', title: 'Link a page', group: 'page',
    when: hasPage, run: () => void linkPage(),
  });
  commands.register({
    id: 'page.duplicate', title: 'Duplicate page', group: 'page',
    when: hasPage, run: () => void duplicatePage(),
  });
  commands.register({
    id: 'page.copy-markdown', title: 'Copy as markdown', group: 'page',
    when: hasPage, run: () => void copyMarkdown(),
  });
  commands.register({
    id: 'page.print', title: 'Print page', group: 'page',
    when: hasPage, run: () => printPage(),
  });
  // The chords are the shell's (keys.js): Ctrl+F for find, the outline's is its choice.
  commands.register({
    id: 'page.find', title: 'Find in page', group: 'page',
    when: hasPage, run: () => { if (page && page.find) page.find.open(); },
  });
  commands.register({
    id: 'page.outline', title: 'Go to heading', group: 'page',
    when: hasPage, run: () => void outlinePage(),
  });
}

/** The heading picker (C2). The title row scrolls to the top; a body heading takes the caret. */
async function outlinePage() {
  const p = page;
  if (!p || !p.crepe) return;
  const view = editorView(p.crepe);
  if (!view) return;
  await pickHeading({
    view,
    title: p.doc.titleLine !== null ? p.title : null,
    onTitle: () => { if (p === page) focusTitle(p); },
  });
}

/** `page.save` from the palette or Ctrl+S is deliberate: it asks a held question again. */
function saveExplicit() { return saveNow({ explicit: true }); }

/**
 * Insert a link to another page at the caret (CONTRACT.md batch 5). The palette has just
 * closed, so the editor is focused first: the link goes where the caret was left.
 */
async function linkPage() {
  const p = page;
  if (!p || !p.crepe) return;
  const view = editorView(p.crepe);
  if (!view) return;
  view.focus();
  await insertPageLink(view);
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
  const folder = focused || (page ? P.dirname(page.path) : scratchFolder());
  const path = await freePath(folder, 'Untitled');
  try {
    await bridge.writeText(path, '# Untitled\n');
  } catch (e) { toast('could not create the page: ' + (e.message || e), 'err'); return; }
  navigate({ type: 'page', path });
  // The router mounts asynchronously; select the title once it is there.
  const selectNewTitle = () => {
    if (!page || page.path !== path || !page.titleEl) return void setTimeout(selectNewTitle, 40);
    page.titleEl.focus();
    const r = document.createRange();
    r.selectNodeContents(page.titleEl);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  };
  setTimeout(selectNewTitle, 40);
}

/** A file name from free text: no path separators or Windows-reserved characters, one `.md`. */
const cleanFileName = (name) =>
  String(name).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.md$/i, '').replace(/[. ]+$/, '') + '.md';

/**
 * Move the open page's file to `to` and follow it. The buffer is flushed first; if that
 * cannot happen (the changed-on-disk question was cancelled) the rename is off, because the
 * remount would show the disk's text and lose the buffer. `p.path` moves before the watcher
 * can report the rename, so onFsChange never mistakes our own move for an external one.
 */
async function moveOpenPage(p, to) {
  if (await bridge.exists(to)) { toast(`${P.basename(to)} already exists`, 'err'); return false; }
  await saveNow({ explicit: true });
  if (p !== page) return false;
  if (p.dirty) { toast('not renamed: the page could not be saved first', 'warn'); return false; }
  const from = p.path;
  try {
    await bridge.rename(from, to);
  } catch (e) { toast('rename failed: ' + (e.message || e), 'err'); return false; }
  p.path = to;
  await navigate({ type: 'page', path: to }, { replace: true });
  void rewriteLinks(from, to);
  return true;
}

/**
 * Links in other pages that pointed at the old name follow it (C13). The rewrite is the
 * shell side's (`lib/links.js`, `rewriteInbound(from, to) -> {files, links}`); when the
 * module is not in the tree the rename is simply not followed, and nothing is said.
 */
async function rewriteLinks(from, to) {
  const load = LINKS_MODULE['../lib/links.js'];
  if (!load) return;
  let mod;
  try { mod = await load(); } catch { return; }
  if (!mod || typeof mod.rewriteInbound !== 'function') return;
  try {
    const r = await mod.rewriteInbound(from, to);
    const links = Number(r && r.links) || 0;
    const files = Number(r && r.files) || 0;
    if (links > 0) toast(`renamed · ${links} link${links === 1 ? '' : 's'} in ${files} page${files === 1 ? '' : 's'} updated`);
  } catch (e) {
    toast('renamed, but the links to it could not be updated: ' + (e.message || e), 'warn');
  }
}

async function renamePage() {
  const p = page;
  if (!p || p.readOnly) return;
  const name = await prompt({ title: 'Rename page', value: P.basename(p.path), ok: 'Rename' });
  if (!name) return;
  const to = P.joinPath(P.dirname(p.path), cleanFileName(name));
  if (to === p.path || p !== page) return;
  await moveOpenPage(p, to);
}

/**
 * A new page is `Untitled.md` until it has a title (C12): once the H1 is edited and left,
 * the file takes the sanitised title as its name. Only files still named `Untitled*` —
 * a page with a real name keeps it; renaming that is the explicit Rename command's job.
 */
async function renameUntitledFromTitle(p) {
  if (p !== page || p.readOnly || p.doc.titleLine === null) return false;
  if (!UNTITLED.test(P.stem(p.path))) return false;
  const title = String(p.title || '').trim();
  if (!title || UNTITLED.test(title)) return false;
  const to = P.joinPath(P.dirname(p.path), cleanFileName(title));
  if (to === p.path) return false;
  // The title stays as typed either way; only the file name is at stake, so a taken name is
  // a warning, not an error, and the file keeps its `Untitled` name until Rename.
  if (await bridge.exists(to)) { toast(`${P.basename(to)} already exists; the file keeps its name`, 'warn'); return false; }
  if (p !== page) return false;
  return moveOpenPage(p, to);
}

/** `Name 2.md` beside the open page, with the file exactly as it would be saved (C11). */
async function duplicatePage() {
  const p = page;
  if (!p) return;
  const from = p.path;
  await saveNow({ explicit: true });
  if (p !== page) return;
  let text;
  try {
    text = await bridge.readText(from);
  } catch (e) { toast('could not read the page: ' + (e.message || e), 'err'); return; }
  const to = await freePath(P.dirname(from), P.stem(from));
  try {
    await bridge.writeText(to, text);
  } catch (e) { toast('could not duplicate the page: ' + (e.message || e), 'err'); return; }
  navigate({ type: 'page', path: to });
}

/** The file text as a save would write it, on the clipboard (C14). */
async function copyMarkdown() {
  const p = page;
  if (!p || !p.crepe) return;
  let text;
  try {
    text = compose(p);
  } catch (e) { toast('could not serialise the page: ' + (e.message || e), 'err'); return; }
  const ok = await copyText(text);
  toast(ok ? 'copied' : 'copy failed', ok ? 'info' : 'err');
}

/**
 * Print the page column (C14). Paper is white, so the dark palette would print pale text on
 * it: the light tokens are borrowed for the dialog. `window.print()` blocks until the dialog
 * closes in Chromium; `afterprint` covers a host where it does not. The theme attribute is
 * put back exactly as it was (the shell owns it and is not told).
 */
function printPage() {
  if (!page) return;
  const root = document.documentElement;
  const was = root.dataset.theme;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    window.removeEventListener('afterprint', restore);
    if (was === undefined) delete root.dataset.theme; else root.dataset.theme = was;
  };
  window.addEventListener('afterprint', restore);
  root.dataset.theme = 'light';
  try { window.print(); } finally { setTimeout(restore, 0); }
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
