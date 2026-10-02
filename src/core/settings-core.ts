// The settings core (docs/CORE.md, `ose.settings`). Two scopes (W5, M26): the vault's
// settings live in `.ose/state.json` `settings` and travel with the vault (where trash goes,
// where attachments go, title sync); this machine's live in the per-machine store
// (`ose.local.app('settings')`: reading comfort, Show hidden, the restore switch, `.md` in
// names). `settings()` merges the defaults with both, `save(partial)` sends each key to its
// own scope. The page that draws them is the shell's; the core keeps the defaults, the read
// and the write, what the rest of the app asks of a setting, applying them to the document,
// and the registry of the sections a built-in module contributes.
import { bus } from './registry.ts';
import { patchState, stateCache } from './state.ts';
import { local } from './local.ts';

export const FONT_SIZES = [14, 15, 16, 17];
// A document's leading, not a web page's. 1.35 is what Word gives a 12pt Cambria body at
// "1.15 line spacing", which is the teacher's page; 1.25 is tighter still and 1.5 is the
// loosest a page of prose stays a page. A value saved before this list (1.65, 1.8) is not in
// it and falls back to the default, below.
export const LINE_HEIGHTS = [1.25, 1.35, 1.5];
// The face a page's own text is set in. `document` is the serif of a printed handout, which is
// what a page has always been here; `plain` is the interface face, for a reader who would
// rather not have a serif. Only the family moves: the sizes, the leading, the rhythm and the
// frames are the document's either way (tokens.css, `:root[data-face="plain"]`).
export const PAGE_FACES = ['document', 'plain'];
// How a page is laid out on screen. `scroll` is one continuous column; `pages` is the A4 sheet
// it prints on, at the print size, with a rule where each sheet ends (src/editor/sheets.ts).
export const LAYOUTS = ['scroll', 'pages'];
/** How a markdown file opens when it remembers no mode of its own (X1). */
export const EDITOR_MODES = ['rich', 'source'];
/** Zoom steps, per cent (S4). 100 is the app as designed; the rest scale every rem token. */
export const ZOOM_STEPS = [90, 100, 110, 125, 150];

export const DEFAULTS = {
  fontSize: 16,
  lineHeight: 1.35,
  pageFace: 'document',
  layout: 'scroll',
  readableWidth: true,
  zoom: 100,
  spellcheck: true,
  showHidden: false,
  hideMdExt: false,
  attachments: 'beside',
  trash: 'system',
  titleSync: false,
  // How a markdown file opens the first time (X1): 'rich' or 'source'. A file the user
  // left in another mode remembers it (`src/editor/modes.ts`); a plain text file is Source.
  editorMode: 'rich',
};

/**
 * The keys that belong to this machine rather than to the vault (W5). Every other key,
 * including one a built-in module invents, is the vault's and goes to `.ose/state.json`.
 */
export const MACHINE_KEYS = new Set([
  'fontSize', 'lineHeight', 'pageFace', 'layout', 'readableWidth', 'zoom', 'spellcheck',
  'showHidden', 'hideMdExt', 'editorMode',
]);

// Settings an older build wrote that mean nothing now: never answered, never written back.
const RETIRED = new Set(['newPages', 'restoreSession']);

const machine = () => local.app('settings');

/** The machine half, as stored. */
function machinePart() {
  const v = machine().get();
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** The vault half, as stored in the state file. */
function vaultPart() {
  const v = stateCache().settings;
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** The defaults, then the vault's keys from the state file, then this machine's keys. */
export function settings() {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(vaultPart())) if (!MACHINE_KEYS.has(k) && !RETIRED.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(machinePart())) if (MACHINE_KEYS.has(k)) out[k] = v;
  return out;
}

/* --------------------------------------------------------------- repaint and subscription */

// A dialog that is open while a chord changes a value (Ctrl+= with settings up) has to redraw
// itself. The core does not know that dialog, so it keeps a list of repainters the shell adds
// and drops; nothing here ever reaches into anybody's DOM.
const repainters = new Set<any>();
export function onRepaint(fn) { repainters.add(fn); return () => repainters.delete(fn); }
function repaint() {
  for (const fn of [...repainters]) { try { fn(); } catch (e) { console.error('[settings] repaint', e); } }
}

/** `ose.settings.on(fn)`: every write, with the whole settings object. */
export function onSettings(fn) { return bus.on('settings', fn); }

/**
 * `ose.settings.section({ id, title, order?, render(el) -> { unmount? } })` (docs/CORE.md): a
 * section the Settings page draws beside its own. The core keeps the list, sorted by `order`
 * (100 when none is given), and the shell asks for it.
 */
const sectionMap = new Map();
export const sections = {
  register(def) {
    if (!def || !def.id || typeof def.render !== 'function') throw new Error('settings.section: id and render required');
    // First registration wins, as it does for a view (registry.ts).
    if (sectionMap.has(def.id)) { console.warn('[settings] section already registered:', def.id); return () => {}; }
    const entry = { order: 100, ...def };
    sectionMap.set(def.id, entry);
    return () => { if (sectionMap.get(def.id) === entry) sectionMap.delete(def.id); };
  },
  list: () => [...sectionMap.values()].sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id))),
  get: (id) => sectionMap.get(id),
};

