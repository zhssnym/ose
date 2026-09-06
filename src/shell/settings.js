// Settings (Ctrl+,). Small, flat, one dialog. Everything persists under state.settings.
import { commands, store, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { openOverlay, pickFile, pickFolder } from './dialog.js';
import { patchState, stateCache } from './state.js';
import { themePref, setTheme } from './theme.js';
import { SOURCE_KEYS, SOURCE_INFO, getSource, setSource, isDefaultSource } from '../lib/sources.js';

const FONT_SIZES = [14, 15, 16, 17];
// claudeWidth is not a settings row any more; it is where the pane's drag handle stores its
// width. The dialog shows theme, body text, and the read-only block, nothing else.
const DEFAULTS = { fontSize: 16, claudeWidth: 400 };

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

// One row per source key: what it is, the file it points at, and the two controls. The path is
// mono because it is a path; a file that is not there says so rather than failing silently in
// a view (CONTRACT.md batch 4).
function srcRow(key) {
  const info = SOURCE_INFO[key] || {};
  return `<div class="set-src" data-key="${esc(key)}">
      <div class="set-src-name">${esc(info.title || key)}<span class="set-note">${esc(info.note || '')}</span></div>
      <div class="set-src-path mono-sm"></div>
      <div class="set-src-act">
        <button class="btn" data-src="${esc(key)}" data-act="choose">choose…</button>
        <button class="btn set-src-reset" data-src="${esc(key)}" data-act="reset" hidden>reset</button>
      </div>
    </div>`;
}

function paintSources(box) {
  for (const key of SOURCE_KEYS) {
    const el = box.querySelector(`.set-src[data-key="${key}"]`);
    if (!el) continue;
    const path = getSource(key);
    const pathEl = el.querySelector('.set-src-path');
    pathEl.textContent = path;
    pathEl.title = path;
    pathEl.classList.remove('missing');
    el.querySelector('.set-src-reset').hidden = isDefaultSource(key);
    bridge.exists(path)
      .then((ok) => { if (pathEl.textContent === path) pathEl.classList.toggle('missing', !ok); })
      .catch(() => { });
  }
}

async function chooseSource(key, box) {
  const info = SOURCE_INFO[key] || {};
  const current = getSource(key);
  const title = `${info.title || key}…`;
  const picked = info.dir
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
  const ov = openOverlay({ width: 560, top: '12vh', className: 'set', onClose: () => { openOv = null; } });
  openOv = ov;
  const root = store.get('root') || {};

  ov.box.innerHTML = `
    <div class="dlg-head label">Settings</div>
    <div class="set-body">
      ${row('Theme', seg('theme', [{ value: 'light', label: 'light' }, { value: 'dark', label: 'dark' }, { value: 'system', label: 'system' }], themePref()))}
      ${row('Body text', seg('font', FONT_SIZES.map((n) => ({ value: n, label: n + 'px' })), s.fontSize))}
      <div class="section-label set-head">sources</div>
      <div class="set-src-list">${SOURCE_KEYS.map(srcRow).join('')}</div>
      <div class="set-info mono-sm text-select">
        <div><span>vault</span>${esc(root.root || '—')}</div>
        <div><span>bridge</span>${esc(bridge.kind === 'http' ? 'dev (vite)' : `${bridge.kind} (host, ${bridge.platform})`)}</div>
        <div><span>claude</span><i class="set-claude">checking…</i></div>
      </div>
    </div>
    <div class="dlg-foot"><span class="grow mono-sm faint">changes apply immediately</span><button class="btn primary" data-act="done">Done</button></div>`;

  ov.box.querySelector('[data-act="done"]').addEventListener('click', () => ov.close());

  paintSources(ov.box);
  ov.box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (!b) return;
    const key = b.dataset.src;
    if (b.dataset.act === 'reset') { setSource(key, null); paintSources(ov.box); }
    else void chooseSource(key, ov.box);
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

  const claudeEl = ov.box.querySelector('.set-claude');
  bridge.claudeInfo()
    .then((info) => { claudeEl.textContent = info && info.path ? `${info.version || 'installed'} · ${info.path}` : 'not found on PATH'; })
    .catch((e) => { claudeEl.textContent = 'unavailable: ' + (e.message || e); });

  requestAnimationFrame(() => ov.box.querySelector('.seg-b')?.focus());
}

export function initSettings() {
  applySettings();
  commands.register({ id: 'app.settings', title: 'Settings', group: 'app', run: toggleSettings });
}
