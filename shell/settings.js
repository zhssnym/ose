// Settings, as a page (M26): the view `settings`, opened in a tab by Ctrl+, like any other
// place in the app, with the sections listed on the left and the rows of one section on the
// right. `route.arg` names the section to show (`{type:'view', name:'settings', arg:'planner'}`).
//
// The values are the core's (`ose.settings`, docs/CORE.md): it knows which key is kept per
// machine and which one belongs to the vault, and it validates what it is handed. This file
// only draws them, and draws the sections other parts of the app register through
// `ose.settings.section()` — the planner's among them — each into a box of its own.
import { ose } from 'ose:core';
import { esc, pickFolder, toast } from 'ose:ui';
import { chooseVault, switchVault } from './vault.js';

const { bus, commands, store } = ose;

// The steps a person can pick between are the page's, because they are what it draws. The
// core validates against its own copy, so a step it does not know simply gets the default.
const FONT_SIZES = [14, 15, 16, 17];
const LINE_HEIGHTS = [1.25, 1.35, 1.5];
const ZOOM_STEPS = [90, 100, 110, 125, 150];
const ON_OFF = [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }];
// The editing modes a markdown file can open in (X1), in the switch's own order and words.
const MODES = [{ value: 'rich', label: 'Rich' }, { value: 'source', label: 'Source' }];

const settings = () => ose.settings.get();
const save = (partial) => ose.settings.set(partial);
const zoom = () => ose.settings.zoom();
const setZoom = (pct) => ose.settings.setZoom(pct);

/**
 * What a thrown value says: its `message` when it has one, else the value itself.
 * @param {unknown} e
 */
const messageOf = (e) => (e && typeof e === 'object' && 'message' in e && e.message ? e.message : e);

/** The zoom as the status bar says it, or null at 100 %. */
export const zoomLabel = () => (zoom() === 100 ? null : `${zoom()}%`);

/** One step in or out, clamped at the ends rather than wrapping. */
function stepZoom(dir) {
  const at = ZOOM_STEPS.indexOf(zoom());
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, (at < 0 ? 1 : at) + dir));
  setZoom(ZOOM_STEPS[next]);
}

/* ------------------------------------------------------------------ controls */

function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}" role="group">` + options.map((o) =>
    `<button type="button" class="seg-b${String(o.value) === String(value) ? ' on' : ''}" data-v="${esc(o.value)}" aria-pressed="${String(o.value) === String(value)}">${esc(o.label)}</button>`
  ).join('') + '</div>';
}

/**
 * One settings row: the name, its control on the right, and one sentence underneath saying
 * what the choice does (DESIGN.md's settings pattern). `note` and `extra` are HTML, written in
 * this file: anything that comes from elsewhere is escaped before it gets here.
 */
function row(label, control, note = '', extra = '') {
  return `<div class="set-row">
      <div class="set-name">${esc(label)}</div>
      <div class="set-ctl">${control}</div>
      <div class="set-note">${note}</div>${extra}
    </div>`;
}

const onOff = (v) => (v ? 'on' : 'off');

/** What each segmented control stands for right now: the page re-reads it after every change. */
function currentValues() {
  const s = settings();
  return {
    theme: ose.theme.get() || 'system',
    zoom: zoom(),
    font: s.fontSize,
    lh: s.lineHeight,
    face: s.pageFace === 'plain' ? 'plain' : 'document',
    layout: s.layout === 'pages' ? 'pages' : 'scroll',
    full: onOff(s.readableWidth === false),
    spell: onOff(s.spellcheck !== false),
    titlesync: onOff(s.titleSync === true),
    mode: MODES.some((m) => m.value === s.editorMode) ? s.editorMode : 'rich',
    attach: s.attachments === 'beside' || s.attachments === undefined ? 'beside' : 'folder',
    hidden: onOff(s.showHidden === true),
    mdext: onOff(s.hideMdExt === true),
  };
}

