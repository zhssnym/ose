// The find bar (C1) and, since batch 12, find and replace (S22/L15).
//
// One bar at the top of the page column, laid out as two columns: the fields on the left (the
// mono query field, and under it the replacement field when replace is asked for), and on the
// right what acts on them — an `n / m` count, the two switches (match case, whole word),
// previous, next and close on the first line, `Replace` and `Replace all` on the second. It
// reads as two rows and tabs as the user expects: query, replacement, then the buttons (QA
// defect 6). Ctrl+H puts the caret in the replacement field. Enter goes to the
// next hit, Shift+Enter to the previous, Escape closes the bar and leaves the caret on the
// current hit. The matching and the highlights belong to the plugin (plugins.js, findPlugin);
// this file is the DOM, the keys, and the replacement transactions.
//
// The bar lives inside the editor's own root (`.ed`), so it goes with the page, and it is
// `position: sticky`, so it holds the top of the scroll box while the hits scroll under it.
// Body only: the title is a separate contenteditable outside ProseMirror, and a highlight
// there would mean wrapping its text in spans. A hit inside a code block is counted and
// jumped to but not painted (the CodeMirror node view draws its own text).
//
// Every replacement goes through one ProseMirror transaction, so undo takes it back in one
// press and the page goes dirty through the editor's normal change path — the bar never
// writes and never touches the save path itself. It does say that the change was the user's
// (`onEdit`), because the bar's own keys and clicks are excluded from what counts as touching
// the page, and a replacement on a page nobody had typed in was otherwise never saved.

import { FIND_KEY, findState } from './plugins.js';
import { caretAt } from './reveal.js';
import { icon } from './host.js';
import { toast } from './deps.js';

const MAX_PREFILL = 64;

/**
 * @param {HTMLElement} root       the page column (`.ed`); the bar is prepended to it
 * @param {() => any} getView      the live ProseMirror view, or null once the page is gone
 * @param {() => void} [onEdit]    a replacement happened: the page has been edited by the user.
 *   The bar's own keys and clicks are deliberately not "touching the page" (index.js), so
 *   without this a replacement on a page nobody had typed in went dirty-less and unsaved.
 * Returns { open, close, isOpen, destroy }.
 */
