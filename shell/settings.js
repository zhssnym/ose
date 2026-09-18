// The settings dialog (Ctrl+,). Small, flat, one dialog. The values themselves are the
// kernel's (src/kernel/settings-core.js, docs/KERNEL.md `ose.settings`); this file draws them.
import { ose } from 'ose:kernel';
import { esc, openOverlay, pickFolder, toast } from 'ose:ui';
import { reloadIntoVault, chooseVault } from './vault.js';
import { hostKind } from './host.js';
import { byPluginOrder } from './order.js';

const { bus, commands, store } = ose;

// The values are the kernel's (`ose.settings`); the steps a person can pick between are the
// dialog's, because they are what this dialog draws. The kernel validates against its own
// copy, so a shell that offers a step the kernel does not know simply gets 100 %.
const FONT_SIZES = [14, 15, 16, 17];
const LINE_HEIGHTS = [1.25, 1.35, 1.5];
const PAGE_FACES = [{ value: 'document', label: 'document' }, { value: 'plain', label: 'plain' }];
const LAYOUTS = [{ value: 'scroll', label: 'scroll' }, { value: 'pages', label: 'pages' }];
const ZOOM_STEPS = [90, 100, 110, 125, 150];

const settings = () => ose.settings.get();
const save = (partial) => ose.settings.set(partial);
const zoom = () => ose.settings.zoom();
const setZoom = (pct) => ose.settings.setZoom(pct);
const applySettings = () => ose.settings.apply();
const onRepaint = (fn) => ose.settings.onRepaint(fn);
const themePref = () => ose.theme.get();
const setTheme = (next) => ose.theme.set(next);
const flushState = () => ose.state('sidebar').flush();

/** One step in or out, clamped at the ends rather than wrapping. */
function stepZoom(dir) {
  const at = ZOOM_STEPS.indexOf(zoom());
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, (at < 0 ? 1 : at) + dir));
  setZoom(ZOOM_STEPS[next]);
}

/** `110%` while zoomed, null at 100: what the status bar draws (S4). */
export const zoomLabel = () => (zoom() === 100 ? null : `${zoom()}%`);

/** `system` (the recycle bin) or `vault` (`.trash` inside the vault). */
const trashMode = () => (settings().trash === 'vault' ? 'vault' : 'system');

/** Where new pages are created: `focus`, `scratch`, `page` (S34). */
function newPageMode() {
  const m = settings().newPages;
  return m === 'scratch' || m === 'page' ? m : 'focus';
}

let openOv = null;

function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}">` + options.map((o) =>
    `<button type="button" class="seg-b${String(o.value) === String(value) ? ' on' : ''}" data-v="${esc(o.value)}">${esc(o.label)}</button>`
  ).join('') + '</div>';
}

/* ------------------------------------------------------------------- paths */

// One row per declared path (docs/PLUGINS.md `ose.paths`): its label, one sentence saying what
// the thing must contain, where it resolved, and the two controls. The value is mono because
// it is a path; `missing` and `ambiguous` are the danger colour, because a path that did not
// resolve is a view that cannot draw until someone points at the right folder.
//
// A row's `candidates` (the near misses, which the kernel offers but never adopts) are not
// drawn here: `ose.paths.of(owner)` has no call that saves a path it is handed, so a button
// here could not do what it says. The box inside the view offers them, one click each.
function pathRow(row) {
  // A row is named like the rows around it. A plugin that gives no label is named by its key,
  // which is a lowercase word (`scratch`, `calendar`) where every neighbour is a Sentence case
  // name, so the row capitalises it rather than the plugin having to (R8). The label itself is
  // left alone: `ose.paths` spends it mid-sentence too ("Choose the calendar file…").
  const name = row.label || row.key;
  // `sharedFrom`: the row is answered by another owner's choice. The calendar is one file and
  // Day and Week both ask for it, so there is one answer and one place it was given. Nothing is
  // saved under this owner, so a Reset here would have nothing to undo: the line says who chose
  // it, and releasing it there releases this row too.
  const shared = row.sharedFrom ? `chosen in ${ownerName(row.sharedFrom)} · reset it there` : '';
  return `<div class="set-path" data-owner="${esc(row.owner)}" data-key="${esc(row.key)}">
      <div class="set-path-name">${esc(name.charAt(0).toUpperCase() + name.slice(1))}</div>
      <div class="set-path-act">
        <button class="btn" data-act="choose">Choose…</button>
        <button class="btn" data-act="reset"${row.saved && !row.sharedFrom ? '' : ' hidden'}>Reset</button>
      </div>
      <div class="set-path-note">${esc(row.hint || '')}</div>
      <div class="set-path-value mono-sm">${row.status === 'ok'
        ? `<span class="text-select" title="${esc(row.path)}">${esc(row.path)}</span>`
        : `<i class="set-path-bad">${esc(row.status)}</i>`
      }${shared ? `<i class="set-path-shared">${esc(shared)}</i>` : ''}</div>
    </div>`;
}

