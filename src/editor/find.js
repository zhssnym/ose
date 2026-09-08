// The find bar (C1). One row at the top of the page column: a mono field and an `n / m`
// count. Enter goes to the next hit, Shift+Enter to the previous, Escape closes the bar and
// leaves the caret on the current hit. The matching and the highlights belong to the plugin
// (plugins.js, findPlugin); this file is the DOM and the keys.
//
// The bar lives inside the editor's own root (`.ed`), so it goes with the page, and it is
// `position: sticky`, so it holds the top of the scroll box while the hits scroll under it.
// Body only: the title is a separate contenteditable outside ProseMirror, and a highlight
// there would mean wrapping its text in spans. A hit inside a code block is counted and
// jumped to but not painted (the CodeMirror node view draws its own text).

import { FIND_KEY, findState } from './plugins.js';
import { caretAt } from './reveal.js';

const MAX_PREFILL = 64;

/**
 * @param {HTMLElement} root       the page column (`.ed`); the bar is prepended to it
 * @param {() => any} getView      the live ProseMirror view, or null once the page is gone
 * Returns { open, close, isOpen, destroy }.
 */
export function createFind(root, getView) {
  let el = null;
  let input = null;
  let count = null;
  let last = '';

  const view = () => { try { return getView(); } catch { return null; } };

  /** The count follows the plugin: it announces every change of its state on the editor DOM. */
  const onState = () => paint();
  root.addEventListener('os-find', onState);

  function paint() {
    const v = view();
    if (!v || !count) return;
    const s = findState(v.state);
    count.textContent = s.query ? `${s.index + 1} / ${s.hits.length}` : '';
    count.classList.toggle('none', !!s.query && !s.hits.length);
  }

  /** Put the caret on the current hit and bring it into view. */
  function land(v) {
    const s = findState(v.state);
    const hit = s.hits[s.index];
    if (hit) caretAt(v, hit.from);
  }

  function search(query) {
    const v = view();
    if (!v) return;
    last = query;
    v.dispatch(v.state.tr.setMeta(FIND_KEY, { query }));
    land(v);
    paint();
  }

  function step(dir) {
    const v = view();
    if (!v) return;
    if (!findState(v.state).hits.length) { paint(); return; }
    v.dispatch(v.state.tr.setMeta(FIND_KEY, { step: dir }));
    land(v);
    paint();
  }

  function build() {
    el = document.createElement('div');
    el.className = 'ed-find';
    el.setAttribute('role', 'search');
    input = document.createElement('input');
    input.className = 'input mono';
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'Find in page';
    input.setAttribute('aria-label', 'Find in page');
    count = document.createElement('span');
    count.className = 'ed-find-count mono-sm';
    count.setAttribute('aria-live', 'polite');
    el.append(input, count);

    input.addEventListener('input', () => search(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    root.prepend(el);
  }

  /**
   * Open, or refocus when already open. A selection in the editor that fits on one line
   * seeds the field, the way every editor's find does; otherwise the last query comes back.
   */
  function open() {
    const v = view();
    if (!v) return;
    if (!el) build();
    let seed = last;
    const sel = v.state.selection;
    if (!sel.empty) {
      const text = v.state.doc.textBetween(sel.from, sel.to, '\n').trim();
      if (text && !text.includes('\n') && text.length <= MAX_PREFILL) seed = text;
    }
    input.value = seed;
    input.focus();
    input.select();
    search(seed);
  }

  /** Close: decorations gone, bar gone, caret left where the last hit put it. */
  function close({ toEditor = true } = {}) {
    const v = view();
    if (v) v.dispatch(v.state.tr.setMeta(FIND_KEY, { clear: true }));
    if (el) el.remove();
    el = input = count = null;
    if (toEditor && v) v.focus();
  }

  function destroy() {
    root.removeEventListener('os-find', onState);
    if (el) el.remove();
    el = input = count = null;
  }

  return { open, close, destroy, isOpen: () => !!el };
}
