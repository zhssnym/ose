// Shell modules the editor needs but does not own. `shell/dialog.js` and `shell/state.js` are
// listed in CONTRACT.md but may not exist yet, so they are loaded lazily and fall back to a
// minimal inline implementation. When the shell lands, nothing here has to change.

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

/** CONTRACT: patchState(partial) -> Promise<void>. A no-op until shell/state.js exists. */
export async function patchState(partial) {
  const m = await optional('../shell/state.js');
  if (m && typeof m.patchState === 'function') return m.patchState(partial);
  return undefined;
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