/** The name a person knows an owner by: the plugin's, or the section the shell's own sits in. */
function ownerName(owner) {
  if (owner === 'app') return 'Files';
  const p = ose.plugins.list().find((x) => x.id === owner);
  return (p && p.name) || owner;
}

/** Every declared path of one owner, in the order it was declared. */
const pathsOf = (owner) => {
  try { return ose.paths.of(owner).list(); } catch (e) { console.warn('[shell] paths', owner, e); return []; }
};

/** Settings › Files: the shell's own path, where a new page lands (main.js declares it). */
function paintFiles(box) {
  const host = box.querySelector('.set-files');
  if (!host) return;
  host.innerHTML = pathsOf('app').map(pathRow).join('');
}

/* ----------------------------------------------------------------- plugins */

/**
 * Every plugin of this vault, what it says it is, whether it is running, and the paths it
 * needs. A plugin that threw on import or in `activate` is disabled for the session and says
 * so here as well as in its toast, which is the one place a person can go and look afterwards.
 */
function paintPlugins(box) {
  const host = box.querySelector('.set-plugins');
  if (!host) return;
  // The same order as the sidebar and the home cards: a plugin sits where the view it opens
  // sits (order.js), not where the loader happened to finish it (R8).
  const list = ose.plugins.list().slice().sort(byPluginOrder);
  if (!list.length) {
    host.innerHTML = `<div class="set-note">No plugins. A plugin is a folder in .ose/plugins.</div>`;
    return;
  }
  host.innerHTML = list.map((p) => `<div class="set-plug">
        <span class="set-plug-name">${esc(p.name || p.id)}</span>
        <span class="grow mono-sm">${esc(p.description || '')}</span>
        <span class="set-plug-state mono-sm${p.state === 'active' ? '' : ' err'}">${esc(p.state)}</span>
      </div>`
    + (p.error ? `<div class="set-plug-why mono-sm">${esc(String(p.error))}</div>` : '')
    + pathsOf(p.id).map(pathRow).join('')).join('');
}

/** Both path lists at once: one repaint, whichever of them a choice touched. */
function paintPaths(box) {
  paintFiles(box);
  paintPlugins(box);
}

/** Choose… and Reset, for a row of either list. A cancelled picker changes nothing. */
async function pathAction(owner, key, act, box) {
  const scope = ose.paths.of(owner);
  try {
    if (act === 'reset') scope.reset(key);
    else await scope.choose(key);
  } catch (e) {
    toast(String(e && e.message ? e.message : e), 'err');
  }
  paintPaths(box);
}

/** The plugins folder, for `Open plugins folder`: a vault with none gets one rather than an error. */
async function revealPlugins() {
  const dir = '.ose/plugins';
  try {
    if (!(await ose.files.exists(dir))) await ose.files.mkdir(dir);
    await ose.files.reveal(dir);
  } catch (e) {
    toast(String(e && e.message ? e.message : e), 'err');
  }
}

/* --------------------------------------------------------- what the plugins contribute */

/**
 * A plugin's own section (`ose.settings.section`), drawn under the stock rows in the order the
 * kernel keeps them. The plugin is handed one empty box and draws into it; a section that
 * throws is one line saying so, never a dialog that fails to open: one bad plugin is one bad
 * row.
 */
function paintSections(box) {
  const host = box.querySelector('.set-sections');
  if (!host) return;
  host.textContent = '';
  for (const sec of ose.settings.sections()) {
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = sec.title || sec.id;
    host.appendChild(label);
    const body = document.createElement('div');
    body.className = 'set-section';
    host.appendChild(body);
    try { sec.render(body); } catch (e) {
      console.error('[shell] settings section', sec.id, e);
      body.innerHTML = `<div class="set-note err">${esc(String(e.message || e))}</div>`;
    }
  }
}

/* ------------------------------------------------------------------ the dialog */

