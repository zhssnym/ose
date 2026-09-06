// The keyboard map from CONTRACT.md. Bound on window in the capture phase so no module can
// shadow it. Esc is deliberately not captured unless an overlay is open: the Claude composer
// uses it to interrupt.
import { commands } from '../registry.js';
import { overlayCount, closeTopOverlay, overlayHasInputFocus, toast } from './dialog.js';

export const KEYMAP = [
  { combo: 'ctrl+k', cmd: 'app.palette', label: 'Ctrl+K' },
  { combo: 'ctrl+p', cmd: 'app.quickopen', label: 'Ctrl+P' },
  { combo: 'ctrl+n', cmd: 'page.new', label: 'Ctrl+N' },
  { combo: 'ctrl+s', cmd: 'page.save', label: 'Ctrl+S' },
  { combo: 'ctrl+\\', cmd: 'app.sidebar', label: 'Ctrl+\\' },
  { combo: 'ctrl+j', cmd: 'claude.toggle', label: 'Ctrl+J' },
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
// Chords the shell keeps even while the Claude terminal has focus.
const TERMINAL_SAFE = new Set(['app.palette', 'app.quickopen', 'app.search', 'app.settings', 'app.theme', 'claude.toggle']);

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

function fire(id) {
  if (!commands.get(id)) { toast(`${id} is not available yet`, 'warn', 2200); return; }
  try { commands.run(id); } catch (e) { console.error('[shell] command', id, e); toast(String(e.message || e), 'err'); }
}

export function initKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (overlayCount() > 0) { e.preventDefault(); e.stopPropagation(); closeTopOverlay(); }
      return; // otherwise fall through: the Claude composer and the sidebar search use Esc
    }

    const combo = comboOf(e);
    if (!combo) return;
    const entry = BY_COMBO.get(combo);
    if (!entry) return;

    // Inside the Claude terminal every key belongs to the CLI except the app-wide chords
    // (CONTRACT.md batch 6). Ctrl+J stays mapped: claude.toggle turns it into a newline there.
    if (e.target && e.target.closest && e.target.closest('.agent-pane') && !TERMINAL_SAFE.has(entry.cmd)) return;

    // Never let the browser act on a mapped combo (Ctrl+P print, Ctrl+S save page).
    e.preventDefault();
    e.stopPropagation();

    if (overlayHasInputFocus() && !OVERLAY_SAFE.has(entry.cmd)) return;
    fire(entry.cmd);
  }, true);
}
