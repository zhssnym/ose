// Part of the markdown page (../page.ts). The page's DOM: the title, the properties, the events
// inside the page, images and attachments.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installDom(ctx)`, and reaches the rest through `ctx`.

import { attachmentFolder, bridge, icon, pageFiles, spellcheckOn } from '../host.ts';
import { toast } from '../deps.ts';
import { DRAG_TYPE, dropInto, payloadOf } from '../drop.ts';
import { followHref } from '../linkstate.ts';
import { TextSelection } from '@milkdown/kit/prose/state';
import { composeDoc, frontmatterEditable, setFrontmatterValue } from '../doc.ts';
import * as P from '../paths.ts';
import {
  anchorAt, ATTACH_OUTSIDE, checkedBody, editorView, errCode, inTooltip, readAsBase64,
} from './shared.ts';
import type { PageCtx } from './ctx.ts';

export function installDom(ctx: PageCtx) {

  // -------------------------------------------------------------------------
  // DOM

  function buildDom(p, host) {
    host.innerHTML = '';
    const col = document.createElement('div');
    col.className = 'page-col ed';
    // The language the column's words are hyphenated in (editor.css): the system's, which is
    // the one its owner writes in. The window's own `lang` is the interface's, English.
    col.lang = navigator.language || 'en';
    p.el = col;
    p.host = col;

    // The banner's place is the top of the column, drawn by `renderBanner` when there is
    // something to say (§6.5).
    const banner = document.createElement('div');
    banner.className = 'ed-banner';
    banner.hidden = true;
    p.bannerEl = banner;
    p.lastBanner = '';
    col.append(banner);

    if (p.doc.frontmatterRaw) col.append(propertiesStrip(p));

    // A file that is not markdown has no title of any kind: the meta line names it.
    p.titleEl = null;
    if (p.plain) {
      // nothing above the body
    } else if (p.doc.titleLine !== null) {
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

    // The page's facts (its mode, its counts, when it was changed, whether it is saved) are in
    // the status bar at the foot of the window: the column holds the page and nothing else.
    p.metaEl = null;
    p.metaText = null;
    p.modeEl = null;

    const body = document.createElement('div');
    body.className = 'ed-body';
    p.bodyEl = body;
    col.append(body);

    host.append(col);
    if (p.frozen) col.classList.add('ed-frozen');
    // Which page the commands act on: the one the caret is in. With one page mounted — the
    // stock shell — this never changes anything.
    col.addEventListener('focusin', ctx.take);
    // The merge note (H7) goes on Esc as well as by itself. Nothing else is taken from the key.
    col.addEventListener('keydown', (e) => { if (e.key === 'Escape' && p.mergeNote) ctx.clearMergeNote(p); }, true);
    ctx.renderBanner(p);
  }

  /** The editable H1. `plaintext-only` keeps pasted formatting out of a file's title line. */
  function makeTitleEl(p, text) {
    const h1 = document.createElement('h1');
    h1.className = 'page-title';
    h1.contentEditable = p.frozen ? 'false' : 'plaintext-only';
    h1.spellcheck = false;
    h1.dataset.placeholder = 'Untitled';
    h1.textContent = text;
    h1.addEventListener('input', () => {
      p.title = h1.textContent.replace(/\s+/g, ' ').trim();
      ctx.publishTitle(p);
      ctx.markDirty(p);
    });
    h1.addEventListener('keydown', onTitleKey);
    // Enter and Tab leave the title through focusBody, so blur is the one place a finished
    // title is handled: save it, then let it name the file if the file is still `Untitled`.
    h1.addEventListener('blur', () => { void onTitleDone(p); });
    p.titleEl = h1;
    return h1;
  }

  async function onTitleDone(p) {
    const toBody = p.titleToBody;
    p.titleToBody = false;
    if (p.dirty) await ctx.saveNow();
    // The rename is in place now (no remount), so the caret the user asked for is still there;
    // it is put back only if the freeze around the flush took it away.
    if (await ctx.renameUntitledFromTitle(p) && toBody && p === ctx.page && !(p.el && p.el.contains(document.activeElement))) focusBody();
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
      const open_ = box.classList.toggle('closed');
      head.setAttribute('aria-expanded', String(!open_));
    });
    box.append(head, list);
    return box;
  }

  /** One editable value: plain text, one line; Enter or Esc leaves, blur saves. */
  function wirePropEdit(p, v, key) {
    v.contentEditable = p.frozen ? 'false' : 'plaintext-only';
    v.spellcheck = false;
    v.classList.add('editable');
    v.dataset.placeholder = 'empty';
    v.title = 'Click to edit';
    v.addEventListener('input', () => {
      if (p !== ctx.page || p.frozen) return;
      // After a save `p.doc` is re-parsed from what was written, so the raw block here is always
      // the current one; a line that stopped being locatable leaves the file untouched.
      const raw = setFrontmatterValue(p.doc.frontmatterRaw, key, v.textContent);
      if (raw === null || raw === p.doc.frontmatterRaw) return;
      p.doc.frontmatterRaw = raw;
      ctx.markDirty(p);
    });
    v.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); v.blur(); }
    });
    v.addEventListener('blur', () => {
      v.textContent = v.textContent.replace(/[\r\n]+/g, ' ').trim();
      if (p.dirty) void ctx.saveNow();
    });
  }

  function onTitleKey(e) {
    if (e.key === 'Enter' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      if (ctx.page) ctx.page.titleToBody = true;
      focusBody();
    }
  }

  /**
   * L11: the caret lands at the **start of the first body block**, not wherever it happened to
   * be last. Leaving the title is a move to the top of the body, and nothing else.
   */
  function focusBody() {
    const p = ctx.page;
    if (!p) return;
    if (p.source) { p.source.focus(); return; }
    const view = p.crepe ? editorView(p.crepe) : null;
    if (!view) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)).scrollIntoView());
    view.focus();
  }

  /**
   * L10: the way back. Backspace or ArrowUp at the very start of the body puts the caret at the
   * **end** of the title. False when there is no title to go to.
   */
  function focusTitleEnd(p) {
    if (!p || !p.titleEl || p.titleEl.contentEditable === 'false') return false;
    p.titleEl.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(p.titleEl);
    range.collapse(false);
    const sel = getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    return true;
  }

  /**
   * L19: Ctrl+A once selects the block, twice the body (P3, blocks.ts), a third time the title
   * as well — so the copy that follows is the whole note. The title is not part of the
   * ProseMirror document, so the selection cannot literally reach it: it is marked instead, and
   * the copy handler in `wireEditorEvents` writes the title line in front of the body.
   */
  function selectAllWithTitle(p) {
    if (!p || !p.titleEl || p.titleSelected) return false;
    p.titleSelected = true;
    p.titleEl.classList.add('ed-all-selected');
    return true;
  }

  function clearTitleSelection(p) {
    if (!p || !p.titleSelected) return;
    p.titleSelected = false;
    if (p.titleEl) p.titleEl.classList.remove('ed-all-selected');
  }

  /** The note without its frontmatter: the title line, the gap, the body, as a save would write. */
  function wholeNote(p) {
    const r = checkedBody(p.crepe, p.doc.body);
    const body = r.text ?? (p.crepe ? p.crepe.getMarkdown() : '');
    return composeDoc({ ...p.doc, frontmatterRaw: '', preTitle: '' }, { title: p.title, body });
  }

  /** Give a file with no H1 one. A user action, never automatic. */
  function addTitle(p) {
    if (p.frozen) return;
    const doc = p.doc;
    doc.titleLine = '# ';
    doc.title = '';
    doc.gap = doc.body.trim() ? '\n\n' : '\n';
    p.title = P.stem(p.path);
    // Rebuild the header only; the editor keeps its document and its undo history.
    const h1 = makeTitleEl(p, p.title);
    p.el.querySelector('.page-title').replaceWith(h1);
    ctx.markDirty(p);
    h1.focus();
    const range = document.createRange();
    range.selectNodeContents(h1);
    const sel = getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  }

  /**
   * Spellcheck is a setting, not a guess (L12/E43). `settings.spellcheck` (P8, default true)
   * decides; the language is the app's own.
   */
  function applySpellcheck(p) {
    if (!p || !p.el) return;
    const on_ = spellcheckOn();
    const lang = navigator.language || 'en';
    p.el.setAttribute('lang', lang);
    const view = p.crepe ? editorView(p.crepe) : null;
    for (const dom of [view && view.dom, p.source && p.source.view.contentDOM]) {
      if (!dom) continue;
      dom.setAttribute('spellcheck', String(on_));
      dom.setAttribute('lang', lang);
    }
  }

  // -------------------------------------------------------------------------
  // events inside the page

  function wireEditorEvents(p) {
    const host = p.host;
    // M5: there is no "touched" gate any more. A change the editor makes on its own while it
    // settles is kept out by `p.ready`; after that, a change is a change, and whether it is
    // worth a write is decided by comparing the composed text with the baseline.
    //
    // L19: the widened selection is a mode of exactly one gesture. Anything but the chords that
    // read it (Ctrl+A again, Ctrl+C, Ctrl+X) puts the page back to an ordinary selection.
    const MODIFIERS = ['Control', 'Meta', 'Shift', 'Alt', 'AltGraph'];
    const keeps = (e) => MODIFIERS.includes(e.key)
      || ((e.ctrlKey || e.metaKey) && ['a', 'c', 'x', 'insert'].includes(String(e.key).toLowerCase()));
    const clearAll = (e) => { if (e.type !== 'keydown' || !keeps(e)) clearTitleSelection(p); };
    const onCopy = (e) => {
      if (!p.titleSelected || !e.clipboardData || !p.crepe) return;
      let text;
      try { text = wholeNote(p); } catch (err) { console.error('[editor] copy whole note', err); return; }
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData.setData('text/plain', text);
    };
    host.addEventListener('keydown', clearAll, true);
    host.addEventListener('pointerdown', clearAll, true);
    host.addEventListener('copy', onCopy, true);
    p.cleanups.push(() => {
      host.removeEventListener('keydown', clearAll, true);
      host.removeEventListener('pointerdown', clearAll, true);
      host.removeEventListener('copy', onCopy, true);
    });

    host.addEventListener('pointerdown', onLinkPointerDown, true);
    host.addEventListener('click', onLinkClick, true);
    p.cleanups.push(() => host.removeEventListener('pointerdown', onLinkPointerDown, true));
    p.cleanups.push(() => host.removeEventListener('click', onLinkClick, true));

    // Notion behaviour: a click in the empty space below the last block puts the caret at the
    // end of the page instead of leaving the editor unfocused.
    //
    // The element around the column is the router's, and a parked page comes back into another
    // one (M12): the listener on it is bound where the column is now, and moved with it
    // (`p.bindParent`), never left on an element that shows a different page.
    let scroller: any = null;
    const onBlankClick = (e) => {
      if (e.button !== 0 || ctx.parked) return;
      if (e.target !== host && e.target !== scroller && e.target !== p.bodyEl) return;
      const view = p.crepe ? editorView(p.crepe) : null;
      if (!view) return;
      e.preventDefault();
      const end = view.state.doc.content.size;
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(end), -1)));
      view.focus();
    };
    const unbindParent = () => { if (scroller) scroller.removeEventListener('mousedown', onBlankClick); scroller = null; };
    p.bindParent = () => {
      unbindParent();
      scroller = host.parentElement;
      if (scroller) scroller.addEventListener('mousedown', onBlankClick);
    };
    host.addEventListener('mousedown', onBlankClick);
    p.bindParent();
    p.cleanups.push(() => { host.removeEventListener('mousedown', onBlankClick); unbindParent(); p.bindParent = null; });
  }

  /** The body lost the focus: a save now, and a draft when that save did not land (C4). */
  function onEditorBlur(p) {
    if (p !== ctx.page || !p.dirty) return;
    // A recovered draft nobody has edited yet waits for a deliberate save (see open).
    if (p.recovered && p.recovered.applied && p.recovered.rev === p.rev) return;
    void ctx.saveNow().then((ok) => { if (!ok && p === ctx.page && p.dirty) void ctx.writeDraft(p); });
  }

  /**
   * Ctrl/Cmd+click follows a link. It has to be caught on pointerdown: ProseMirror treats
   * Ctrl+mousedown as "select this node", re-renders the paragraph, and by the time the click
   * event arrives its target is the paragraph and the anchor is gone.
   */
  function onLinkPointerDown(e) {
    if (!ctx.page || e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
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
    if (!ctx.page) return;
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
    if (!ctx.page) return;
    // linkstate.ts (P7) owns where a href goes: anchors, missing pages, text files into source
    // mode, the platform for everything else. The editor only says which page it was written in.
    return followHref(href, ctx.page.path);
  }

  // -------------------------------------------------------------------------
  // images

  function resolveImage(p, src) {
    const s = String(src || '');
    if (!s || P.isExternal(s) || s.startsWith('blob:')) return s;
    const target = P.resolveHref(p.path, s);
    return target ? bridge.assetUrl(target) : s;
  }

  /**
   * A pasted or dropped file lands in `<page folder>/attachments/<yyyy-mm-dd>-<slug>.<ext>`,
   * numbered when taken, so the folder stays portable. Resolves to the vault path of the copy.
   * A page outside the vault has no folder of the vault to put it in (X7): refused.
   */
  async function attachFile(p, file) {
    if (p.outside) throw Object.assign(new Error(ATTACH_OUTSIDE), { code: 'outside' });
    const image = /^image\//.test(file.type || '');
    const ext = (/\.([a-z0-9]{1,8})$/i.exec(file.name || '') || [])[1]
      || (image ? (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg') : 'bin');
    const base = `${P.today()}-${P.slugify(P.stem(file.name || ''), image ? 'image' : 'file')}`;
    // Where attachments go is a setting (S35, P8); the default answers the page's own folder.
    // `''` is the vault root: a path with no folder in front of it (QA F23).
    const folder = attachmentFolder(p.path);
    const named = (name) => (folder ? `${folder}/${name}` : name);
    const nth = (n) => named(n < 2 ? `${base}.${ext.toLowerCase()}` : `${base}-${n}.${ext.toLowerCase()}`);
    const data = await readAsBase64(file);
    // The name is taken with an exclusive create that writes the bytes in the same call
    // (`createNewBinary`, wave 3): never an overwrite, and a write that fails leaves no empty
    // file behind (wave 1, open). A file that appeared under the name meanwhile (a sync client,
    // a second window) answers `exists`, and the next number is tried.
    for (let n = 1; n < 1000; n++) {
      try {
        const r = await pageFiles.createNewBinary(nth(n), data);
        return String((r && r.path) || nth(n));
      } catch (e) {
        if (errCode(e) === 'exists') continue;
        throw e;
      }
    }
    throw Object.assign(new Error(`no free name for ${base}.${ext}`), { code: 'exists' });
  }

  /** Milkdown's uploader (crepe.ts onUpload): the attachment as a markdown src relative to the page. */
  async function uploadImage(p, file) {
    if (p.outside) { toast(ATTACH_OUTSIDE, 'warn'); throw Object.assign(new Error(ATTACH_OUTSIDE), { code: 'outside' }); }
    return P.relativeHref(p.path, await attachFile(p, file));
  }

  /**
   * The drops the body's own handler (drop.ts) never sees. On the title or the meta line the
   * browser would put the payload's text into the title, or the shell's window guard would
   * refuse the drop; both are the page, so the links go at the top of the body (position 0).
   * Inside a node view that keeps its events, the drop is taken here at the pointer, and
   * drop.ts puts the blocks after the node. A frozen page takes nothing anywhere.
   */
  function wireDrops(p) {
    const host = p.host;
    const above = (t) => t instanceof Element && !!(t.closest('.page-title') || t.closest('.page-meta'));
    const held = (t) => t instanceof Element && !!t.closest('.ProseMirror [contenteditable="false"]');
    const o = { pagePath: () => p.path, attach: (file) => attachFile(p, file) };
    const onOver = (e) => {
      const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : [];
      const ours = types.includes(DRAG_TYPE) || types.includes('Files');
      if (!p.frozen && !(ours && (above(e.target) || held(e.target)))) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = p.frozen ? 'none' : types.includes(DRAG_TYPE) ? 'move' : 'copy';
    };
    const onDrop = (e) => {
      if (p.frozen) { e.preventDefault(); return; }
      const top = above(e.target);
      if (!top && !held(e.target)) return;
      const payload = payloadOf(e.dataTransfer);
      if (!payload) return;
      e.preventDefault();
      e.stopPropagation();
      const view = p.crepe ? editorView(p.crepe) : null;
      if (!view) return;
      const at = top ? null : view.posAtCoords({ left: e.clientX, top: e.clientY });
      void dropInto(view, payload, at ? at.pos : 0, o);
    };
    host.addEventListener('dragover', onOver, true);
    host.addEventListener('drop', onDrop, true);
    p.cleanups.push(() => { host.removeEventListener('dragover', onOver, true); host.removeEventListener('drop', onDrop, true); });
  }

  return {
    buildDom,
    makeTitleEl,
    onTitleDone,
    propertiesStrip,
    wirePropEdit,
    onTitleKey,
    focusBody,
    focusTitleEnd,
    selectAllWithTitle,
    clearTitleSelection,
    wholeNote,
    addTitle,
    applySpellcheck,
    wireEditorEvents,
    onEditorBlur,
    onLinkPointerDown,
    onLinkClick,
    followLink,
    resolveImage,
    attachFile,
    uploadImage,
    wireDrops,
  };
}