/**
 * One settings row: the name, its control on the right, and one sentence underneath saying
 * what the choice does (DESIGN.md's settings pattern). Same grid as a path row, so the whole
 * dialog reads as one list.
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
  let unwatchPaths = null;
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
      unwatchPaths && unwatchPaths();
      unwatchTheme && unwatchTheme();
    },
  });
  openOv = ov;
  offRepaint = onRepaint(() => { if (openOv) paintZoom(openOv.box); });
  const root = store.get('root') || {};

  ov.box.innerHTML = `
    <div class="dlg-head" id="set-title">Settings</div>
    <div class="set-body">
      <div class="label">theme</div>
      ${row('Theme',
        seg('theme', [{ value: 'light', label: 'light' }, { value: 'dark', label: 'dark' }, { value: 'system', label: 'system' }], themePref()),
        'Light, dark, or whatever the system is set to.')}

      <div class="label">reading</div>
      ${row('Zoom',
        seg('zoom', ZOOM_STEPS.map((n) => ({ value: n, label: n + '%' })), zoom()),
        'The size of everything in the window. Ctrl+= and Ctrl+- step it, and Ctrl+0 goes back '
        + 'to 100% everywhere except in a page, where Ctrl+0 is Paragraph.')}
      ${row('Body text',
        seg('font', FONT_SIZES.map((n) => ({ value: n, label: n + 'px' })), s.fontSize),
        "The size of a page's own text. The chrome around it keeps its size.")}
      ${row('Line height',
        seg('lh', LINE_HEIGHTS.map((n) => ({ value: n, label: String(n) })), s.lineHeight),
        'How much air there is between the lines of a page.')}
      ${row('Page face',
        seg('face', PAGE_FACES, s.pageFace === 'plain' ? 'plain' : 'document'),
        'The face a page is set in: the document serif, or the face the interface uses. Nothing else about a page changes, and printing follows it.')}
      ${row('Layout',
        seg('layout', LAYOUTS, s.layout === 'pages' ? 'pages' : 'scroll'),
        'Scroll is one continuous column. Pages is the A4 sheet the page prints on, at the print size, so every line breaks where it will on paper, with a dashed rule where each sheet ends.')}
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
      <div class="set-files"></div>

      <div class="label">plugins</div>
      <div class="set-plugins"></div>
      <div class="set-plug-act">
        <button class="btn sm" data-act="reload">Reload plugins</button>
        <button class="btn sm" data-act="plugins-folder">Open plugins folder</button>
      </div>

      <div class="set-sections"></div>

      <div class="label">about</div>
      <div class="set-info mono-sm text-select">
        <div><span>vault</span><i title="${esc(root.root || '')}">${esc(root.root || '—')}</i><button class="btn sm" data-act="vault">Change vault…</button></div>
        <div><span>from</span><i class="set-vault-src">—</i></div>
        <div><span>version</span>${esc(`${ose.version.kernel} · ${hostKind()} · ${ose.platform}`)}</div>
      </div>
    </div>
    <div class="dlg-foot"><span class="grow mono-sm faint">changes apply immediately</span><button class="btn primary" data-act="done">Done</button></div>`;

  ov.box.setAttribute('aria-labelledby', 'set-title');
  ov.box.querySelector('[data-act="done"]').addEventListener('click', () => ov.close());
  ov.box.querySelector('[data-act="vault"]').addEventListener('click', () => commands.run('app.vault-change'));

  // Where the root came from, in the host's words: arg, exe, env, remembered, picked (dev in
  // the browser). Asked each time the dialog opens; the answer can change within one run.
  const srcEl = ov.box.querySelector('.set-vault-src');
  ose.vault.info()
    .then((v) => { if (srcEl.isConnected) srcEl.textContent = v && v.source ? `${v.source}${v.remembered ? ' · remembered' : ''}` : '—'; })
    .catch((e) => { if (srcEl.isConnected) srcEl.textContent = String(e.message || e); });

  ov.box.querySelector('[data-act="reload"]').addEventListener('click', () => { void commands.run('app.reload'); });
  ov.box.querySelector('[data-act="plugins-folder"]').addEventListener('click', () => { void revealPlugins(); });

  // A path chosen from a view's own box, or by another window on the same vault, moves the
  // row here while the dialog is open.
  unwatchPaths = ose.paths.on(() => { if (openOv) paintPaths(ov.box); });

  // Ctrl+Shift+L works with the dialog open, and the dialog must not then be the one place in
  // the app still claiming the old theme.
  unwatchTheme = bus.on('theme', () => {
    const pref = themePref();
    ov.box.querySelectorAll('[data-seg="theme"] .seg-b').forEach((n) => n.classList.toggle('on', n.dataset.v === pref));
  });

  paintSections(ov.box);
  paintPaths(ov.box);
  paintAttachments(ov.box);
  ov.box.addEventListener('click', (e) => {
    const b = e.target.closest('.set-path-act .btn');
    if (!b) return;
    const el = b.closest('.set-path');
    void pathAction(el.dataset.owner, el.dataset.key, b.dataset.act, ov.box);
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
    else if (group === 'face') save({ pageFace: v });
    else if (group === 'layout') save({ layout: v });
    else if (group === 'zoom') setZoom(+v);
    else if (group === 'width') save({ readableWidth: v === 'on' });
    else if (group === 'newpages') save({ newPages: v });
    else if (group === 'trash') save({ trash: v });
    else if (group === 'spell') save({ spellcheck: v === 'on' });
    else if (group === 'attach') void chooseAttachments(v, ov.box);
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
    // The foot names the act: nothing is moved here (R6).
    enterLabel: 'choose',
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

  // The page view is one command too, so switching between the scroll and the sheet is a
  // palette away rather than a dialog away.
  commands.register({
    id: 'app.layout', title: 'Toggle page view', group: 'app', hint: 'scroll or A4 pages',
    run: () => {
      const pages = document.documentElement.dataset.layout === 'pages';
      save({ layout: pages ? 'scroll' : 'pages' });
    },
  });

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
