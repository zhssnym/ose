// Linking one page to another.
//
// CONTRACT.md batch 5, "Link a page": the slash item `Link` and the command `page.link` both
// open `pickPage`, then insert a markdown link whose text is the target's title (its first H1,
// else the file name without `.md`) and whose href is the target path relative to the folder of
// the page being edited, with `%20` for spaces. Cancelling inserts nothing.
//
// The module knows nothing about which file is open: `index.js` binds a getter at init, so this
// file never imports the editor back (slash.js -> link.js -> index.js would be a cycle, and the
// round-trip harness would pull the whole shell in with it).

import { bridge } from '../bridge/index.js';
import { pickPage } from './deps.js';
import * as P from './paths.js';
import { TextSelection } from '@milkdown/kit/prose/state';

/** @type {() => string|null} */
let pagePath = () => null;

/** `index.js` calls this once: `bindPagePath(() => page ? page.path : null)`. */
export function bindPagePath(fn) {
  pagePath = typeof fn === 'function' ? fn : () => null;
}

/**
 * The first H1 of a markdown text, skipping YAML frontmatter and fenced code. `doc.js` only
 * reports an H1 that is the very first block; a link wants the first one wherever it is.
 */
export function firstH1(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  if (/^---[ \t]*$/.test(lines[0] || '')) {
    i = 1;
    while (i < lines.length && !/^---[ \t]*$/.test(lines[i])) i++;
    i++;
  }
  let fence = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = /^[ \t]{0,3}(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (h && h[1].trim()) return h[1].replace(/\s+/g, ' ').trim();
  }
  return '';
}

/** The title to show for a page: its first H1, else the file name without `.md`. */
export async function pageTitle(path) {
  try {
    const title = firstH1(await bridge.readText(path));
    if (title) return title;
  } catch { /* unreadable: fall back to the name */ }
  return P.stem(path);
}

/** The href for `target` as written inside the page at `from`. */
export function hrefFor(from, target) {
  return P.relativeHref(from || '', target) || P.basename(target);
}

/**
 * Replace `range` (the selection by default) with `text` carrying a link mark. The caret lands
 * after the link and the mark is dropped from the stored marks, so typing on does not extend it.
 *
 * The range is passed in because the picker is a modal: while it is open the editor is blurred,
 * and ProseMirror re-reads the DOM selection when it comes back — which is how a link asked for
 * at the end of a paragraph ended up at the top of the document.
 */