/**
 * Write `partial`: each key to its scope (machine keys to `ose.local.app('settings')`, every
 * other key to the state file), then apply and announce. A key set to `undefined` goes back to
 * its default. Answers the whole merged settings object.
 */
export function save(partial) {
  const p = partial && typeof partial === 'object' ? partial : {};
  const mine = { ...machinePart() };
  const vault = { ...vaultPart() };
  let toMachine = false;
  let toVault = false;
  for (const [k, v] of Object.entries(p)) {
    if (RETIRED.has(k)) continue;
    const at = MACHINE_KEYS.has(k) ? mine : vault;
    if (v === undefined) delete at[k]; else at[k] = v;
    if (MACHINE_KEYS.has(k)) toMachine = true; else toVault = true;
  }
  if (toMachine) machine().set(mine);
  if (toVault) patchState({ settings: vault });
  const next = settings();
  applySettings();
  // Whoever reads a setting instead of asking for it every keystroke (the editor's spellcheck
  // attribute, a listing that follows Show hidden) re-reads here; the payload is the whole
  // settings object.
  bus.emit('settings', next);
  return next;
}

/* ------------------------------------------------------------------ what the rest of the app asks */

/** The zoom in per cent, always one of ZOOM_STEPS. */
export function zoom() {
  const z = +settings().zoom;
  return ZOOM_STEPS.includes(z) ? z : 100;
}

/** `110%` while zoomed, null at 100: what the status bar draws (S4). */
export function zoomLabel() {
  const z = zoom();
  return z === 100 ? null : `${z}%`;
}

export function setZoom(pct) {
  const z = ZOOM_STEPS.includes(+pct) ? +pct : 100;
  save({ zoom: z });
  repaint();
  return z;
}

/** One step in or out, clamped at the ends rather than wrapping. */
export function stepZoom(dir) {
  const at = ZOOM_STEPS.indexOf(zoom());
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, (at < 0 ? 1 : at) + dir));
  setZoom(ZOOM_STEPS[next]);
}

/** `document` or `plain`: the face a page's own text is set in. */
export function pageFace() {
  const f = settings().pageFace;
  return PAGE_FACES.includes(f) ? f : DEFAULTS.pageFace;
}

/** `scroll` or `pages`: how a page is laid out on screen. */
export function layout() {
  const l = settings().layout;
  return LAYOUTS.includes(l) ? l : DEFAULTS.layout;
}

/** `rich` or `source`: the mode a markdown file with no remembered mode opens in. */
export function editorMode() {
  const m = settings().editorMode;
  return EDITOR_MODES.includes(m) ? m : DEFAULTS.editorMode;
}

/** Read by the editor: `spellcheck` on the body, on by default (S36). */
export function spellcheckOn() { return settings().spellcheck !== false; }

/** `system` (the recycle bin) or `vault` (`.trash` inside the vault). Passed to `bridge.trash`. */
export function trashMode() { return settings().trash === 'vault' ? 'vault' : 'system'; }

/** One line for the trash confirmation, so it says where the file is going (S37). */
export function trashDestination() {
  return trashMode() === 'vault' ? '.trash in this vault' : 'the system recycle bin';
}

/** Show hidden items (H16): what a listing passes as `hidden` when its caller names none. */
export function showHidden() { return settings().showHidden === true; }

/**
 * The folder an attachment dropped on `pagePath` belongs in (S35). Default: `attachments/`
 * beside the page, which is what the editor did before this was a setting. Otherwise the one
 * vault folder the user named, wherever the page lives. Always a vault-relative folder path,
 * never a leading slash.
 */
export function attachmentFolder(pagePath) {
  const s = settings().attachments;
  if (typeof s === 'string' && s !== 'beside') return s.replace(/^\/+|\/+$/g, '');
  const dir = String(pagePath || '').replace(/[^/]*$/, '').replace(/\/+$/, '');
  return dir ? `${dir}/attachments` : 'attachments';
}

/* ------------------------------------------------------------------ applying */

export function applySettings() {
  const s = settings();
  const root = document.documentElement;

  const size = FONT_SIZES.includes(+s.fontSize) ? +s.fontSize : DEFAULTS.fontSize;
  // rem, not px: the zoom factor lives in the root font size (tokens.css), and a body size in
  // px would be the one text in the app that refused to zoom.
  root.style.setProperty('--fs-body', `${size / 16}rem`);

  const lh = LINE_HEIGHTS.includes(+s.lineHeight) ? +s.lineHeight : DEFAULTS.lineHeight;
  root.style.setProperty('--lh-body', String(lh));

  // One attribute, read by one rule in tokens.css: `--font-doc` becomes `--font-ui` for
  // `plain`. Everything that wears the document face — the page column, the title strip,
  // `render()`, paper — follows it in the same frame, because they all read that token.
  root.dataset.face = pageFace();
  root.dataset.layout = layout();

  root.style.setProperty('--zoom', String(zoom() / 100));
  root.classList.toggle('full-width', s.readableWidth === false);
}
