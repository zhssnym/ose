// Settings (Ctrl+,). Small, flat, one dialog. Everything persists under state.settings.
import { commands, store, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { openOverlay, pickFile, pickFolder, toast } from './dialog.js';
import { patchState, stateCache, flushState } from './state.js';
import { reloadIntoVault } from './vault.js';
import { themePref, setTheme } from './theme.js';
import { SOURCE_KEYS, SOURCE_INFO, getSource, setSource, isDefaultSource } from '../lib/sources.js';

const FONT_SIZES = [14, 15, 16, 17];
// The dialog shows theme, body text, the sources, and the read-only block, nothing else.
const DEFAULTS = { fontSize: 16 };

let openOv = null;

export function settings() { return { ...DEFAULTS, ...(stateCache().settings || {}) }; }

function save(partial) {
  const next = { ...settings(), ...partial };
  patchState({ settings: next });
  applySettings();
  return next;
}

export function applySettings() {
  const s = settings();
  const size = FONT_SIZES.includes(+s.fontSize) ? +s.fontSize : DEFAULTS.fontSize;
  document.documentElement.style.setProperty('--fs-body', size + 'px');
}

function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}">` + options.map((o) =>
    `<button type="button" class="seg-b${String(o.value) === String(value) ? ' on' : ''}" data-v="${esc(o.value)}">${esc(o.label)}</button>`
  ).join('') + '</div>';
}

/* ------------------------------------------------------------------ sources */

// One row per source key: what it is, one sentence saying what the app expects to find there,
// the path it points at, and the controls. The path is mono because it is a path; a path that
// is not there says `missing` rather than failing silently inside a view (CONTRACT.md batch 5).
// `todo` takes a file or a folder, so it gets both pickers instead of one `choose…`.
function srcRow(key) {
  const info = SOURCE_INFO[key] || {};
  const kind = info.kind || 'file';
  const choose = kind === 'either'
    ? `<button class="btn" data-src="${esc(key)}" data-act="file">file…</button>`
      + `<button class="btn" data-src="${esc(key)}" data-act="folder">folder…</button>`
    : `<button class="btn" data-src="${esc(key)}" data-act="${kind === 'folder' ? 'folder' : 'file'}">choose…</button>`;
  return `<div class="set-src" data-key="${esc(key)}">
      <div class="set-src-name">${esc(info.label || key)}</div>
      <div class="set-src-act">
        ${choose}
        <button class="btn set-src-reset" data-src="${esc(key)}" data-act="reset" hidden>reset</button>
      </div>
      <div class="set-src-note">${esc(info.sentence || '')}</div>
      <div class="set-src-path mono-sm"><span class="set-src-p text-select"></span><i class="set-src-missing" hidden>missing</i></div>
    </div>`;
}

// Existence is re-read every time the dialog opens and after every change: the vault is a
// folder on disk, and the point of the row is to say when it has moved out from under us.
function paintSources(box) {
  for (const key of SOURCE_KEYS) {
    const el = box.querySelector(`.set-src[data-key="${CSS.escape(key)}"]`);
    if (!el) continue;
    const path = getSource(key);
    const info = SOURCE_INFO[key] || {};
    const pathEl = el.querySelector('.set-src-p');
    const missEl = el.querySelector('.set-src-missing');
    const noteEl = el.querySelector('.set-src-note');
    pathEl.textContent = path;
    el.querySelector('.set-src-path').title = path;
    missEl.hidden = true;
    noteEl.textContent = info.sentence || '';
    noteEl.classList.remove('err');
    el.querySelector('.set-src-reset').hidden = isDefaultSource(key);
    // A stat that throws (a locked file, a bridge fault) is not a healthy source, and used to
    // be painted as one (B5): it reads `missing`, and the note says what the host said.
    bridge.stat(path)
      .then((st) => { if (pathEl.textContent === path) missEl.hidden = !!(st && st.exists); })
      .catch((e) => {
        console.warn('[shell] stat', path, e.message || e);
        if (pathEl.textContent !== path) return;
        missEl.hidden = false;
        noteEl.textContent = String(e.message || e);
        noteEl.classList.add('err');
      });
  }
}

async function chooseSource(key, how, box) {
  const info = SOURCE_INFO[key] || {};
  const current = getSource(key);
  const title = `${info.label || key}…`;
  const picked = how === 'folder'
    ? await pickFolder({ title, current })
    : await pickFile({ title, ext: info.ext, current });
  if (picked === null) return;
  setSource(key, picked);
  paintSources(box);
}

