// The choose-vault surface, the recent-vault chooser, and the one dialog that says the vault
// is gone. Mounted by main.js instead of the shell when the host has no root: one sentence,
// the vaults this machine has opened before, one primary button, and a title bar so the
// frameless window can still be dragged and closed. Nothing else exists yet: no sidebar, no
// commands, no state file (the state file lives inside the vault).
//
// The title bar is drawn here rather than by titlebar.js, whose imports (sidebar, router,
// editor) all assume a vault. Same classes, so it is pixel for pixel the app's own bar.
// See docs/HOST.md "The vault root".
import { ose } from 'ose:kernel';
import { esc, glyph, openOverlay } from 'ose:ui';
import { isHost, dragWindow, onMaximize, exeDir } from './host.js';

const { store } = ose;
const HOST = isHost;

/**
 * After `pickVault` the whole app boots again against the new root. `replace(pathname)` is a
 * reload that also drops the page query, which is how the dev flag `?novault=1` is cleared
 * (http.js); in the host the path is the app's own and this is a plain reload.
 */
export function reloadIntoVault() {
  // In the host the kernel reloads the window it is in, which brings the shell back up.
  // In the browser `replace(pathname)` is a reload that also drops the
  // page query, which is how the dev flag `?novault=1` is cleared (the dev bridge).
  if (isHost()) { void ose.reload(); return; }
  location.replace(location.pathname);
}

/* ------------------------------------------------------------------ recent vaults */

/** `[{path, name, exists, current}]`, newest first. Never throws: no list is an empty list. */
export async function recentVaults() {
  try {
    const list = await ose.vault.recent();
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('[shell] recent vaults', e && e.message ? e.message : e);
    return [];
  }
}

/** One row of the recent list, in both places it is drawn. */
function recentRow(v, i) {
  return `<button type="button" class="row vault-row${v.exists ? '' : ' gone'}" data-i="${i}" data-path="${esc(v.path)}" title="${esc(v.path)}">
      <span class="vault-name">${esc(v.name || v.path)}</span>
      <span class="grow vault-path mono-sm">${esc(v.path)}</span>
      ${v.current ? '<span class="pal-hint">current</span>' : ''}
      ${v.exists ? '' : '<span class="pal-hint gone">missing</span>'}
    </button>`;
}

/**
 * Up and Down walk the list, Delete and Backspace forget the focused vault. Returns the
 * teardown nobody needs (the nodes go with their dialog), so callers can ignore it.
 */
function bindRowKeys(box, { onForget }) {
  box.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const rows = [...box.querySelectorAll('.vault-row')];
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      const from = at < 0 ? (d > 0 ? -1 : 0) : at;
      rows[(from + d + rows.length) % rows.length].focus();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && at >= 0) {
      e.preventDefault();
      onForget(rows[at].dataset.path, at);
    }
  });
}

/**
 * `Change vault…` and the first-run surface both come here: the vaults this machine has
 * opened before, then the native folder picker. Resolves to `{root, name}` once a vault is
 * adopted (the host has already remembered and started watching it), or `null` when the user
 * backed out. With nothing to remember, it is the folder picker and no dialog at all (S46).
 */
