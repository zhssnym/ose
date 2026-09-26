// The choose-vault surface, the recent-vault chooser, the one dialog that says the vault is
// gone, and windows (X6: one window per vault). Mounted by main.js instead of the shell when
// the host has no root: one sentence, the vaults this machine has opened before, one primary
// button. Nothing else exists yet: no sidebar, no commands, no state file (the state file
// lives inside the vault). The window's frame is the platform's own (X9), so the surface
// draws a toolbar with the app mark and nothing to drag or close.
//
// A vault can open in a window of its own: Shift+Enter on a row of either list, or the "Open
// in new window" button, asks the host (`ose.windows.open`). There is never a second window on
// one vault: the host focuses the one that has it, and so does Change vault… when the vault
// asked for is already open elsewhere. See docs/HOST.md "The vault root" and "Windows".
import { ose } from 'ose:kernel';
import { esc, openOverlay, confirm, toast } from 'ose:ui';
import { isHost, exeDir, onVaultChangeRequested } from './host.js';
import { errorOf } from './paths.js';

const { store } = ose;

/** What is said when the vault asked for is open in another window, which the host focused. */
const FOCUSED = 'That vault is open in another window';

/** An answer of `ose.vault.open` that did not adopt: the vault is another window's (X6). */
const wasFocused = (r) => !!r && (r.focused === true || r.status === 'focused');

/**
 * Open `root` in a window of its own, or a new window with no vault when `root` is absent
 * (`app.new-window`). The host focuses the window that already has that vault instead of
 * making a second one, and this says so. In the browser there is one window, and a toast says
 * that too.
 * @param {string} [root] an absolute folder
 * @returns {Promise<boolean>} whether a window was opened or brought forward
 */
export async function openInNewWindow(root) {
  if (root && ose.vault.root && sameRoot(root, ose.vault.root)) {
    toast('That vault is open in this window', 'info', 2600);
    return false;
  }
  let r;
  try { r = await ose.windows.open(root || undefined); } catch (e) {
    const err = errorOf(e);
    if (err.code === 'unsupported' || !isHost()) toast('A new window needs the app', 'info', 2600);
    else toast(`Could not open a new window: ${err.message}`, 'err', 0);
    return false;
  }
  if (root && r && r.created === false) toast(FOCUSED, 'info', 2600);
  return true;
}

/**
 * Boot again on the vault the host has open now. Only for a window with nothing in it to leave
 * — the first-run surface — or one that has already been let go (`switchVault`): the leave
 * gate is skipped. In the host the kernel reloads the window it is in; in the browser
 * `replace(pathname)` is a reload that also drops the page query, which is how the dev flag
 * `?novault=1` is cleared (the dev bridge).
 */
export function reloadIntoVault() {
  if (isHost()) { void ose.reload({ skipLeave: true }); return; }
  location.replace(location.pathname);
}

/** Two roots name the same folder: Windows and macOS compare paths without case. */
function sameRoot(a, b) {
  const n = (x) => String(x || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return ose.platform === 'linux' ? n(a) === n(b) : n(a).toLowerCase() === n(b).toLowerCase();
}

let switching = null;

/**
 * Change the vault this window is open on (C5). One order, whoever asks — Change vault…, the
 * lost-vault dialog, a second launch naming another folder:
 *
 * 1. `ose.window.leave('vault-change')`: the open page is saved into the vault it came from,
 *    and a page that cannot be saved keeps the window (the kernel says so, with [Show]).
 * 2. `ose.vault.open(root)` adopts the folder. If it cannot, the window is handed back
 *    (`ose.window.stay()`) and the reason is said.
 * 3. The window boots again on it, without asking a second time.
 *
 * `anyway` is for the lost vault only: its pages cannot be saved where they came from, so a
 * refused leave asks once whether to switch all the same. Their text is kept on this machine
 * as a draft and offered again when that vault is open (docs/SHELL.md "Recovered changes").
 * One switch at a time; a second call answers the first one's promise.
 *
 * @param {string} root  an absolute folder
 * @param {{anyway?: boolean}} [opts]
 * @returns {Promise<boolean>} false when the window stayed where it was
 */
export function switchVault(root, { anyway = false } = {}) {
  if (switching) return switching;
  switching = (async () => {
    if (!root) return false;
    if (ose.vault.root && sameRoot(root, ose.vault.root)) {
      toast('that vault is already open', 'info', 2600);
      return false;
    }
    let left = false;
    try { left = await ose.window.leave('vault-change'); } catch (e) { console.error('[shell] leave', e); left = false; }
    if (!left) {
      if (!anyway) return false;
      const ok = await confirm({
        title: 'Switch without saving?',
        body: 'A page could not be saved into the vault that is gone. Its text stays on this machine and is offered again when that vault is open.',
        ok: 'Switch anyway', danger: true,
      });
      if (!ok) return false;
    }
    let opened;
    try {
      opened = await ose.vault.open(root);
    } catch (e) {
      if (left) ose.window.stay();
      toast(`could not open ${root}: ${String(e && e.message ? e.message : e)}`, 'err', 0);
      return false;
    }
    // Open in another window already (X6): the host brought that window forward, and this one
    // stays as it was, with its page back in hand.
    if (wasFocused(opened)) {
      if (left) ose.window.stay();
      toast(FOCUSED, 'info', 3200);
      return false;
    }
    reloadIntoVault();
    return true;
  })().finally(() => { switching = null; });
  return switching;
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
 * Up and Down walk the list, Delete and Backspace forget the focused vault, Shift+Enter opens
 * it in a new window (`onWindow`). Returns the teardown nobody needs (the nodes go with their
 * dialog), so callers can ignore it.
 */
function bindRowKeys(box, { onForget, onWindow }) {
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
    } else if (e.key === 'Enter' && e.shiftKey && at >= 0 && onWindow) {
      e.preventDefault();
      onWindow(rows[at].dataset.path, at);
    }
  });
}

