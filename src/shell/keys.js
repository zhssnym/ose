// The keyboard map from CONTRACT.md. Bound on window in the capture phase so no module can
// shadow it. Esc is deliberately not captured unless an overlay is open: the editor's block
// selection uses it.
import { commands } from '../registry.js';
import { overlayCount, closeTopOverlay, overlayHasInputFocus, toast, dismissToast } from './dialog.js';

export const KEYMAP = [
  { combo: 'ctrl+k', cmd: 'app.palette', label: 'Ctrl+K' },
  { combo: 'ctrl+p', cmd: 'app.quickopen', label: 'Ctrl+P' },
  { combo: 'ctrl+n', cmd: 'page.new', label: 'Ctrl+N' },
  { combo: 'ctrl+s', cmd: 'page.save', label: 'Ctrl+S' },
  { combo: 'ctrl+\\', cmd: 'app.sidebar', label: 'Ctrl+\\' },
  { combo: 'ctrl+shift+e', cmd: 'app.focus-sidebar', label: 'Ctrl+Shift+E' },
  { combo: 'ctrl+f', cmd: 'app.search', label: 'Ctrl+F' },
  { combo: 'ctrl+shift+f', cmd: 'app.search', label: 'Ctrl+Shift+F' }, // old habit, kept as an alias
  { combo: 'alt+arrowleft', cmd: 'app.back', label: 'Alt+Left' },
  { combo: 'alt+arrowright', cmd: 'app.forward', label: 'Alt+Right' },
  { combo: 'ctrl+,', cmd: 'app.settings', label: 'Ctrl+,' },
  { combo: 'ctrl+shift+l', cmd: 'app.theme', label: 'Ctrl+Shift+L' },
];

// First entry wins, so a command with an alias still shows its primary shortcut.
const BY_CMD = new Map();
for (const k of KEYMAP) if (!BY_CMD.has(k.cmd)) BY_CMD.set(k.cmd, k.label);
const BY_COMBO = new Map(KEYMAP.map((k) => [k.combo, k]));

/** The palette and menus read their hints from here so the map has one source. */
export function shortcutFor(id) { return BY_CMD.get(id) || null; }

// While an overlay input has focus these still fire; everything else is left to the overlay.
const OVERLAY_SAFE = new Set(['app.palette', 'app.quickopen', 'app.settings', 'app.theme', 'app.search']);

function comboOf(e) {
  const k = e.key;
  if (!k || k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null;
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(k.toLowerCase());
  return parts.join('+');
}

// Why a chord did nothing, in the user's terms. `commands.run` returns silently when a `when`
// guard says no, and Ctrl+S over a view used to be exactly that silence (D5).
const UNAVAILABLE = {
  'page.save': 'nothing to save here',
  'app.back': 'nothing to go back to',
  'app.forward': 'nothing to go forward to',
};

function fire(id) {
  const c = commands.get(id);
  if (!c) { toast(`${id} is not available yet`, 'warn', 2200); return; }
  if (c.when && !c.when()) { toast(UNAVAILABLE[id] || `${(c.title || id).toLowerCase()}: not available here`, 'info', 2200); return; }
  try { commands.run(id); } catch (e) { console.error('[shell] command', id, e); toast(String(e.message || e), 'err'); }
}

export function initKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (overlayCount() > 0) { e.preventDefault(); e.stopPropagation(); closeTopOverlay(); return; }
      // No overlay: the newest toast goes, and the key still falls through, because the
      // editor's block selection uses Esc too and both may want it (D10).
      dismissToast();
      return;
    }

    const combo = comboOf(e);
    if (!combo) return;
    const entry = BY_COMBO.get(combo);
    if (!entry) return;

    // A chord typed into a dialog's input that is not overlay-safe belongs to the input
    // (Ctrl+A, Ctrl+Z...): leave it entirely alone, no preventDefault, or it dies in silence.
    if (overlayHasInputFocus() && !OVERLAY_SAFE.has(entry.cmd)) return;

    // Never let the browser act on a mapped combo (Ctrl+P print, Ctrl+S save page).
    e.preventDefault();
    e.stopPropagation();
    fire(entry.cmd);
  }, true);
}