export async function chooseVault() {
  const list = (await recentVaults()).filter((v) => !v.current);
  if (!list.length) return ose.vault.pick();

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = openOverlay({
      width: 560, className: 'dlg vault-pick', title: 'Open a vault',
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    let items = list;

    const paint = () => {
      ov.box.innerHTML = `
        <div class="dlg-head" id="vault-pick-head">Open a vault</div>
        <div class="dlg-body">
          <p class="dlg-text">A vault is any folder. These are the ones this machine has opened.</p>
          <div class="vault-list">${items.map(recentRow).join('')}</div>
        </div>
        <div class="dlg-foot">
          <span class="grow mono-sm faint"><span class="kbd">Del</span> forget</span>
          <button class="btn" data-act="cancel">Cancel</button>
          <button class="btn primary" data-act="pick">Choose folder…</button>
        </div>`;
      ov.box.setAttribute('aria-labelledby', 'vault-pick-head');
    };
    paint();

    ov.box.addEventListener('click', async (e) => {
      if (e.target.closest('[data-act="cancel"]')) { finish(null); return; }
      if (e.target.closest('[data-act="pick"]')) {
        try { finish(await ose.vault.pick()); } catch (err) { finish(null); console.error('[shell] pickVault', err); }
        return;
      }
      const row = e.target.closest('.vault-row');
      if (!row) return;
      try {
        finish(await ose.vault.open(row.dataset.path));
      } catch (err) {
        // A folder that has been deleted or unplugged: say so on the row and leave the dialog.
        row.classList.add('gone');
        row.title = String(err && err.message ? err.message : err);
      }
    });

    bindRowKeys(ov.box, {
      onForget: async (path) => {
        try { await ose.vault.forget(path); } catch (err) { console.warn('[shell] forgetVault', err); }
        items = items.filter((v) => v.path !== path);
        if (!items.length) { finish(null); return; }
        paint();
        requestAnimationFrame(() => ov.box.querySelector('.vault-row')?.focus());
      },
    });

    requestAnimationFrame(() => ov.box.querySelector('.vault-row')?.focus());
  });
}

/* ------------------------------------------------------------------ the vault is gone */

let lostOv = null;

/**
 * The vault folder itself stopped existing: renamed, unmounted, deleted (S29). One dialog,
 * once — not a toast per failed call — with the two answers there are. `Retry` reloads the
 * app when the folder is back, because every plugin read its world from that folder at boot.
 * The watcher saying the vault is back closes it by itself.
 */
export function vaultLost(root) {
  if (lostOv) return;
  const path = root || (store.get('root') || {}).root || '';
  const ov = openOverlay({ width: 440, className: 'dlg', title: 'The vault is gone', onClose: () => { lostOv = null; } });
  lostOv = ov;
  ov.box.innerHTML = `
    <div class="dlg-head" id="vault-lost-head">The vault is gone</div>
    <div class="dlg-body">
      <p class="dlg-text">The folder this window is open on cannot be read any more. It may have been renamed, moved, or unplugged.</p>
      ${path ? `<div class="mono-sm faint text-select">${esc(path)}</div>` : ''}
    </div>
    <div class="dlg-foot">
      <button class="btn" data-act="retry">Retry</button>
      <button class="btn primary" data-act="change">Change vault…</button>
    </div>`;
  ov.box.setAttribute('aria-labelledby', 'vault-lost-head');

  const retry = ov.box.querySelector('[data-act="retry"]');
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    let back = false;
    try { const st = await ose.files.stat(''); back = !!(st && st.exists); } catch { back = false; }
    if (back) { reloadIntoVault(); return; }
    retry.disabled = false;
    retry.focus();
  });
  ov.box.querySelector('[data-act="change"]').addEventListener('click', async () => {
    const picked = await chooseVault().catch(() => null);
    if (picked && picked.root) reloadIntoVault();
  });
  requestAnimationFrame(() => retry.focus());
}

/** The watcher found the folder again: drop the dialog and start over on it. */
export function vaultFound() {
  if (!lostOv) return;
  lostOv.close();
  lostOv = null;
  reloadIntoVault();
}

/* ------------------------------------------------------------------ the first run */