export function insertLink(view, text, href, range, lead) {
  if (!view) return false;
  const { state } = view;
  const mark = state.schema.marks.link;
  const label = String(text || href || '').trim() || href;
  try {
    const node = state.schema.text(label, mark ? [mark.create({ href })] : []);
    const nodes = lead ? [state.schema.text(lead), node] : [node];
    const size = state.doc.content.size;
    const from = Math.max(0, Math.min(range ? range.from : state.selection.from, size));
    const to = Math.max(from, Math.min(range ? range.to : state.selection.to, size));
    const tr = state.tr.replaceWith(from, to, nodes);
    const end = from + nodes.reduce((n, x) => n + x.nodeSize, 0);
    tr.setSelection(TextSelection.create(tr.doc, Math.min(end, tr.doc.content.size)));
    if (mark) tr.removeStoredMark(mark);
    tr.scrollIntoView();
    view.dispatch(tr);
    view.focus();
    return true;
  } catch (e) {
    console.error('[editor] insert link', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ctrl+K: one field for a URL or a page (E20/E21/L9)

/**
 * The link mark under the caret (or covering the selection) and the range it spans, or null.
 * ProseMirror keeps a mark on a run of text; the run is found by walking out from the caret
 * while the same mark is present, which is the range Edit and Remove act on.
 */
export function linkAt(state) {
  const markType = state.schema.marks.link;
  if (!markType) return null;
  const sel = state.selection;
  const $pos = sel.$from;
  const parent = $pos.parent;
  if (!parent || !parent.isTextblock) return null;
  const offset = $pos.parentOffset;
  const start = $pos.start();
  let found = null;
  parent.forEach((child, childOffset) => {
    if (found || !child.isText) return;
    const end = childOffset + child.nodeSize;
    // `<=` on the right so a caret sitting at the end of a link still edits it, the way
    // Obsidian's Ctrl+K does; a caret exactly at the start belongs to the link too.
    if (offset < childOffset || offset > end) return;
    const mark = child.marks.find((m) => m.type === markType);
    if (!mark) return;
    let from = childOffset;
    let to = end;
    parent.forEach((n, o) => {
      if (!n.isText || !n.marks.some((m) => m.eq(mark))) return;
      if (o + n.nodeSize === from) from = o;
      if (o === to) to = o + n.nodeSize;
    });
    found = { from: start + from, to: start + to, href: mark.attrs.href || '', mark };
  });
  if (found && !sel.empty && (sel.from < found.from || sel.to > found.to)) return null;
  return found;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOSTISH = /^[\w-]+(\.[\w-]+)+(\/|$)/;

/** Does this text mean a URL rather than the name of a page? */
export function looksLikeUrl(s) {
  const t = String(s || '').trim();
  if (!t || /\s/.test(t)) return SCHEME.test(t);
  if (SCHEME.test(t)) return true;
  if (/^www\./i.test(t)) return true;
  if (/\.(md|txt|markdown)$/i.test(t)) return false;      // that is a file, not a host
  return HOSTISH.test(t);
}

/** `www.x.com/y` -> `https://www.x.com/y`; anything with a scheme is left alone. */
export function normaliseUrl(s) {
  const t = String(s || '').trim();
  return SCHEME.test(t) ? t : `https://${t}`;
}

/** Remove the link mark over `range` (the link at the caret by default). Text stays. */
export function removeLink(view, range) {
  if (!view) return false;
  const { state } = view;
  const markType = state.schema.marks.link;
  const r = range || linkAt(state);
  if (!markType || !r) return false;
  const tr = state.tr.removeMark(r.from, r.to, markType);
  tr.setSelection(TextSelection.create(tr.doc, Math.min(r.to, tr.doc.content.size)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Put `href` on the text already in `range`, replacing any link mark it carries. */
function markLink(view, range, href) {
  const { state } = view;
  const markType = state.schema.marks.link;
  if (!markType) return false;
  const tr = state.tr.removeMark(range.from, range.to, markType)
    .addMark(range.from, range.to, markType.create({ href }));
  tr.setSelection(TextSelection.create(tr.doc, Math.min(range.to, tr.doc.content.size)));
  tr.removeStoredMark(markType);
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** `<folder>/<base>.md`, numbered when taken. Mirrors index.js `freePath`. */
async function freePath(folder, base) {
  const dir = folder ? folder + '/' : '';
  let candidate = `${dir}${base}.md`;
  for (let n = 2; await bridge.exists(candidate); n++) candidate = `${dir}${base} ${n}.md`;
  return candidate;
}

/** A file name that survives every tool: no separators, no reserved characters. */
const sanitise = (name) => String(name).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Ctrl+K. One dialog for both jobs: a field that takes a URL or a page name, the quick-open
 * matcher underneath, `create <name>` when nothing matches, and `Remove link` in the foot when
 * the caret was already inside a link.
 *
 * The ranges are captured before the modal opens: while it is up the editor is blurred and
 * ProseMirror re-reads the DOM selection when focus comes back (the bug that put a link at the
 * top of the document in batch 5).
 */
export async function linkCommand(view) {
  if (!view) return null;
  const { state } = view;
  const existing = linkAt(state);
  const sel = state.selection;
  const range = existing ? { from: existing.from, to: existing.to } : { from: sel.from, to: sel.to };
  const selText = state.doc.textBetween(range.from, range.to, ' ', ' ').trim();

  const choice = await linkDialog({
    value: existing ? existing.href : '',
    canRemove: !!existing,
  });
  if (!choice) { view.focus(); return null; }
  if (choice.remove) { removeLink(view, range); return null; }

  let href = '';
  let text = selText;
  if (choice.kind === 'url') {
    href = normaliseUrl(choice.url);
    if (!text) text = choice.url;
  } else {
    let target = choice.path;
    if (choice.kind === 'create') {
      const from = pagePath();
      const folder = from && from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
      const name = sanitise(choice.name);
      if (!name) { view.focus(); return null; }
      target = await freePath(folder, name);
      await bridge.writeText(target, `# ${name}\n`);
    }
    href = hrefFor(pagePath(), target);
    if (!text) text = await pageTitle(target);
  }
  if (!href) { view.focus(); return null; }

  if (range.to > range.from) markLink(view, range, href);
  else insertLink(view, text || href, href, range);
  return href;
}

/**
 * The field. Built here rather than on `pickPage` because one field has to answer three
 * questions — which page, which URL, or a page that does not exist yet — and `pickPage` only
 * answers the first. Same surface, same matcher and the same keys as quick open.
 */
async function linkDialog({ value = '', canRemove = false } = {}) {
  const [dlg, fuzzy, sidebar] = await Promise.all([
    import('../shell/dialog.js'), import('../shell/fuzzy.js'), import('../shell/sidebar.js'),
  ]);
  const { esc } = await import('../registry.js');
  const { icon } = await import('../shell/icons.js');
  let paths = [];
  try { paths = sidebar.allPages(); } catch { paths = []; }

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = dlg.openOverlay({
      width: 560, top: '15vh', className: 'pal pick ed-link', title: 'Link a page',
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    ov.box.innerHTML = `
      <div class="pal-head">
        <span class="pal-icon">${icon('link')}</span>
        <input class="pal-input" type="text" spellcheck="false" autocomplete="off"
               placeholder="Paste a link, or type a page name" aria-label="Link">
      </div>
      <div class="pal-list" role="listbox"></div>
      <div class="pal-foot mono-sm">
        <span><span class="kbd">↑</span><span class="kbd">↓</span> move</span>
        <span><span class="kbd">Enter</span> link</span>
        <span><span class="kbd">Esc</span> cancel</span>
        <span class="grow"></span>
        ${canRemove ? '<button type="button" class="btn ed-link-remove">Remove link</button>' : '<span class="pal-mode">link</span>'}
      </div>`;

    const input = ov.box.querySelector('.pal-input');
    const list = ov.box.querySelector('.pal-list');
    ov.box.querySelector('.ed-link-remove')?.addEventListener('click', () => finish({ remove: true }));

    let items = [];
    let sel = 0;

    function build() {
      const q = input.value.trim();
      const rows = [];
      const url = q && looksLikeUrl(q);
      if (url && SCHEME.test(q)) rows.push({ kind: 'url', url: q, title: q, hint: 'link' });
      for (const it of fuzzy.pageItems(paths, q, { limit: 50 })) {
        rows.push({ kind: 'page', path: it.path, title: it.title, hint: it.hint, hits: it.hits });
      }
      if (url && !SCHEME.test(q)) rows.push({ kind: 'url', url: q, title: normaliseUrl(q), hint: 'link' });
      if (q && !url && !rows.some((r) => r.kind === 'page' && r.title.toLowerCase() === q.toLowerCase())) {
        rows.push({ kind: 'create', name: q, title: `create “${q}”`, hint: 'new page' });
      }
      items = rows;
      sel = 0;
      paint();
    }

    function paint() {
      list.textContent = '';
      if (!items.length) { list.innerHTML = '<div class="empty">type a link or a page name</div>'; return; }
      const frag = document.createDocumentFragment();
      items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'row pal-row' + (i === sel ? ' active' : '');
        row.dataset.i = String(i);
        row.setAttribute('role', 'option');
        const label = it.kind === 'page' && it.hits ? fuzzy.highlight(it.title, it.hits) : esc(it.title);
        row.innerHTML = `<span class="grow">${label}</span>`
          + (it.hint ? `<span class="pal-hint">${esc(it.hint)}</span>` : '');
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
      if (row) finish(items[+row.dataset.i]);
    });
    list.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.pal-row');
      if (!row || +row.dataset.i === sel) return;
      sel = +row.dataset.i;
      list.querySelectorAll('.pal-row').forEach((n, i) => n.classList.toggle('active', i === sel));
    });

    input.value = value;
    build();
    requestAnimationFrame(() => { input.focus(); input.select(); });
  });
}

/**
 * Ask for a page and link to it at the caret. Resolves to the chosen path, or null when the
 * picker was cancelled (Esc), in which case the document is left exactly as it was.
 */
export async function insertPageLink(view, opts) {
  if (!view) return null;
  const { from, to } = view.state.selection;         // where the caret was before the modal
  const target = await pickPage({ title: 'Link a page…' });
  if (target === null || target === undefined || target === '') return null;
  const href = hrefFor(pagePath(), target);
  const title = await pageTitle(target);
  // `space` is the space the slash menu swallowed with the `/`: give it back in front of
  // the link, so `note /link` reads `note [Title](…)` and a cancelled pick leaves `note`.
  insertLink(view, title, href, { from, to }, opts && opts.space ? ' ' : '');
  return target;
}
