// The settings core (docs/KERNEL.md, `ose.settings`). Every value persists under
// `.ose/state.json` `settings`. The dialog that draws them is rice, not kernel, and stays in
// the shell; the kernel keeps the defaults, the read and the write, what the rest of the app
// asks of a setting (zoom, spellcheck, trash, new pages, attachments), applying them to the
// document, and the registry of the extra sections a module contributes.
import { bus } from './registry.js';
import { patchState, stateCache } from './state.js';

export const FONT_SIZES = [14, 15, 16, 17];
export const LINE_HEIGHTS = [1.5, 1.65, 1.8];
/** Zoom steps, per cent (S4). 100 is the app as designed; the rest scale every rem token. */
export const ZOOM_STEPS = [90, 100, 110, 125, 150];

// The dialog shows the theme, reading comfort, where new files go, the sources, updates and
// the read-only block. `updates` is the switch on the app's one network call (update.js).
export const DEFAULTS = {
  fontSize: 16,
  lineHeight: 1.65,
  readableWidth: true,
  zoom: 100,
  newPages: 'focus',
  attachments: 'beside',
  trash: 'system',
  spellcheck: true,
  updates: true,
};

export function settings() { return { ...DEFAULTS, ...(stateCache().settings || {}) }; }

/* --------------------------------------------------------------- repaint and subscription */

// A dialog that is open while a chord changes a value (Ctrl+= with settings up) has to redraw
// itself. The kernel does not know that dialog, so it keeps a list of repainters the rice adds
// and drops; nothing here ever reaches into anybody's DOM.
const repainters = new Set();
export function onRepaint(fn) { repainters.add(fn); return () => repainters.delete(fn); }
function repaint() {
  for (const fn of [...repainters]) { try { fn(); } catch (e) { console.error('[settings] repaint', e); } }
}

/** `ose.settings.on(fn)`: every write, with the whole settings object. */
export function onSettings(fn) { return bus.on('settings', fn); }

/**
 * `ose.settings.section({ id, title, render })` (docs/KERNEL.md): a section the settings
 * dialog draws under the stock rows. The kernel keeps the list in registration order and the
 * rice asks for it; a module's section goes with the rest of its registrations on unload.
 */
const sectionMap = new Map();
export const sections = {
  register(def) {
    if (!def || !def.id || typeof def.render !== 'function') throw new Error('settings.section: id and render required');
    sectionMap.set(def.id, { order: 100, ...def });
    return () => sectionMap.delete(def.id);
  },
  list: () => [...sectionMap.values()].sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id))),
  get: (id) => sectionMap.get(id),
};

export function save(partial) {
  const next = { ...settings(), ...partial };
  patchState({ settings: next });
  applySettings();
  // Modules that read a setting instead of asking for it every keystroke (the editor's
  // spellcheck attribute) re-read here; the payload is the whole settings object.
  bus.emit('settings', next);
  return next;
}

/* ------------------------------------------------------------------ what other modules ask */

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

/** Read by the editor: `spellcheck` on the body, on by default (S36). */
export function spellcheckOn() { return settings().spellcheck !== false; }

/** `system` (the recycle bin) or `vault` (`.trash` inside the vault). Passed to `bridge.trash`. */
export function trashMode() { return settings().trash === 'vault' ? 'vault' : 'system'; }

/** One line for the trash confirmation, so it says where the file is going (S37). */
export function trashDestination() {
  return trashMode() === 'vault' ? '.trash in the vault' : 'the system recycle bin';
}

/** Where new pages are created: `focus` (today's behaviour), `scratch`, `page` (S34). */
export function newPageMode() {
  const m = settings().newPages;
  return m === 'scratch' || m === 'page' ? m : 'focus';
}

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

  root.style.setProperty('--zoom', String(zoom() / 100));
  root.classList.toggle('full-width', s.readableWidth === false);
}
