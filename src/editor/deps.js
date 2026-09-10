// Shell modules the editor needs but does not own. `shell/dialog.js` is listed in CONTRACT.md
// but the editor must still work without it, so it is loaded lazily and falls back to a
// minimal inline implementation. Everything it answers is stateless, which is what makes the
// lazy import safe there.
//
// `shell/state.js` is imported statically, and must be: it is the one shell module that holds
// state. Vite serves an HMR-refreshed module under a `?t=` query, so a bare `import()` of the
// same path resolves to a *second* instance with its own empty cache and `loaded === false` —
// a `patchState` into it is dropped on the floor and `stateCache()` is always `{}`. That is
// what happened to `editor.last`, and it is why `sourcePages` never reached `.ose/state.json`.

import { patchState as shellPatchState, stateCache } from '../shell/state.js';

const cache = new Map();

async function optional(path) {
  if (cache.has(path)) return cache.get(path);
  let mod = null;
  try { mod = await import(/* @vite-ignore */ path); } catch { mod = null; }
  cache.set(path, mod);
  return mod;
}

/** CONTRACT: prompt({title, value?, placeholder?, ok?}) -> Promise<string|null> */
export async function prompt(opts) {
  const m = await optional('../shell/dialog.js');
  if (m && typeof m.prompt === 'function') return m.prompt(opts);
  return fallbackPrompt(opts);
}

/** CONTRACT: confirm({title, body?, ok?, danger?}) -> Promise<boolean> */
export async function confirm(opts) {
  const m = await optional('../shell/dialog.js');
  if (m && typeof m.confirm === 'function') return m.confirm(opts);
  return fallbackConfirm(opts);
}

/**
 * A choice between more than two actions (batch 9, B1). CONTRACT's `confirm` is two-way and
 * its cancel button reads "Cancel", so a question like "reload the file or overwrite it"
 * cannot be asked honestly on it: whichever meaning went on Cancel would be a trap. This
 * builds the same `.dlg` shell on the overlay stack when the shell is there, so Esc,
 * click-outside and focus return behave like every other dialog.
 *
 * choose({title, body?, options:[{label, value, kind?:'primary'|'danger'}], cancel?})
 *   -> Promise<value>   Esc or a click outside resolves to `cancel` (null by default).
 * Put the safest option first: it gets the initial focus.
 */
export async function choose(opts) {
  const m = await optional('../shell/dialog.js');
  if (m && typeof m.openOverlay === 'function') return shellChoose(m, opts);
  return fallbackChoose(opts);
}

function shellChoose(m, { title = '', body = '', options = [], cancel = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = m.openOverlay({
      width: 460, className: 'dlg-ov',
      onClose: () => { if (!done) { done = true; resolve(cancel); } },
    });
    const box = ov.box;
    box.classList.add('dlg');
    const head = document.createElement('div');
    head.className = 'dlg-head label';
    head.textContent = title;
    const bodyEl = document.createElement('div');
    bodyEl.className = 'dlg-body';
    if (body) {
      const p = document.createElement('p');
      p.className = 'dlg-text';
      p.textContent = body;
      bodyEl.append(p);
    }
    const foot = document.createElement('div');
    foot.className = 'dlg-foot';
    for (const o of options) {
      const b = document.createElement('button');
      b.className = 'btn' + (o.kind ? ' ' + o.kind : '');
      b.textContent = o.label;
      b.addEventListener('click', () => finish(o.value));
      foot.append(b);
    }
    box.append(head, bodyEl, foot);
    requestAnimationFrame(() => { const first = foot.querySelector('.btn'); if (first) first.focus(); });
  });
}

function fallbackChoose({ title = '', body = '', options = [], cancel = null } = {}) {
  let el = null;
  if (body) {
    el = document.createElement('div');
    el.className = 'ed-dialog-body';
    el.textContent = body;
  }
  // `surface` gives Esc and a click outside to the first button and Enter to the last. The
  // first option is the safe one by convention (callers put "Cancel" there), so dismissing
  // answers through it; `cancel` itself is only used when there is nothing to show.
  if (!options.length) return Promise.resolve(cancel);
  return surface(title, el, options.map((o) => ({ label: o.label, kind: o.kind, value: () => o.value })));
}

/** CONTRACT: toast(text, kind?, ms?) -> void. Without the shell, the console. */
export async function toast(text, kind = 'info', ms) {
  const m = await optional('../shell/dialog.js');
  if (m && typeof m.toast === 'function') { m.toast(text, kind, ms); return; }
  (kind === 'err' ? console.error : console.log)('[editor]', text);
}

/**
 * CONTRACT: pickPage({title}) -> Promise<path|null>  (the quick-open list, fuzzy, Enter).
 * Until the shell exports it, `pickFile` is the same surface over `.md`; with no shell at all
 * the fallback below lists the vault itself.
 */