export function createFind(root, getView, onEdit) {
  let el = null;
  let input = null;
  let replaceInput = null;
  let replaceRow = null;
  let count = null;
  let last = '';
  let lastReplace = '';
  let opts = { caseSensitive: false, wholeWord: false };

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
    const none = !s.query || !s.hits.length;
    for (const b of el.querySelectorAll('[data-needs-hit]')) b.disabled = none;
  }

  /** Put the caret on the current hit and bring it into view. */
  function land(v) {
    const s = findState(v.state);
    const hit = s.hits[s.index];
    if (hit) caretAt(v, hit.from);
  }

  function search(query, { keepCaret = false } = {}) {
    const v = view();
    if (!v) return;
    last = query;
    v.dispatch(v.state.tr.setMeta(FIND_KEY, { query, ...opts }));
    if (!keepCaret) land(v);
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

  // -------------------------------------------------------------------- replace

  /** The current hit, replaced; then the search runs again and lands on the next one. */
  function replaceOne() {
    const v = view();
    if (!v) return;
    const s = findState(v.state);
    const hit = s.hits[s.index];
    if (!hit) return;
    const text = replaceInput ? replaceInput.value : '';
    lastReplace = text;
    const tr = v.state.tr;
    if (text) tr.replaceWith(hit.from, hit.to, v.state.schema.text(text));
    else tr.delete(hit.from, hit.to);
    // The query has to be re-run against the new document, and the index has to stay where it
    // was so `Replace` twice walks forwards instead of sitting on the same word.
    tr.setMeta(FIND_KEY, { query: last, ...opts, at: hit.from + text.length });
    v.dispatch(tr.scrollIntoView());
    if (typeof onEdit === 'function') onEdit();
    land(v);
    paint();
    v.focus();
  }

  /** Every hit at once, in one transaction, so one undo takes the whole thing back. */
  function replaceAll() {
    const v = view();
    if (!v) return;
    const s = findState(v.state);
    if (!s.hits.length) return;
    const text = replaceInput ? replaceInput.value : '';
    lastReplace = text;
    const tr = v.state.tr;
    // Backwards: replacing from the end leaves every earlier position untouched.
    for (let i = s.hits.length - 1; i >= 0; i--) {
      const h = s.hits[i];
      if (text) tr.replaceWith(h.from, h.to, v.state.schema.text(text));
      else tr.delete(h.from, h.to);
    }
    const n = s.hits.length;
    tr.setMeta(FIND_KEY, { query: last, ...opts });
    v.dispatch(tr.scrollIntoView());
    if (typeof onEdit === 'function') onEdit();
    paint();
    v.focus();
    toast(`replaced ${n} ${n === 1 ? 'match' : 'matches'}`);
  }

  // -------------------------------------------------------------------- dom

  /** `label` is a word, or `{icon}` for one of the shell's 16px stroked glyphs (DESIGN.md). */
  const button = (label, title, onClick, needsHit) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ed-find-btn';
    if (label && label.icon) { b.innerHTML = icon(label.icon); b.classList.add('ed-find-icon', ...(label.className ? [label.className] : [])); }
    else b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    if (needsHit) b.setAttribute('data-needs-hit', '');
    b.addEventListener('click', () => { onClick(); });
    return b;
  };

  const toggle = (label, title, key) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ed-find-tog';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      opts = { ...opts, [key]: !opts[key] };
      b.classList.toggle('on', opts[key]);
      b.setAttribute('aria-pressed', String(opts[key]));
      search(input.value, { keepCaret: true });
      input.focus();
    });
    return b;
  };

  function build() {
    el = document.createElement('div');
    el.className = 'ed-find';
    el.setAttribute('role', 'search');

    // Two columns, not two rows: the fields go in one, the buttons that act on them in the
    // other, so the tab order is find, replace, then the buttons. As two rows the replacement
    // field sat six stops behind the query (QA defect 6). The grid puts each column's second
    // item under its first, which is the same two-row bar as before on screen.
    const fields = document.createElement('div');
    fields.className = 'ed-find-fields';
    const acts = document.createElement('div');
    acts.className = 'ed-find-acts';

    input = document.createElement('input');
    input.className = 'input mono';
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'Find in page';
    input.setAttribute('aria-label', 'Find in page');

    replaceInput = document.createElement('input');
    replaceInput.className = 'input mono';
    replaceInput.type = 'text';
    replaceInput.spellcheck = false;
    replaceInput.autocomplete = 'off';
    replaceInput.placeholder = 'Replace with';
    replaceInput.setAttribute('aria-label', 'Replace with');
    replaceInput.hidden = true;
    fields.append(input, replaceInput);

    count = document.createElement('span');
    count.className = 'ed-find-count mono-sm';
    count.setAttribute('aria-live', 'polite');
    const findActs = document.createElement('div');
    findActs.className = 'ed-find-line';
    findActs.append(
      count,
      toggle('Aa', 'Match case', 'caseSensitive'),
      toggle('ab|', 'Whole word', 'wholeWord'),
      button({ icon: 'chevron', className: 'flip' }, 'Previous match', () => step(-1), true),
      button({ icon: 'chevron' }, 'Next match', () => step(1), true),
      button({ icon: 'close' }, 'Close', () => close()),
    );

    replaceRow = document.createElement('div');
    replaceRow.className = 'ed-find-line';
    replaceRow.hidden = true;
    replaceRow.append(
      button('Replace', 'Replace this match', replaceOne, true),
      button('Replace all', 'Replace every match', replaceAll, true),
    );
    acts.append(findActs, replaceRow);

    el.append(fields, acts);

    input.addEventListener('input', () => search(input.value));
    for (const field of [input, replaceInput]) {
      field.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;              // E44
        if (e.key === 'Enter') {
          e.preventDefault();
          if (field === replaceInput && !e.shiftKey) replaceOne();
          else step(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      });
    }
    el.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;                // E44
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    root.prepend(el);
  }

  /**
   * Open, or refocus when already open. A selection in the editor that fits on one line seeds
   * the field, the way every editor's find does; otherwise the last query comes back.
   * `query` seeds it outright (the vault search hands its own term over, N36);
   * `replace` shows the second row (Ctrl+H).
   */
  function open({ query = null, replace = false } = {}) {
    const v = view();
    if (!v) return;
    if (!el) build();
    let seed = last;
    if (typeof query === 'string' && query) seed = query;
    else {
      const sel = v.state.selection;
      if (!sel.empty) {
        const text = v.state.doc.textBetween(sel.from, sel.to, '\n');
        const trimmed = text.trim();
        if (trimmed && !trimmed.includes('\n') && trimmed.length <= MAX_PREFILL) seed = trimmed;
      }
    }
    replaceRow.hidden = !replace;
    replaceInput.hidden = !replace;
    if (replace) replaceInput.value = lastReplace;
    input.value = seed;
    // Ctrl+H asked for the replacement: the caret goes there, the way source mode's panel
    // does it, and the query field keeps whatever seeded it (QA defect 6).
    const focusOn = replace ? replaceInput : input;
    focusOn.focus();
    focusOn.select();
    search(seed);
  }

  /** Close: decorations gone, bar gone, caret left where the last hit put it. */
  function close({ toEditor = true } = {}) {
    const v = view();
    if (v) v.dispatch(v.state.tr.setMeta(FIND_KEY, { clear: true }));
    if (el) el.remove();
    el = input = count = replaceInput = replaceRow = null;
    if (toEditor && v) v.focus();
  }

  function destroy() {
    root.removeEventListener('os-find', onState);
    if (el) el.remove();
    el = input = count = replaceInput = replaceRow = null;
  }

  // index.js keeps this on the page object (`p.find`) and hands it to `page.replace` through
  // `editorApi.openFind`, so that a page in source mode reaches CodeMirror's panel instead
  // (QA F5). There is no module-level "the current bar" any more.
  return { open, close, destroy, isOpen: () => !!el };
}
