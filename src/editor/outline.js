// The outline (C2): `page.outline` opens a picker of the document's headings — the H1 title
// first, then every heading in the body indented by level — fuzzy-filtered like Ctrl+P.
// Enter or a click scrolls the heading to the top and puts the caret at its start. There is
// no panel: the picker is the whole feature (CLAUDE.md: minimal).
//
// Built on the shell's overlay stack (openOverlay) with the palette's `.pal` classes, exactly
// as pickPage in shell/dialog.js is, so Esc, click-outside and focus return are the same
// everywhere a list is chosen from.

import { esc } from '../registry.js';
import { openOverlay } from '../shell/dialog.js';
import { fuzzy, highlight } from '../shell/fuzzy.js';
import { caretAt } from './reveal.js';

/** A heading glyph on the shell's 16-unit icon grid, for the picker's head. */
const HEAD_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5v9M12.5 3.5v9M3.5 8h9"/></svg>';

/** Every heading in document order: `{level, text, pos}` with `pos` before the node. */
export function headingsOf(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true;
    out.push({ level: Number(node.attrs.level) || 1, text: node.textContent.replace(/\s+/g, ' ').trim(), pos });
    return false;
  });
  return out;
}

/**
 * @param {object} o
 * @param {any} o.view              the ProseMirror view of the body
 * @param {string|null} o.title     the page title (the H1 outside the body); null when the file has none
 * @param {() => void} [o.onTitle]  what choosing the title does: scroll to the top, caret in the title
 * Resolves to the chosen heading, or null when cancelled.
 */
export function pickHeading({ view, title, onTitle }) {
  const all = [];
  if (title !== null && title !== undefined) all.push({ level: 1, text: title || 'Untitled', pos: -1, isTitle: true });
  for (const h of headingsOf(view.state.doc)) all.push(h);
  // The heading the caret is under is the current one, preselected like pickPage's `current`.
  const caret = view.state.selection.from;
  let current = -1;
  all.forEach((h, i) => { if (h.pos < caret) current = i; });

  return new Promise((resolve) => {
    let done = false;
    const finish = (h) => {
      if (done) return;
      done = true;
      ov.close();
      resolve(h || null);
      if (!h) return;
      if (h.isTitle) { if (onTitle) onTitle(); return; }
      caretAt(view, h.pos + 1, { block: 'start', always: true, focus: true });
    };
    const ov = openOverlay({ width: 560, top: '15vh', className: 'pal pick ed-outline', onClose: () => { if (!done) { done = true; resolve(null); } } });
    ov.box.innerHTML = `
      <div class="pal-head">
        <span class="pal-icon">${HEAD_ICON}</span>
        <input class="pal-input" type="text" spellcheck="false" autocomplete="off" placeholder="Go to heading…" aria-label="Go to heading">
      </div>
      <div class="pal-list" role="listbox"></div>
      <div class="pal-foot mono-sm">
        <span><span class="kbd">↑</span><span class="kbd">↓</span> move</span>
        <span><span class="kbd">Enter</span> go</span>
        <span><span class="kbd">Esc</span> cancel</span>
        <span class="grow"></span>
        <span class="pal-mode">headings</span>
      </div>`;

    const input = ov.box.querySelector('.pal-input');
    const list = ov.box.querySelector('.pal-list');
    let items = [];
    let sel = 0;

    function build() {
      const q = input.value.trim();
      if (!q) {
        items = all.map((h) => ({ h, hits: null }));
        sel = Math.max(0, current);
      } else {
        items = all
          .map((h) => ({ h, m: fuzzy(h.text, q.toLowerCase()) }))
          .filter((x) => x.m)
          .sort((a, b) => b.m.score - a.m.score)
          .map((x) => ({ h: x.h, hits: x.m.hits }));
        sel = 0;
      }
      paint();
    }

    function paint() {
      list.textContent = '';
      if (!items.length) {
        list.innerHTML = `<div class="empty">${all.length ? 'no heading matches' : 'no headings in this page'}</div>`;
        return;
      }
      const frag = document.createDocumentFragment();
      items.forEach(({ h, hits }, i) => {
        const row = document.createElement('div');
        row.className = 'row pal-row' + (i === sel ? ' active' : '');
        row.dataset.i = i;
        row.setAttribute('role', 'option');
        // One indent step per level below the title; the level itself sits in the hint slot.
        row.innerHTML = '<span class="ed-ol-ind"></span>'.repeat(Math.max(0, h.level - 1))
          + `<span class="grow">${highlight(h.text || 'Untitled', hits)}</span>`
          + `<span class="pal-hint">H${h.level}</span>`
          + (all[current] === h ? '<span class="pal-hint">current</span>' : '');
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
      else if (e.key === 'Enter') { e.preventDefault(); if (items.length) finish(items[sel].h); }
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.pal-row');
      if (!row) return;
      finish(items[+row.dataset.i].h);
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
