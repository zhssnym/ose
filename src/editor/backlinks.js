// Linked mentions (batch 12, package P7, N6).
//
// `lib/links.js findInbound` has been in the tree since batch 9 with no caller: this is the
// caller. Under the page body sits one box, `linked from`, collapsed, listing every page that
// links here — the page's title, and the line the link is on, which is the only thing that
// makes a backlink worth reading. A row opens that page at that line.
//
// It costs one vault search and one read per candidate, so it runs after the page is up, and
// again, debounced, on any `fs` event. A page with nothing pointing at it draws nothing at
// all: an empty box on every page would be permanent furniture for a rare case.
//
// The box is mounted from a ProseMirror plugin's `view`, which is the one moment the editor
// says where its DOM went without this module having to know anything about index.js.

import { Plugin } from '@milkdown/kit/prose/state';
import { bus, commands, debounce, esc, findInbound, navigate, titleOf } from './host.js';
import { toast } from './deps.js';
import './backlinks.css';

/** path -> how many pages link to it, as last computed. Read by the editor's meta line. */
const counts = new Map();
/** The editor API (index.js `editorApi`), handed over once at boot. */
let api = null;
/** The box on screen right now, or null: one page is open at a time, so one box. */
let live = null;

/** How many pages link to `path`; 0 when it has not been computed, or when none do. */
export function backlinkCount(path) {
  return counts.get(String(path || '')) || 0;
}

function build(path) {
  const box = document.createElement('section');
  box.className = 'ed-bl';
  box.hidden = true;
  box.innerHTML = `
    <button type="button" class="ed-bl-head" aria-expanded="false">
      <span class="ed-bl-key">linked from</span>
      <span class="ed-bl-n mono-sm">0</span>
    </button>
    <div class="ed-bl-list" role="list" hidden></div>`;

  const head = box.querySelector('.ed-bl-head');
  const list = box.querySelector('.ed-bl-list');
  const nEl = box.querySelector('.ed-bl-n');

  const setOpen = (open) => {
    head.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
  };
  head.addEventListener('click', () => setOpen(head.getAttribute('aria-expanded') !== 'true'));
  // The same keys every list in the app answers: arrows move, Enter opens (the rows are
  // buttons, so Enter is the browser's).
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...list.querySelectorAll('.ed-bl-row')];
    const at = rows.indexOf(document.activeElement);
    if (at < 0) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
  });

  return {
    box, path,
    open() {
      if (box.hidden) return false;
      setOpen(true);
      (list.querySelector('.ed-bl-row') || head).focus();
      return true;
    },
    paint(pages) {
      const n = pages.length;
      counts.set(path, n);
      nEl.textContent = String(n);
      box.hidden = n === 0;
      list.textContent = '';
      for (const p of pages) {
        for (const hit of p.lines) {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'row ed-bl-row';
          row.setAttribute('role', 'listitem');
          row.innerHTML = `<span class="ed-bl-page">${esc(titleOf(p.path))}</span>`
            + `<span class="grow ed-bl-line">${esc(hit.text || '')}</span>`
            + `<span class="hint">L${esc(hit.line)}</span>`;
          row.addEventListener('click', () => navigate({ type: 'page', path: p.path, line: hit.line }));
          list.appendChild(row);
        }
      }
      // The meta line above the body says `· N linked`: P5's to draw, ours to ask for.
      if (api && typeof api.updateMeta === 'function') {
        try { api.updateMeta(); } catch (e) { console.error('[backlinks] meta', e); }
      }
    },
  };
}

async function compute(view) {
  if (!view || !view.path) return;
  let pages = [];
  try {
    pages = await findInbound(view.path);
  } catch (e) {
    console.error('[backlinks]', e);
    return;
  }
  if (live !== view || !view.box.isConnected) return;
  view.paint(pages);
}

/**
 * `extensions.js` asks for this. The plugin does nothing to the document; its `view` is only
 * the hook that says the editor's DOM exists, and later that it is gone.
 */
export function plugins(_ctx, o) {
  return [new Plugin({
    view: (editorView) => {
      const path = typeof o?.pagePath === 'function' ? o.pagePath() || '' : '';
      const col = editorView.dom.closest('.ed');
      const body = col ? col.querySelector('.ed-body') : null;
      if (!col || !body || !path) return {};
      const v = build(path);
      col.insertBefore(v.box, body.nextSibling);
      live = v;
      void compute(v);
      const off = bus.on('fs', debounce(() => { if (live === v) void compute(v); }, 400));
      return {
        destroy: () => {
          off();
          if (live === v) live = null;
          v.box.remove();
        },
      };
    },
  })];
}

export function registerCommands(editorApi) {
  api = editorApi;
  commands.register({
    id: 'page.backlinks',
    title: 'Show linked mentions',
    group: 'page',
    hint: 'the pages that link here',
    when: () => !!(api && api.hasPage && api.hasPage()),
    // Nothing links here: say so, because a command that appears to do nothing is a bug
    // report (D5). The box only exists while something points at the page.
    run: () => { if (!(live && live.open())) toast('nothing links to this page', 'info', 2200); },
  });
}
