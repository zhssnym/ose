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
