// The settings dialog (Ctrl+,). Small, flat, one dialog. The values themselves are the
// kernel's (src/kernel/settings-core.js, docs/KERNEL.md `ose.settings`); this file draws them
// and is rice, not kernel: K2 moves it into `cockpit/shell/`.
import { bus, commands, store, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { openOverlay, pickFile, pickFolder, toast } from './dialog.js';
import { patchState, stateCache, flushState } from './state.js';
import { reloadIntoVault, chooseVault } from './vault.js';
import { themePref, setTheme } from './theme.js';
import { buildLine, checkedLine, reschedule } from './update.js';
import { SOURCE_KEYS, SOURCE_INFO, getSource, setSource, isDefaultSource } from '../lib/sources.js';
import {
  DEFAULTS, FONT_SIZES, LINE_HEIGHTS, ZOOM_STEPS, settings, save, zoom, setZoom, stepZoom,
  newPageMode, trashMode, applySettings, onRepaint, sections,
} from '../kernel/settings-core.js';

export * from '../kernel/settings-core.js';

let openOv = null;

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

/* ------------------------------------------------------------------ the dialog */

/**
 * One settings row: the name, its control on the right, and one sentence underneath saying
 * what the choice does (DESIGN.md's settings pattern). Same grid as a source row, so the two
 * halves of the dialog read as one list.
 */
function row(label, control, note = '') {
  return `<div class="set-row">
      <div class="set-name">${esc(label)}</div>
      <div class="set-ctl">${control}</div>
      <div class="set-note">${esc(note)}</div>
    </div>`;
}

function paintZoom(box) {
  const el = box.querySelector('[data-seg="zoom"]');
  if (!el) return;
  const z = String(zoom());
  el.querySelectorAll('.seg-b').forEach((n) => n.classList.toggle('on', n.dataset.v === z));
}

/** The attachments row's second line: the folder, or nothing while it is `beside the page`. */
function paintAttachments(box) {
  const s = settings().attachments;
  const el = box.querySelector('.set-attach-path');
  if (!el) return;
  const custom = typeof s === 'string' && s !== 'beside';
  el.hidden = !custom;
  if (custom) {
    el.textContent = s === '' ? 'the vault root' : s;
    el.title = String(s);
  }
}

/** Ctrl+, is a toggle: a second press closes the dialog instead of stacking another one. */
export function toggleSettings() {
  if (openOv) { openOv.close(); return; }
  void openSettings();
}

export async function openSettings() {
  const s = settings();
  // The rows need the width; the body scrolls when the window is short, so the dialog stays
  // inside 1280x800 without clipping anything.
  let unwatchUpdate = null;
  let unwatchTheme = null;
  // The zoom chords change the value from outside the dialog; the kernel's settings core
  // announces a write and the segmented control follows it (it used to reach in the other way,
  // from the core into this file's DOM, which the kernel is not allowed to know about).
  let offRepaint = null;
  const ov = openOverlay({
    width: 620, top: '10vh', className: 'set', title: 'Settings',
    onClose: () => {
      openOv = null;
      offRepaint && offRepaint();
      unwatchUpdate && unwatchUpdate();
      unwatchTheme && unwatchTheme();
    },
  });
  openOv = ov;
  offRepaint = onRepaint(() => { if (openOv) paintZoom(openOv.box); });
  const root = store.get('root') || {};

  ov.box.innerHTML = `
    <div class="dlg-head" id="set-title">Settings</div>
    <div class="set-body">
      ${row('Theme',
        seg('theme', [{ value: 'light', label: 'light' }, { value: 'dark', label: 'dark' }, { value: 'system', label: 'system' }], themePref()),
        'Light, dark, or whatever the system is set to.')}

      <div class="label">reading</div>
      ${row('Zoom',
        seg('zoom', ZOOM_STEPS.map((n) => ({ value: n, label: n + '%' })), zoom()),
        'The size of everything in the window. Ctrl+= and Ctrl+- step it, Ctrl+0 goes back to 100%.')}
      ${row('Body text',
        seg('font', FONT_SIZES.map((n) => ({ value: n, label: n + 'px' })), s.fontSize),
        "The size of a page's own text. The chrome around it keeps its size.")}
      ${row('Line height',
        seg('lh', LINE_HEIGHTS.map((n) => ({ value: n, label: String(n) })), s.lineHeight),
        'How much air there is between the lines of a page.')}
      ${row('Readable width',
        seg('width', [{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }], s.readableWidth === false ? 'off' : 'on'),
        'On, a page is a column in the middle of the window. Off, it fills it.')}

      <div class="label">files</div>
      ${row('New pages go to',
        seg('newpages', [{ value: 'focus', label: 'focused folder' }, { value: 'scratch', label: 'scratch' }, { value: 'page', label: 'same folder' }], newPageMode()),
        'Where Ctrl+N puts a page: the folder in focus, the scratch folder, or the folder of the page you are on.')}
      <div class="set-row">
        <div class="set-name">Attachments go to</div>
        <div class="set-ctl">
          ${seg('attach', [{ value: 'beside', label: 'beside the page' }, { value: 'folder', label: 'a folder…' }], s.attachments === 'beside' ? 'beside' : 'folder')}
        </div>
        <div class="set-note">A file dropped on a page is copied here, then linked. Beside the page means <code>attachments/</code> in the page's own folder.</div>
        <div class="set-attach-path mono-sm text-select" hidden></div>
      </div>
      ${row('Deleted files go to',
        seg('trash', [{ value: 'system', label: 'recycle bin' }, { value: 'vault', label: '.trash in the vault' }], trashMode()),
        'Nothing is ever deleted outright. The recycle bin is the system one; .trash is a hidden folder inside the vault.')}
      ${row('Spellcheck',
        seg('spell', [{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }], s.spellcheck === false ? 'off' : 'on'),
        "The web view's own checker, in the display language of the system.")}

      <div class="label">sources</div>
      <div class="set-src-list">${SOURCE_KEYS.map(srcRow).join('')}</div>

      <div class="label">updates</div>
      ${row('Updates',
        seg('updates', [{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }], s.updates === false ? 'off' : 'on'),
        'The one network call the app makes: the rolling release of its own repository.')}
      <div class="set-upd mono-sm"><span class="set-upd-build"></span><span class="set-upd-checked"></span><button class="btn sm" data-act="check">Check now</button></div>

      <div class="set-info mono-sm text-select">
        <div><span>vault</span><i title="${esc(root.root || '')}">${esc(root.root || '—')}</i><button class="btn sm" data-act="vault">Change vault…</button></div>
        <div><span>from</span><i class="set-vault-src">—</i></div>
        <div><span>bridge</span>${esc(bridge.kind === 'http' ? 'dev (vite)' : `${bridge.kind} (host, ${bridge.platform})`)}</div>
      </div>
    </div>
    <div class="dlg-foot"><span class="grow mono-sm faint">changes apply immediately</span><button class="btn primary" data-act="done">Done</button></div>`;

  ov.box.setAttribute('aria-labelledby', 'set-title');
  ov.box.querySelector('[data-act="done"]').addEventListener('click', () => ov.close());
  ov.box.querySelector('[data-act="vault"]').addEventListener('click', () => commands.run('app.vault-change'));

  // Where the root came from, in the host's words: arg, exe, env, remembered, picked (dev in
  // the browser). Asked each time the dialog opens; the answer can change within one run.
  const srcEl = ov.box.querySelector('.set-vault-src');
  bridge.vaultInfo()
    .then((v) => { if (srcEl.isConnected) srcEl.textContent = v && v.source ? `${v.source}${v.remembered ? ' · remembered' : ''}` : '—'; })
    .catch((e) => { if (srcEl.isConnected) srcEl.textContent = String(e.message || e); });

  // The build this executable is, and when it last asked; repainted as checks land.
  const paintUpdate = () => {
    ov.box.querySelector('.set-upd-build').textContent = buildLine();
    ov.box.querySelector('.set-upd-checked').textContent = checkedLine();
  };
  paintUpdate();
  unwatchUpdate = store.watch('update', paintUpdate);
  ov.box.querySelector('[data-act="check"]').addEventListener('click', () => { void commands.run('app.update-check'); });

  // Ctrl+Shift+L works with the dialog open, and the dialog must not then be the one place in
  // the app still claiming the old theme.
  unwatchTheme = bus.on('theme', () => {
    const pref = themePref();
    ov.box.querySelectorAll('[data-seg="theme"] .seg-b').forEach((n) => n.classList.toggle('on', n.dataset.v === pref));
  });

  paintSources(ov.box);
  paintAttachments(ov.box);
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
    else if (group === 'lh') save({ lineHeight: +v });
    else if (group === 'zoom') setZoom(+v);
    else if (group === 'width') save({ readableWidth: v === 'on' });
    else if (group === 'newpages') save({ newPages: v });
    else if (group === 'trash') save({ trash: v });
    else if (group === 'spell') save({ spellcheck: v === 'on' });
    else if (group === 'attach') void chooseAttachments(v, ov.box);
    else if (group === 'updates') { save({ updates: v === 'on' }); reschedule(); paintUpdate(); }
  });

  requestAnimationFrame(() => ov.box.querySelector('.seg-b')?.focus());
}