/** A click on a segment, written through to the core. */
function applySeg(group, v, box) {
  if (group === 'theme') ose.theme.set(v);
  else if (group === 'zoom') setZoom(+v);
  else if (group === 'font') save({ fontSize: +v });
  else if (group === 'lh') save({ lineHeight: +v });
  else if (group === 'face') save({ pageFace: v });
  else if (group === 'layout') save({ layout: v });
  else if (group === 'full') save({ readableWidth: v !== 'on' });
  else if (group === 'spell') save({ spellcheck: v === 'on' });
  else if (group === 'titlesync') save({ titleSync: v === 'on' });
  else if (group === 'mode') save({ editorMode: v });
  else if (group === 'attach') void chooseAttachments(v, box);
  else if (group === 'hidden') save({ showHidden: v === 'on' });
  else if (group === 'mdext') save({ hideMdExt: v === 'on' });
}

/** Every segmented control on the page, lit to match what the core now says. */
function syncControls(box) {
  if (!box) return;
  const now = currentValues();
  for (const el of box.querySelectorAll('.seg[data-seg]')) {
    const v = now[el.dataset.seg];
    if (v === undefined) continue;
    el.querySelectorAll('.seg-b').forEach((b) => {
      const on = b.dataset.v === String(v);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  paintAttachments(box);
}

/* ------------------------------------------------------------------ sections */

function appearanceHtml() {
  const v = currentValues();
  return row('Theme',
    seg('theme', [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], v.theme),
    'System follows the light or dark setting of the computer, and changes when it does.')
    + row('Zoom',
      seg('zoom', ZOOM_STEPS.map((n) => ({ value: n, label: n + '%' })), v.zoom),
      'The size of everything in the window. Ctrl+= and Ctrl+- step it, and Ctrl+0 goes back to '
      + '100% everywhere except in a page, where Ctrl+0 is Paragraph.')
    + row('Text size',
      seg('font', FONT_SIZES.map((n) => ({ value: n, label: n + 'px' })), v.font),
      "The size of a page's own text. The chrome around it keeps its size.")
    + row('Line height',
      seg('lh', LINE_HEIGHTS.map((n) => ({ value: n, label: String(n) })), v.lh),
      'How much air there is between the lines of a page.')
    + row('Page face',
      seg('face', [{ value: 'document', label: 'Document' }, { value: 'plain', label: 'Plain' }], v.face),
      'The face a page is set in: the document serif, or the face the interface uses. Printing follows it.')
    + row('Page layout',
      seg('layout', [{ value: 'scroll', label: 'Scroll' }, { value: 'pages', label: 'Pages' }], v.layout),
      'Scroll is one continuous column. Pages is the A4 sheet the page prints on, so every line breaks where it will on paper.')
    + row('Full width',
      seg('full', ON_OFF, v.full),
      'Off, a page is a readable column in the middle of the window. On, it fills the window.');
}

function editorHtml() {
  const v = currentValues();
  return row('Open markdown files in',
    seg('mode', MODES, v.mode),
    'The mode a markdown file opens in the first time. Rich edits the page as a document, Source is '
    + 'the plain text. A file you '
    + 'switch keeps its mode; plain text files always open as source.')
    + row('Spellcheck',
    seg('spell', ON_OFF, v.spell),
    "The web view's own checker, in the display language of the system. Shift+right-click a word for its suggestions.")
    + row('Name new pages after their heading',
      seg('titlesync', ON_OFF, v.titlesync),
      'On, a new page still called Untitled takes the name of the first heading you type in it. '
      + 'Off, a file keeps the name it was given until you rename it.');
}

function filesHtml() {
  const v = currentValues();
  return row('Attachments go to',
      seg('attach', [{ value: 'beside', label: 'Beside the page' }, { value: 'folder', label: 'A folder…' }], v.attach),
      "A file dropped on a page is copied here, then linked. Beside the page means <code>attachments/</code> in the page's own folder.",
      '<div class="set-extra set-attach-path mono-sm text-select" hidden></div>')
    + row('Show hidden items',
      seg('hidden', ON_OFF, v.hidden),
      'Names that start with a dot, and files the system marks as hidden, greyed in the tree and in folders. .ose and .git are never listed.')
    + row('Hide .md in names',
      seg('mdext', ON_OFF, v.mdext),
      'On, the .md at the end of a page\'s name is left out in the tree, the tabs and the title bar. The file keeps its name.');
}

/** Updates: the version running, and a button that checks now (the app also checks at start). */
function updatesHtml() {
  return `<div class="set-info mono-sm text-select">
      <div><span>Version</span><i class="set-app-version">—</i></div>
    </div>
    <div class="set-update">
      <button type="button" class="btn sm" data-act="update">Check for updates</button>
      <span class="set-update-note mono-sm" role="status"></span>
    </div>`;
}

/** The running version, once Tauri has said. */
async function paintUpdates(box) {
  const el = box.querySelector('.set-app-version');
  if (!el) return;
  const v = await ose.window.appVersion();
  if (el.isConnected) el.textContent = v || ose.version.core;
}

/** Check now: none, one ready to install (with Restart), or why it could not. */
async function checkNow(button) {
  const box = button.closest('.set-update');
  const note = box && box.querySelector('.set-update-note');
  if (!(note instanceof HTMLElement)) return;
  button.disabled = true;
  note.textContent = 'Checking…';
  const r = await ose.window.checkForUpdate();
  button.disabled = false;
  if (!note.isConnected) return;
  if (r.status === 'none') { note.textContent = 'Ose is up to date.'; return; }
  if (r.status === 'error') { note.textContent = `Could not check: ${r.message}`; return; }
  note.textContent = `Ose ${r.version} is ready. `;
  const restart = document.createElement('button');
  restart.type = 'button';
  restart.className = 'btn sm primary';
  restart.textContent = 'Restart to update';
  restart.addEventListener('click', () => { void r.restart(); });
  note.append(restart);
}

function vaultHtml() {
  const root = store.get('root') || {};
  return `<div class="set-info mono-sm text-select">
      <div><span>Vault</span><i title="${esc(root.root || '')}">${esc(root.root || '—')}</i><button type="button" class="btn sm" data-act="vault">Change vault…</button></div>
      <div><span>From</span><i class="set-vault-src">—</i></div>
      <div><span>Version</span><i>${esc(`${ose.version.core} · ${ose.platform}`)}</i></div>
      <div><span>Log</span><i class="set-log">—</i></div>
    </div>`;
}

/** Where the root came from and where the log is, in the host's words; asked each time. */
function paintVaultInfo(box) {
  const src = box.querySelector('.set-vault-src');
  const log = box.querySelector('.set-log');
  if (!src) return;
  ose.vault.info()
    .then((v) => {
      if (src.isConnected) src.textContent = v && v.source ? `${v.source}${v.remembered ? ', remembered' : ''}` : '—';
      if (log && log.isConnected) { log.textContent = (v && v.logPath) || '—'; log.title = (v && v.logPath) || ''; }
    })
    .catch((e) => { if (src.isConnected) src.textContent = String(e.message || e); });
}

/** The attachments row's second line: the folder, or nothing while it is beside the page. */
function paintAttachments(box) {
  const el = box && box.querySelector('.set-attach-path');
  if (!el) return;
  const s = settings().attachments;
  const custom = typeof s === 'string' && s !== 'beside';
  el.hidden = !custom;
  if (custom) {
    el.textContent = s === '' ? 'The vault root' : s;
    el.title = String(s);
  }
}

/**
 * `Attachments go to`: beside the page needs no folder, a folder… opens the same picker every
 * other folder choice in the app uses. Cancelling leaves the setting where it was, and the
 * segment goes back to what it says.
 */
async function chooseAttachments(which, box) {
  if (which === 'beside') { save({ attachments: 'beside' }); syncControls(box); return; }
  const current = settings().attachments;
  const picked = await pickFolder({
    title: 'Attachments folder…',
    current: current === 'beside' ? null : current,
    // The foot names the act: nothing is moved here (R6).
    enterLabel: 'Choose',
  });
  if (picked !== null) save({ attachments: picked });
  syncControls(box);
}

/**
 * `Change vault…` (C5), in this order: choose a folder without adopting it, let the window go
 * (the open page is saved into *this* vault, or the switch stops with the page's reason on
 * screen), adopt the folder, and boot again on it (`switchVault`, shell/vault.js).
 */
async function changeVault() {
  let picked;
  try {
    picked = await chooseVault({ adopt: false });
  } catch (e) {
    toast(String(messageOf(e)), 'err', 0);
    return;
  }
  if (!picked || !picked.root) return;
  await switchVault(picked.root);
}

/**
 * One chord as a key cap, in this platform's words (Cmd and Option on a Mac).
 * @param {string} combo
 */
const kbd = (combo) => `<span class="kbd">${esc(ose.keys.label(combo))}</span>`;

/**
 * The Help section's first half: how the app is used, a few sentences a topic. Written here,
 * in the app's voice; every chord is drawn by `kbd`, so a Mac reads Cmd where Windows reads Ctrl.
 */
function guideHtml() {
  const mac = document.documentElement.dataset.os === 'mac';
  const back = mac ? 'mod+[' : 'alt+arrowleft';
  const fwd = mac ? 'mod+]' : 'alt+arrowright';
  /** @type {[string, string][]} */
  const topics = [
    ['The vault',
      'A vault is a folder of plain markdown files on this computer. Ose opens the files where they '
      + 'are and edits them in place. Nothing of the app is written into the folder: its settings, '
      + "the versions of your files and any unsaved drafts are kept in the app's own folder. "
      + 'Settings › Vault changes which folder is open.'],
    ['The sidebar',
      'Views holds Day, Week, Month and Journal, pages drawn from ordinary files in the vault whose '
      + 'paths are set in Settings › Planner. Vault lists your folders and files under their real '
      + 'names; a folder opens and closes in place. Right-click a row for what can be done with it, '
      + 'or the empty space below for New file, New folder, Collapse all folders and Show hidden '
      + `items. ${kbd('mod+\\')} hides or shows the sidebar, and ${kbd('mod+shift+e')} moves the keyboard into it.`],
    ['Pages',
      'A markdown page opens in one of two modes. Rich is the page drawn as a document, written '
      + `like one. Source is the raw markdown, as in a code editor. ${kbd('mod+e')} switches between `
      + 'them, and each file keeps the mode it was left in. The bar at the bottom of the window shows '
      + 'the mode, the counts, when the file was changed and saved, and a dot while there are '
      + 'unsaved changes.'],
    ['Tabs',
      `Each tab holds one page, with its own back and forward: ${kbd(back)} and ${kbd(fwd)}. `
      + `${kbd('mod+t')} opens a new tab, ${kbd('mod+w')} closes one, ${kbd('mod+tab')} moves to `
      + `the next and ${kbd('mod+shift+t')} brings back the last one closed. A page in a tab behind `
      + 'keeps its text and its undo.'],
    ['Go to file and commands',
      `${kbd('mod+p')} goes to any file by its name or path. ${kbd('mod+shift+p')} opens the command `
      + 'palette, which lists every action in the app with its shortcut.'],
    ['Search',
      `${kbd('mod+shift+f')} searches the text of every file in the vault, in the side panel. `
      + 'Right-click a folder to search in it alone. In a page, '
      + `${kbd('mod+f')} finds and ${kbd(mac ? 'mod+alt+f' : 'mod+h')} replaces.`],
    ['Nothing typed is lost',
      'Text that has not reached its file yet is kept as a draft until it does, and offered back '
      + 'if the app closes first. When another program or an AI agent changes a file you have open, '
      + 'Ose merges the change into your page, and asks only when you both changed the same lines.'],
    ['Deleting',
      "A deleted file or folder goes to the system's Recycle Bin or Trash, from where it can be "
      + 'restored.'],
    ['Updates',
      'Ose checks for a new version when it starts. Settings › Updates shows the version running '
      + 'and checks again on demand; when a new one is ready, Restart to update installs it.'],
  ];
  return '<h2 class="label set-help-label">Using Ose</h2>'
    + topics.map(([head, text]) => `<div class="set-help-topic">
        <h3 class="set-help-head">${esc(head)}</h3>
        <p class="set-help-text">${text}</p>
      </div>`).join('');
}

/**
 * Commands whose chord is their own `shortcut` and that the guide above names. `commands.list()`
 * leaves out a command whose `when` is false right now (Next tab with one tab open), so these
 * are asked for by id as well.
 */
const NAMED = ['tab.new', 'tab.close', 'tab.next', 'tab.prev'];

/** A chord as the key engine keys it: lower case, no spaces. */
const normCombo = (c) => String(c || '').toLowerCase().split('+').map((p) => p.trim()).filter(Boolean).join('+');

/**
 * The Help section's second half: every chord the app answers to, read only, the way the key
 * engine resolves them: the core's defaults (`ose.keys.defaults()`), then a command's own
 * `shortcut`, then the shell's `keys.json` over both. A chord used in a page's text belongs to
 * the editor while the caret is there, and says so in the last column.
 */
async function keysHtml() {
  let shellMap = {};
  try {
    const res = await fetch(new URL('./keys.json', import.meta.url), { cache: 'no-store' });
    if (res.ok) shellMap = (await res.json()) || {};
  } catch { shellMap = {}; }
  const mac = document.documentElement.dataset.os === 'mac';
  const win = new Map();
  const body = [];
  for (const k of ose.keys.defaults()) {
    const combo = (mac && k.mac) || k.combo;
    const entry = { combo, cmd: k.cmd };
    if (/^(format|block|table)\./.test(k.cmd)) body.push(entry);
    else win.set(normCombo(combo), entry);
  }
  const own = new Map(commands.list().map((c) => [c.id, c]));
  for (const id of NAMED) { const c = commands.get(id); if (c) own.set(id, c); }
  for (const c of own.values()) {
    const combo = normCombo(c.shortcut);
    if (combo) win.set(combo, { combo, cmd: c.id });
  }
  for (const [combo, cmd] of Object.entries(shellMap)) {
    if (typeof cmd === 'string' && cmd) win.set(normCombo(combo), { combo, cmd });
  }
  const title = (id) => { const c = commands.get(id); return (c && c.title) || id; };
  // One row per action and place: Go to file answers to Ctrl+P and Ctrl+O, and says so once.
  const byAct = new Map();
  /** @type {[string, {combo: string, cmd: string}[]][]} */
  const groups = [['Everywhere', [...win.values()]], ['In a page', body]];
  for (const [where, list] of groups) {
    for (const e of list) {
      const key = where + '|' + e.cmd;
      if (!byAct.has(key)) byAct.set(key, { cmd: e.cmd, where, labels: [] });
      const labels = byAct.get(key).labels;
      const label = ose.keys.label(e.combo);
      if (!labels.includes(label)) labels.push(label);
    }
  }
  const rows = [...byAct.values()];
  rows.sort((a, b) => (a.where === b.where ? 0 : a.where === 'Everywhere' ? -1 : 1) || title(a.cmd).localeCompare(title(b.cmd)));
  return `<h2 class="label set-help-label">Shortcuts</h2>
    <p class="set-lead">Every chord the app answers to on this computer. Those in a page work while the caret is in its text.</p>
    <table class="table set-keys">
      <thead><tr><th scope="col">Action</th><th scope="col">Keys</th><th scope="col">Where</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(title(r.cmd))}</td>
        <td class="set-keys-keys">${r.labels.map((l) => `<span class="kbd">${esc(l)}</span>`).join(' ')}</td>
        <td class="set-keys-where">${esc(r.where)}</td></tr>`).join('')}</tbody>
    </table>`;
}

/** Help: how the app is used, then every shortcut. */
async function helpHtml() {
  return guideHtml() + (await keysHtml());
}

/* ------------------------------------------------------------------ the page */

/**
 * The stock sections, in the order the list shows them. Registered ones go between HEAD and
 * TAIL. Help is last: it is the one section that sets nothing, read rather than changed.
 */
const HEAD = [
  { id: 'appearance', title: 'Appearance', html: appearanceHtml },
  { id: 'editor', title: 'Editor', html: editorHtml },
  { id: 'files', title: 'Files', html: filesHtml },
];
const TAIL = [
  { id: 'updates', title: 'Updates', html: updatesHtml },
  { id: 'vault', title: 'Vault', html: vaultHtml },
  { id: 'help', title: 'Help', html: helpHtml },
];

/** Every section, stock and registered, in list order. */
function allSections() {
  const reg = (ose.settings.sections() || [])
    .filter((s) => s && s.id && typeof s.render === 'function')
    .map((s) => ({ id: s.id, title: s.title || s.id, render: s.render }));
  return [...HEAD, ...reg, ...TAIL];
}

// The page on screen, while it is: `{ show(id), focus() }`. `openSettings` reaches it to change
// section when the tab was already open.
let live = null;

/**
 * Draw the page into `el`. `route.arg` picks the first section shown.
 * @param {HTMLElement} el
 * @param {{ arg?: string }} [route]
 */
function mountPage(el, route = {}) {
  el.innerHTML = `
<div class="view-root set-page" tabindex="-1">
  <div class="set-wrap">
    <nav class="set-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections"></nav>
    <section class="set-pane" role="tabpanel" aria-labelledby="set-title">
      <h1 class="page-title view-title" id="set-title">Settings</h1>
      <div class="set-body"></div>
    </section>
  </div>
</div>`;
  // All drawn just above.
  const root = /** @type {HTMLElement} */ (el.querySelector('.set-page'));
  const nav = /** @type {HTMLElement} */ (root.querySelector('.set-nav'));
  const titleEl = /** @type {HTMLElement} */ (root.querySelector('#set-title'));
  const body = /** @type {HTMLElement} */ (root.querySelector('.set-body'));
  /** The tab that is on, when the list is drawn. */
  const onTab = () => /** @type {HTMLElement | null} */ (nav.querySelector('.set-tab.on'));

  let current = null;
  let sectionHandle = null;
  let seq = 0;
  let unmounted = false;

  const dropSection = () => {
    if (sectionHandle && typeof sectionHandle.unmount === 'function') {
      try { sectionHandle.unmount(); } catch (e) { console.error('[shell] settings section', e); }
    }
    sectionHandle = null;
  };

  function paintNav() {
    const secs = allSections();
    nav.innerHTML = secs.map((s) => `<button type="button" role="tab" class="set-tab${s.id === current ? ' on' : ''}"
        data-sec="${esc(s.id)}" aria-selected="${s.id === current}" tabindex="${s.id === current ? 0 : -1}">${esc(s.title)}</button>`).join('');
  }

  async function show(id) {
    const secs = allSections();
    // `keys` is the section Help replaced: a route or a command that still names it lands there.
    const want = id === 'keys' ? 'help' : id;
    const sec = secs.find((s) => s.id === want) || secs[0];
    if (!sec) return;
    const my = ++seq;
    dropSection();
    current = sec.id;
    paintNav();
    titleEl.textContent = sec.title;
    body.textContent = '';
    body.dataset.sec = sec.id;
    if ('render' in sec) {
      // A section someone else registered draws into a box of its own. One that throws is one
      // line saying so, never a page that fails to open.
      const box = document.createElement('div');
      box.className = 'set-section';
      body.appendChild(box);
      try {
        const h = await Promise.resolve(sec.render(box));
        if (my !== seq || unmounted) { if (h && typeof h.unmount === 'function') h.unmount(); return; }
        sectionHandle = h && typeof h === 'object' ? h : null;
      } catch (e) {
        console.error('[shell] settings section', sec.id, e);
        box.innerHTML = `<div class="set-note err">This section could not be drawn: ${esc(String(messageOf(e)))}</div>`;
      }
      return;
    }
    const html = await Promise.resolve(sec.html());
    if (my !== seq || unmounted) return;
    body.innerHTML = html;
    syncControls(body);
    if (sec.id === 'vault') paintVaultInfo(body);
    if (sec.id === 'updates') void paintUpdates(body);
  }

  nav.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('.set-tab') : null;
    if (b instanceof HTMLElement) void show(b.dataset.sec).then(() => onTab()?.focus());
  });
  // A vertical tab list: Up and Down move and show, Home and End go to the ends, Tab leaves
  // for the rows.
  nav.addEventListener('keydown', (e) => {
    const tabs = /** @type {HTMLElement[]} */ ([...nav.querySelectorAll('.set-tab')]);
    const at = tabs.findIndex((t) => t.dataset.sec === current);
    let next = -1;
    if (e.key === 'ArrowDown') next = (at + 1) % tabs.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    void show(tab.dataset.sec).then(() => onTab()?.focus());
  });

  body.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const act = e.target.closest('[data-act]');
    if (act instanceof HTMLElement && act.dataset.act === 'vault') { void commands.run('app.vault-change'); return; }
    if (act instanceof HTMLButtonElement && act.dataset.act === 'update') { void checkNow(act); return; }
    const b = e.target.closest('.seg-b');
    if (!(b instanceof HTMLElement)) return;
    const seg = b.closest('.seg');
    const row = b.parentElement;
    if (!(seg instanceof HTMLElement) || !row) return;
    const group = seg.dataset.seg;
    row.querySelectorAll('.seg-b').forEach((n) => {
      n.classList.toggle('on', n === b);
      n.setAttribute('aria-pressed', String(n === b));
    });
    applySeg(group, b.dataset.v, body);
  });

  // The chords change values from outside the page (zoom, the theme toggle, full width), and
  // another window on the same vault can too: the controls follow, nothing is redrawn.
  const offs = [
    bus.on('settings', () => syncControls(body)),
    bus.on('theme', () => syncControls(body)),
    ose.settings.onRepaint(() => syncControls(body)),
  ];

  live = {
    show: (id) => show(id),
    focus: () => onTab()?.focus(),
  };
  const first = show(route && route.arg);

  return {
    ready: first,
    unmount() {
      unmounted = true;
      seq++;
      dropSection();
      for (const off of offs) { try { off && off(); } catch { /* already gone */ } }
      live = null;
    },
  };
}

const view = {
  title: 'Settings',
  icon: 'settings',
  async mount(el, route) {
    const h = mountPage(el, route);
    await h.ready;
    return { unmount: h.unmount };
  },
  unmount() { /* the handle answered by mount does the work */ },
};

/**
 * Open Settings in a tab, or bring its tab forward, showing section `arg` when one is named.
 * @param {string} [arg] a section id: 'appearance', 'editor', 'files', 'updates', 'vault', 'help', or a registered one
 * @returns {Promise<void>}
 */
export async function openSettings(arg) {
  const route = { type: 'view', name: 'settings' };
  if (arg) route.arg = arg;
  await ose.tabs.open(route);
  if (live && arg) await live.show(arg);
  if (live) live.focus();
}

/** Register the Settings view and its commands, and apply the settings once. Called by `boot.js`. */
export function initSettings() {
  ose.settings.apply();
  ose.views.register('settings', view);
  commands.register({ id: 'app.settings', title: 'Settings', group: 'app', run: () => openSettings() });
  commands.register({ id: 'app.update', title: 'Check for updates', group: 'app', hint: 'Settings, Updates', run: () => openSettings('updates') });
  commands.register({ id: 'app.help', title: 'Help', group: 'app', hint: 'Settings, Help', run: () => openSettings('help') });
  commands.register({ id: 'app.keys', title: 'Keyboard shortcuts', group: 'app', hint: 'Settings, Help', run: () => openSettings('help') });
  const root = store.get('root') || {};
  commands.register({ id: 'app.vault-change', title: 'Change vault…', group: 'app', hint: root.root || '', run: changeVault });
  // A window of its own (X6), on no vault: it opens on the chooser. Change vault… offers the
  // same for a vault, with Shift+Enter on a row or its "Open in new tab" button.

  // The page view is one command too, so switching between the scroll and the sheet is a
  // palette away rather than a page away.
  commands.register({
    id: 'app.layout', title: 'Toggle page view', group: 'app', hint: 'scroll or A4 pages',
    run: () => {
      const pages = document.documentElement.dataset.layout === 'pages';
      save({ layout: pages ? 'scroll' : 'pages' });
    },
  });

  // Zoom is three commands, so the palette has them and the chords (Ctrl+=, Ctrl+-, Ctrl+0)
  // have something to bind to.
  commands.register({
    id: 'app.zoom-in', title: 'Zoom in', group: 'app', hint: 'bigger text and chrome',
    when: () => zoom() < Math.max(...ZOOM_STEPS),
    run: () => stepZoom(1),
  });
  commands.register({
    id: 'app.zoom-out', title: 'Zoom out', group: 'app', hint: 'smaller text and chrome',
    when: () => zoom() > Math.min(...ZOOM_STEPS),
    run: () => stepZoom(-1),
  });
  commands.register({
    id: 'app.zoom-reset', title: 'Reset zoom', group: 'app', hint: 'back to 100%',
    when: () => zoom() !== 100,
    run: () => setZoom(100),
  });
}
