// The choose-vault surface. Mounted by main.js instead of the shell when the host has no root:
// one sentence, one primary button, the folder the host suggests, and a title bar so the
// frameless window can still be dragged and closed. Nothing else exists yet: no sidebar, no
// commands, no state file (the state file lives inside the vault).
//
// The title bar is drawn here rather than by titlebar.js, whose imports (sidebar, router,
// editor) all assume a vault. Same classes, so it is pixel for pixel the app's own bar.
// See CONTRACT.md "Vault resolution".
import './shell.css';
import { bridge } from '../bridge/index.js';
import { glyph } from './icons.js';
import { initTheme } from './theme.js';

const HOST = () => bridge.kind !== 'http';

/**
 * After `pickVault` the whole app boots again against the new root. `replace(pathname)` is a
 * reload that also drops the page query, which is how the dev flag `?novault=1` is cleared
 * (http.js); in the host the path is the app's own and this is a plain reload.
 */
export function reloadIntoVault() {
  location.replace(location.pathname);
}

function titlebar() {
  const el = document.createElement('header');
  el.className = 'titlebar';
  el.innerHTML = `
    <div class="tb-mark" title="os editor"><span>os</span></div>
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
      if (w === 'min') bridge.win.minimize();
      else if (w === 'max') bridge.win.maximize();
      else bridge.win.close();
    });
  });
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.tb-btn') || !HOST()) return;
    bridge.win.startDrag();
  });
  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tb-btn') || !HOST()) return;
    bridge.win.maximize();
  });
  bridge.on('window', (d) => {
    if (d && typeof d.maximized === 'boolean') document.documentElement.classList.toggle('maximized', d.maximized);
  });
  return el;
}

export async function mountVaultChooser(rootEl) {
  if (bridge.platform === 'macos') document.documentElement.classList.add('mac');
  initTheme();

  rootEl.textContent = '';
  const surface = document.createElement('div');
  surface.className = 'vault';
  surface.appendChild(titlebar());

  const body = document.createElement('main');
  body.className = 'vault-body';
  body.innerHTML = `
    <p class="vault-text">os needs a folder to open — a vault is any folder of markdown files.</p>
    <button class="btn primary vault-pick" type="button">Choose folder…</button>
    <div class="vault-hint mono-sm"></div>
    <div class="vault-err mono-sm" role="status" hidden></div>`;
  surface.appendChild(body);
  rootEl.appendChild(surface);

  const pick = body.querySelector('.vault-pick');
  const hint = body.querySelector('.vault-hint');
  const err = body.querySelector('.vault-err');

  // The suggestion: where the executable sits (the folder holding os.app on macOS). The
  // picker opens there too, so the line says what the button will show.
  bridge.platformInfo()
    .then((p) => {
      const dir = p && (p.exeDir || (p.exe ? String(p.exe).replace(/[\\/][^\\/]*$/, '') : ''));
      if (dir) { hint.textContent = `suggested: ${dir}`; hint.title = dir; }
    })
    .catch(() => { /* no suggestion, no line */ });

  let busy = false;
  const choose = async () => {
    if (busy) return;
    busy = true;
    pick.disabled = true;
    err.hidden = true;
    try {
      const picked = await bridge.pickVault();
      if (picked && picked.root) { reloadIntoVault(); return; }
    } catch (e) {
      err.textContent = String(e && e.message ? e.message : e);
      err.hidden = false;
    }
    busy = false;
    pick.disabled = false;
    pick.focus();
  };
  pick.addEventListener('click', choose);

  // Enter picks because the button has focus; Esc does nothing (there is nothing to go back to).
  requestAnimationFrame(() => pick.focus());
}