/**
 * `Attachments go to`: `beside the page` needs no folder, `a folder…` opens the same picker
 * every other folder choice in the app uses. Cancelling leaves the setting where it was, and
 * the segment goes back to what it says.
 */
async function chooseAttachments(which, box) {
  if (which === 'beside') { save({ attachments: 'beside' }); paintAttachments(box); return; }
  const current = settings().attachments;
  const picked = await pickFolder({
    title: 'Attachments folder…',
    current: current === 'beside' ? null : current,
  });
  if (picked === null) {
    const back = settings().attachments === 'beside' ? 'beside' : 'folder';
    box.querySelectorAll('[data-seg="attach"] .seg-b').forEach((n) => n.classList.toggle('on', n.dataset.v === back));
    paintAttachments(box);
    return;
  }
  save({ attachments: picked });
  paintAttachments(box);
}

/**
 * `Change vault…`: the chooser (a recent vault, or the native folder picker), then the whole
 * app boots again against the choice — the host remembers it. The open page is saved first and
 * the state file flushed, because a reload gives neither the `closing` notice the editor
 * relies on.
 */
async function changeVault() {
  let picked;
  try {
    picked = await chooseVault();
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

  // Zoom is three commands, so the palette has it and P3's chords (Ctrl+=, Ctrl+-, Ctrl+0)
  // have something to bind to. The percentage is remembered per vault under settings.zoom.
  commands.register({
    id: 'app.zoom-in', title: 'Zoom in', group: 'app', hint: 'bigger text and chrome',
    when: () => zoom() < ZOOM_STEPS[ZOOM_STEPS.length - 1],
    run: () => stepZoom(1),
  });
  commands.register({
    id: 'app.zoom-out', title: 'Zoom out', group: 'app', hint: 'smaller text and chrome',
    when: () => zoom() > ZOOM_STEPS[0],
    run: () => stepZoom(-1),
  });
  commands.register({
    id: 'app.zoom-reset', title: 'Reset zoom', group: 'app', hint: 'back to 100%',
    when: () => zoom() !== 100,
    run: () => setZoom(100),
  });
}