export async function mountVaultChooser(rootEl) {
  if (ose.platform === 'macos') document.documentElement.classList.add('mac');
  document.documentElement.dataset.os =
    ose.platform === 'macos' ? 'mac' : ose.platform === 'linux' ? 'other' : 'win';
  // The theme only: there is no page column to mount a router into and no command to bind.
  ose.init({ keys: false });

  rootEl.textContent = '';
  const surface = document.createElement('div');
  surface.className = 'vault';
  surface.appendChild(titlebar());

  const body = document.createElement('main');
  body.className = 'vault-body';
  body.innerHTML = `
    <p class="vault-text">Ose needs a folder to open — a vault is any folder of markdown files.</p>
    <button class="btn primary vault-pick" type="button">Choose folder…</button>
    <div class="vault-hint mono-sm"></div>
    <div class="vault-recent" hidden><div class="label">recent</div><div class="vault-list"></div></div>
    <div class="vault-err mono-sm" role="status" hidden></div>`;
  surface.appendChild(body);
  rootEl.appendChild(surface);

  const pick = body.querySelector('.vault-pick');
  const hint = body.querySelector('.vault-hint');
  const err = body.querySelector('.vault-err');
  const recentBox = body.querySelector('.vault-recent');
  const list = body.querySelector('.vault-list');

  // The suggestion: where the executable sits (the folder holding Ose.app on macOS). The
  // picker opens there too, so the line says what the button will show. A kernel that does not
  // say draws no line at all.
  exeDir().then((dir) => { if (dir) { hint.textContent = `suggested: ${dir}`; hint.title = dir; } });

  // The vaults this machine has opened before, so the second run is one keystroke (S46).
  let items = await recentVaults();
  const paintRecent = () => {
    recentBox.hidden = !items.length;
    list.innerHTML = items.map(recentRow).join('');
  };
  paintRecent();

  let busy = false;
  const fail = (e) => {
    err.textContent = String(e && e.message ? e.message : e);
    err.hidden = false;
  };
  const choose = async () => {
    if (busy) return;
    busy = true;
    pick.disabled = true;
    err.hidden = true;
    try {
      const picked = await ose.vault.pick();
      if (picked && picked.root) { reloadIntoVault(); return; }
    } catch (e) {
      fail(e);
    }
    busy = false;
    pick.disabled = false;
    pick.focus();
  };
  pick.addEventListener('click', choose);

  list.addEventListener('click', async (e) => {
    const row = e.target.closest('.vault-row');
    if (!row || busy) return;
    busy = true;
    err.hidden = true;
    try {
      const opened = await ose.vault.open(row.dataset.path);
      if (opened && opened.root) { reloadIntoVault(); return; }
    } catch (e2) {
      fail(e2);
    }
    busy = false;
  });

  bindRowKeys(body, {
    onForget: async (path) => {
      try { await ose.vault.forget(path); } catch (e) { console.warn('[shell] forgetVault', e); }
      items = items.filter((v) => v.path !== path);
      paintRecent();
      (list.querySelector('.vault-row') || pick).focus();
    },
  });

  // Enter picks because the button has focus; Esc does nothing (there is nothing to go back to).
  requestAnimationFrame(() => pick.focus());
}

function titlebar() {
  const el = document.createElement('header');
  el.className = 'titlebar';
  el.innerHTML = `
    <div class="tb-mark" title="Ose"><span>ose</span></div>
    <div class="tb-drag"></div>
    <div class="tb-win${HOST() ? '' : ' dim'}">
      <button class="tb-btn" data-w="min" title="Minimize" aria-label="Minimize">${glyph('min')}</button>
      <button class="tb-btn" data-w="max" title="Maximize" aria-label="Maximize">${glyph('max')}</button>
      <button class="tb-btn close" data-w="close" title="Close" aria-label="Close">${glyph('close')}</button>
    </div>`;
  el.querySelectorAll('.tb-btn').forEach((b) => {
    if (!HOST()) b.tabIndex = -1;
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', () => {
      if (!HOST()) return;
      const w = b.dataset.w;
      if (w === 'min') ose.window.minimize();
      else if (w === 'max') ose.window.maximize();
      else ose.window.close();
    });
  });
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.tb-btn') || !HOST()) return;
    dragWindow();
  });
  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tb-btn') || !HOST()) return;
    ose.window.maximize();
  });
  onMaximize((v) => document.documentElement.classList.toggle('maximized', v));
  return el;
}