/**
 * `Change vault…` and the lost-vault dialog come here: the vaults this machine has opened
 * before, then the native folder picker. With nothing to remember, it is the folder picker and
 * no dialog at all (S46). Resolves to `{root, name}`, or `null` when the user backed out.
 *
 * `adopt` (default true) says whether the choice is opened as it is made. A window with a page
 * in it passes `false`: the folder is only chosen, and `switchVault` adopts it once the page
 * has been saved where it belongs (C5).
 *
 * Shift+Enter or Shift+click on a row, or the "Open in new window" button, opens that vault in
 * a window of its own instead (X6): this window stays, and the answer is `null`. The button
 * with no row focused asks for the folder first.
 *
 * @param {{adopt?: boolean}} [opts]
 */
export async function chooseVault({ adopt = true } = {}) {
  const pick = () => ose.vault.pick({ adopt });
  const list = (await recentVaults()).filter((v) => !v.current);
  if (!list.length) return pick();

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
          <span class="grow mono-sm faint"><span class="kbd">Del</span> forget <span class="kbd">Shift+Enter</span> new window</span>
          <button class="btn" data-act="cancel">Cancel</button>
          <button class="btn" data-act="window">Open in new window</button>
          <button class="btn primary" data-act="pick">Choose folder…</button>
        </div>`;
      ov.box.setAttribute('aria-labelledby', 'vault-pick-head');
    };
    paint();

    // The row the keyboard last stood on: what "Open in new window" opens.
    let lastRow = null;
    ov.box.addEventListener('focusin', (e) => {
      const row = e.target.closest && e.target.closest('.vault-row');
      if (row) lastRow = row.dataset.path;
    });
    const inWindow = async (path) => {
      let root = path;
      if (!root) {
        const picked = await ose.vault.pick({ adopt: false }).catch(() => null);
        root = picked && picked.root;
      }
      if (!root) return;
      if (await openInNewWindow(root)) finish(null);
    };

    ov.box.addEventListener('click', async (e) => {
      if (e.target.closest('[data-act="cancel"]')) { finish(null); return; }
      if (e.target.closest('[data-act="window"]')) { await inWindow(lastRow); return; }
      if (e.target.closest('[data-act="pick"]')) {
        try { finish(await pick()); } catch (err) { finish(null); console.error('[shell] pickVault', err); }
        return;
      }
      const row = e.target.closest('.vault-row');
      if (!row) return;
      const v = items[+row.dataset.i];
      if (e.shiftKey) { await inWindow(row.dataset.path); return; }
      if (!adopt) {
        // Only chosen: the switch adopts it. A folder this machine says is missing is not
        // offered as an answer; the row says so and the dialog stays.
        if (v && v.exists === false) { row.classList.add('gone'); row.title = 'This folder is missing.'; return; }
        finish({ root: row.dataset.path, name: (v && v.name) || '' });
        return;
      }
      try {
        const opened = await ose.vault.open(row.dataset.path);
        if (wasFocused(opened)) { toast(FOCUSED, 'info', 3200); finish(null); return; }
        finish(opened);
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
        if (lastRow === path) lastRow = null;
        if (!items.length) { finish(null); return; }
        paint();
        requestAnimationFrame(() => ov.box.querySelector('.vault-row')?.focus());
      },
      onWindow: (path) => { void inWindow(path); },
    });

    requestAnimationFrame(() => ov.box.querySelector('.vault-row')?.focus());
  });
}

/* ------------------------------------------------------------------ the vault is gone */

let lostOv = null;

/**
 * The vault folder itself stopped existing: renamed, unmounted, deleted (S29). One dialog,
 * once — not a toast per failed call — with the two answers there are. `Retry` closes it when
 * the folder is back, and so does the watcher saying so. Nothing reloads: the window, the open
 * page and its unsaved text are all still here, and the watcher's `rescan` brings the tree up
 * to date (C5).
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
    if (back) { closeLost(); return; }
    retry.disabled = false;
    retry.focus();
  });
  ov.box.querySelector('[data-act="change"]').addEventListener('click', async () => {
    const picked = await chooseVault({ adopt: false }).catch(() => null);
    if (picked && picked.root) await switchVault(picked.root, { anyway: true });
  });
  requestAnimationFrame(() => retry.focus());
}

function closeLost() {
  if (!lostOv) return;
  const ov = lostOv;
  lostOv = null;
  ov.close();
}

/**
 * The watcher found the folder again: the dialog goes, and that is all. The page on screen
 * never left, and a reload here would throw away whatever it holds that is not on disk yet.
 */
export function vaultFound() {
  closeLost();
}

/**
 * A second launch named another folder (the host's `vault` event with `requested`): the
 * same switch Change vault… makes, the open page saved first.
 * @param {{root: string, name?: string}} d
 */
export function vaultRequested(d) {
  if (!d || !d.root) return;
  void switchVault(d.root);
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
  surface.appendChild(toolbar());

  const body = document.createElement('main');
  body.className = 'vault-body';
  body.innerHTML = `
    <p class="vault-text">Ose needs a folder to open — a vault is any folder of markdown files.</p>
    <div class="vault-acts">
      <button class="btn primary vault-pick" type="button">Choose folder…</button>
      <button class="btn vault-window" type="button">Open in new window…</button>
    </div>
    <div class="vault-hint mono-sm"></div>
    <div class="vault-recent" hidden><div class="label">Recent</div><div class="vault-list"></div></div>
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
  exeDir().then((dir) => { if (dir) { hint.textContent = `Suggested: ${dir}`; hint.title = dir; } });

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
  // A vault in a window of its own, this one staying on the chooser (X6).
  body.querySelector('.vault-window').addEventListener('click', async () => {
    const picked = await ose.vault.pick({ adopt: false }).catch((e) => { fail(e); return null; });
    if (picked && picked.root) await openInNewWindow(picked.root);
  });

  list.addEventListener('click', async (e) => {
    const row = e.target.closest('.vault-row');
    if (!row || busy) return;
    if (e.shiftKey) { await openInNewWindow(row.dataset.path); return; }
    busy = true;
    err.hidden = true;
    try {
      const opened = await ose.vault.open(row.dataset.path);
      if (wasFocused(opened)) { toast(FOCUSED, 'info', 3200); busy = false; return; }
      if (opened && opened.root) { reloadIntoVault(); return; }
    } catch (e2) {
      fail(e2);
    }
    busy = false;
  });

  // A second launch naming a folder while this surface is up: the host does not adopt it on
  // its own (it asks, so a window with a page open can save first), and here there is nothing
  // to leave, so the folder is opened straight away, as a recent row would be.
  onVaultChangeRequested(async ({ root }) => {
    if (busy) return;
    busy = true;
    err.hidden = true;
    try {
      const opened = await ose.vault.open(root);
      if (wasFocused(opened)) { busy = false; return; }
      if (opened && opened.root) { reloadIntoVault(); return; }
    } catch (e) {
      fail(e);
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
    onWindow: (path) => { void openInNewWindow(path); },
  });

  // Enter picks because the button has focus; Esc does nothing (there is nothing to go back to).
  requestAnimationFrame(() => pick.focus());
}

/** The chooser's top row: the app's toolbar with the mark alone. The window's frame is the OS's. */
function toolbar() {
  const el = document.createElement('header');
  el.className = 'titlebar';
  el.innerHTML = `<div class="tb-mark" title="Ose"><img src="logo.png" alt="" width="18" height="18"></div>`;
  return el;
}