function row(label, control, note = '') {
  return `<div class="set-row"><div class="set-label">${esc(label)}${note ? `<span class="set-note">${esc(note)}</span>` : ''}</div><div class="set-ctl">${control}</div></div>`;
}

/** Ctrl+, is a toggle: a second press closes the dialog instead of stacking another one. */
export function toggleSettings() {
  if (openOv) { openOv.close(); return; }
  void openSettings();
}

export async function openSettings() {
  const s = settings();
  // Six source rows with a sentence each need the width; the body scrolls when the window is
  // short, so the dialog stays inside 1280x800 without clipping anything.
  const ov = openOverlay({ width: 620, top: '10vh', className: 'set', onClose: () => { openOv = null; } });
  openOv = ov;
  const root = store.get('root') || {};

  ov.box.innerHTML = `
    <div class="dlg-head">Settings</div>
    <div class="set-body">
      ${row('Theme', seg('theme', [{ value: 'light', label: 'light' }, { value: 'dark', label: 'dark' }, { value: 'system', label: 'system' }], themePref()))}
      ${row('Body text', seg('font', FONT_SIZES.map((n) => ({ value: n, label: n + 'px' })), s.fontSize))}
      <div class="label">sources</div>
      <div class="set-src-list">${SOURCE_KEYS.map(srcRow).join('')}</div>
      <div class="set-info mono-sm text-select">
        <div><span>vault</span><i title="${esc(root.root || '')}">${esc(root.root || '—')}</i><button class="btn sm" data-act="vault">Change vault…</button></div>
        <div><span>from</span><i class="set-vault-src">—</i></div>
        <div><span>bridge</span>${esc(bridge.kind === 'http' ? 'dev (vite)' : `${bridge.kind} (host, ${bridge.platform})`)}</div>
      </div>
    </div>
    <div class="dlg-foot"><span class="grow mono-sm faint">changes apply immediately</span><button class="btn primary" data-act="done">Done</button></div>`;

  ov.box.querySelector('[data-act="done"]').addEventListener('click', () => ov.close());
  ov.box.querySelector('[data-act="vault"]').addEventListener('click', () => commands.run('app.vault-change'));

  // Where the root came from, in the host's words: arg, exe, env, remembered, picked (dev in
  // the browser). Asked each time the dialog opens; the answer can change within one run.
  const srcEl = ov.box.querySelector('.set-vault-src');
  bridge.vaultInfo()
    .then((v) => { if (srcEl.isConnected) srcEl.textContent = v && v.source ? `${v.source}${v.remembered ? ' · remembered' : ''}` : '—'; })
    .catch((e) => { if (srcEl.isConnected) srcEl.textContent = String(e.message || e); });

  paintSources(ov.box);
  ov.box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (!b) return;
    const key = b.dataset.src;
    if (b.dataset.act === 'reset') { setSource(key, null); paintSources(ov.box); }
    else void chooseSource(key, b.dataset.act, ov.box);
  });

  ov.box.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-b');
    if (!b) return;
    const group = b.closest('.seg').dataset.seg;
    const v = b.dataset.v;
    b.parentElement.querySelectorAll('.seg-b').forEach((n) => n.classList.toggle('on', n === b));
    if (group === 'theme') setTheme(v);
    else if (group === 'font') save({ fontSize: +v });
  });

  requestAnimationFrame(() => ov.box.querySelector('.seg-b')?.focus());
}

/**
 * `Change vault…`: the native folder picker, then the whole app boots again against the
 * choice (the host remembers it). The open page is saved first and the state file flushed,
 * because a reload gives neither the `closing` notice the editor relies on.
 */
async function changeVault() {
  let picked;
  try {
    picked = await bridge.pickVault();
  } catch (e) {
    toast(String(e && e.message ? e.message : e), 'err');
    return;
  }
  if (!picked || !picked.root) return;
  try { await commands.run('page.save'); } catch (e) { console.warn('[shell] save before vault change', e); }
  await flushState();
  reloadIntoVault();
}

export function initSettings() {
  applySettings();
  commands.register({ id: 'app.settings', title: 'Settings', group: 'app', run: toggleSettings });
  const root = store.get('root') || {};
  commands.register({ id: 'app.vault-change', title: 'Change vault…', group: 'app', hint: root.root || '', run: changeVault });
}