export async function pickPage(opts) {
  const m = await optional('../shell/dialog.js');
  const title = (opts && opts.title) || 'Link to page…';
  if (m && typeof m.pickPage === 'function') return m.pickPage({ ...opts, title });
  if (m && typeof m.pickFile === 'function') return m.pickFile({ title, ext: 'md' });
  return fallbackPickPage(title);
}

/**
 * CONTRACT: openOverlay({width, className, onClose}) -> {el, box, close}, the shell's dialog
 * stack (Esc, click outside, focus trap, focus return). `null` when the shell is not there;
 * a caller that needs more than two buttons falls back to `choose` above, which builds the
 * same look on a plain scrim.
 */
export async function openOverlay(opts) {
  const m = await optional('../shell/dialog.js');
  return m && typeof m.openOverlay === 'function' ? m.openOverlay(opts) : null;
}

/** CONTRACT: patchState(partial) -> Promise<void>. Merged shallow at the top level. */
export async function patchState(partial) {
  return shellPatchState(partial);
}

/** The loaded `.ose/state.json`, read-only. `{}` until the shell has loaded it. */
export async function readState() {
  const c = stateCache();
  return c && typeof c === 'object' ? c : {};
}

// ---------------------------------------------------------------------------
// Fallbacks. Same shape and the same look as the rest of the app, so a missing shell is a
// missing feature and not a broken screen. Nobody calls window.prompt/confirm.

function surface(title, bodyEl, buttons) {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'ed-dialog-scrim';
    const box = document.createElement('div');
    box.className = 'surface ed-dialog';
    const head = document.createElement('div');
    head.className = 'ed-dialog-title';
    head.textContent = title || '';
    const foot = document.createElement('div');
    foot.className = 'ed-dialog-foot';
    box.append(head);
    if (bodyEl) box.append(bodyEl);
    box.append(foot);
    scrim.append(box);

    const done = (value) => { scrim.remove(); document.removeEventListener('keydown', onKey, true); resolve(value); };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'btn' + (b.kind ? ' ' + b.kind : '');
      el.textContent = b.label;
      el.onclick = () => done(b.value());
      foot.append(el);
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(buttons[0].value()); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); done(buttons[buttons.length - 1].value()); }
    };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) done(buttons[0].value()); });
    document.body.append(scrim);
    (box.querySelector('input') || box.querySelector('.btn')).focus();
    if (box.querySelector('input')) box.querySelector('input').select();
  });
}

function fallbackPrompt({ title, value = '', placeholder = '', ok = 'OK' } = {}) {
  const input = document.createElement('input');
  input.className = 'input';
  input.value = value;
  input.placeholder = placeholder;
  return surface(title, input, [
    { label: 'Cancel', value: () => null },
    { label: ok, kind: 'primary', value: () => (input.value.trim() ? input.value.trim() : null) },
  ]);
}

/** The quick-open list, in miniature: every `.md` in the vault, filtered by substring. */
async function fallbackPickPage(title) {
  const { bridge } = await import('../bridge/index.js');
  const all = [];
  const walk = (n) => {
    if (!n) return;
    if (n.kind === 'file') { if (n.ext === 'md') all.push(n.path); return; }
    for (const c of n.children || []) walk(c);
  };
  try { walk(await bridge.tree()); } catch { /* an empty list still cancels cleanly */ }

  const box = document.createElement('div');
  box.className = 'ed-pick';
  const input = document.createElement('input');
  input.className = 'input';
  input.placeholder = 'Type to filter';
  const list = document.createElement('div');
  list.className = 'ed-pick-list';
  box.append(input, list);

  let items = all;
  let sel = 0;
  const paint = () => {
    list.textContent = '';
    for (let i = 0; i < items.length && i < 200; i++) {
      const row = document.createElement('div');
      row.className = 'row' + (i === sel ? ' current' : '');
      row.textContent = items[i];
      row.dataset.i = String(i);
      list.append(row);
    }
    list.querySelector('.row.current')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    items = q ? all.filter((p) => p.toLowerCase().includes(q)) : all;
    sel = 0;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); sel = Math.min(sel + 1, items.length - 1); paint(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); sel = Math.max(sel - 1, 0); paint(); }
  });
  paint();

  const chosen = { path: null };
  list.addEventListener('click', (e) => {
    const row = e.target instanceof Element ? e.target.closest('.row') : null;
    if (!row) return;
    chosen.path = items[+row.dataset.i] ?? null;
    box.closest('.ed-dialog')?.querySelector('.btn.primary')?.click();
  });
  const value = await surface(title, box, [
    { label: 'Cancel', value: () => null },
    { label: 'Link', kind: 'primary', value: () => chosen.path ?? items[sel] ?? null },
  ]);
  return value;
}

function fallbackConfirm({ title, body = '', ok = 'OK', danger = false } = {}) {
  let el = null;
  if (body) {
    el = document.createElement('div');
    el.className = 'ed-dialog-body';
    el.textContent = body;
  }
  return surface(title, el, [
    { label: 'Cancel', value: () => false },
    { label: ok, kind: danger ? 'danger' : 'primary', value: () => true },
  ]);
}
