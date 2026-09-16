// The keyboard map (docs/CONTRACT.md "Keyboard map", batch 12). Obsidian's map, with one
// platform switch: `Mod` is Cmd on macOS and Ctrl everywhere else, so on a Mac the app never
// claims Ctrl+P/N/K/F/A/E/H (the Emacs caret bindings) and never claims Option+Left/Right
// (word motion) — back and forward move to Cmd+[ and Cmd+] there.
//
// Shell chords are bound on `window` in the capture phase so no module can shadow them. Esc is
// deliberately not captured unless an overlay is open: the editor's block selection uses it.
//
// Body chords (BODY_KEYS) are *not* bound here. They live in this file so that `shortcutFor`
// stays the one source of every hint the palette and the menus draw; `editor/commands.js`
// reads the list and binds it inside a ProseMirror keymap, where a chord can stand down for a
// code block or a table.
import { commands, allCommands, commandsRevision } from './registry.js';
import { overlayCount, closeTopOverlay, overlayHasInputFocus, toast, dismissToast } from './dialog.js';

/** Cmd on macOS, Ctrl elsewhere. Read live: the shell sets `data-os` after the bridge answers. */
export function isMac() {
  const os = document.documentElement.dataset.os;
  if (os) return os === 'mac';
  // Until the shell knows, guess. `userAgentData.platform` first, then the old string.
  const p = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /mac/i.test(p);
}

/**
 * combo   the chord, `mod` for Ctrl-or-Cmd, parts in the order mod, ctrl, shift, alt, key
 * mac     a different chord on macOS (a collision with a system or Emacs binding)
 * label   what the palette and the menus print; the mac label swaps Ctrl for Cmd on its own
 * inBody  inside the editor body this one belongs to the body keymap: let it through
 *
 * A chord in CODE_KEYS (below) is CodeMirror's inside a code block, whether it is in this
 * table or in BODY_KEYS.
 */
export const KEYMAP = [
  { combo: 'mod+p', cmd: 'app.palette', label: 'Ctrl+P' },
  { combo: 'mod+o', cmd: 'app.quickopen', label: 'Ctrl+O' },
  { combo: 'mod+n', cmd: 'page.new', label: 'Ctrl+N' },
  { combo: 'mod+s', cmd: 'page.save', label: 'Ctrl+S' },
  { combo: 'mod+w', cmd: 'page.close', label: 'Ctrl+W' },
  { combo: 'mod+q', cmd: 'app.quit', label: 'Ctrl+Q' },
  { combo: 'mod+\\', cmd: 'app.sidebar', label: 'Ctrl+\\' },
  { combo: 'mod+shift+e', cmd: 'app.focus-sidebar', label: 'Ctrl+Shift+E' },
  { combo: 'mod+shift+n', cmd: 'tree.new-folder', label: 'Ctrl+Shift+N' },
  // Ctrl+F is find in the open page, as in every editor a person arrives from; the vault search
  // is Ctrl+Shift+F, where VS Code and Obsidian keep theirs (batch 9).
  { combo: 'mod+f', cmd: 'page.find', label: 'Ctrl+F' },
  // Ctrl+H is delete-backwards on macOS (D1: never claim it there); Cmd+Alt+F is VS Code's.
  { combo: 'mod+h', cmd: 'page.replace', label: 'Ctrl+H', mac: 'mod+alt+f', macLabel: 'Cmd+Alt+F' },
  { combo: 'mod+shift+f', cmd: 'app.search', label: 'Ctrl+Shift+F' },
  { combo: 'mod+shift+o', cmd: 'page.outline', label: 'Ctrl+Shift+O' },
  { combo: 'mod+e', cmd: 'page.source-toggle', label: 'Ctrl+E' },
  { combo: 'mod+k', cmd: 'format.link', label: 'Ctrl+K' },
  // Option+Enter on a Mac too, as Obsidian does.
  { combo: 'alt+enter', cmd: 'page.follow-link', label: 'Alt+Enter', macLabel: 'Option+Enter' },
  { combo: 'mod+shift+t', cmd: 'app.reopen-closed', label: 'Ctrl+Shift+T' },
  { combo: 'mod+=', cmd: 'app.zoom-in', label: 'Ctrl+=' },
  { combo: 'mod+shift+=', cmd: 'app.zoom-in', label: 'Ctrl+Shift+=' },
  { combo: 'mod+-', cmd: 'app.zoom-out', label: 'Ctrl+-' },
  // In the body Ctrl+0 is `block.paragraph`, so the block group Ctrl+0…Ctrl+6 is one gesture;
  // everywhere else it resets the zoom, and `app.zoom-reset` is always in the palette.
  { combo: 'mod+0', cmd: 'app.zoom-reset', label: 'Ctrl+0', inBody: true },
  { combo: 'alt+arrowleft', cmd: 'app.back', label: 'Alt+Left', mac: 'mod+[', macLabel: 'Cmd+[' },
  { combo: 'alt+arrowright', cmd: 'app.forward', label: 'Alt+Right', mac: 'mod+]', macLabel: 'Cmd+]' },
  { combo: 'mod+,', cmd: 'app.settings', label: 'Ctrl+,' },
  { combo: 'mod+shift+l', cmd: 'app.theme', label: 'Ctrl+Shift+L' },
];

/**
 * The chords that only mean anything with the caret in the editor body. `editor/commands.js`
 * binds them; nothing here does. Digits are matched on `event.code` as well as `event.key`
 * (see `combosOf`), which is what makes the block group work on an AZERTY row (E26).
 */
export const BODY_KEYS = [
  { combo: 'mod+b', cmd: 'format.bold', label: 'Ctrl+B' },
  { combo: 'mod+i', cmd: 'format.italic', label: 'Ctrl+I' },
  { combo: 'mod+shift+x', cmd: 'format.strike', label: 'Ctrl+Shift+X' },
  { combo: 'mod+`', cmd: 'format.code', label: 'Ctrl+`' },
  { combo: 'mod+shift+m', cmd: 'format.clear', label: 'Ctrl+Shift+M' },
  // hintOnly: the browser's own plain paste already answers this one, and Esc is blocks.js's.
  // They are here so the palette can print their chords, and bound by nobody.
  { combo: 'mod+shift+v', cmd: 'format.paste-plain', label: 'Ctrl+Shift+V', hintOnly: true },
  { combo: 'mod+0', cmd: 'block.paragraph', label: 'Ctrl+0' },
  { combo: 'mod+1', cmd: 'block.h1', label: 'Ctrl+1' },
  { combo: 'mod+2', cmd: 'block.h2', label: 'Ctrl+2' },
  { combo: 'mod+3', cmd: 'block.h3', label: 'Ctrl+3' },
  { combo: 'mod+4', cmd: 'block.h4', label: 'Ctrl+4' },
  { combo: 'mod+5', cmd: 'block.h5', label: 'Ctrl+5' },
  { combo: 'mod+6', cmd: 'block.h6', label: 'Ctrl+6' },
  { combo: 'mod+shift+7', cmd: 'block.numbered', label: 'Ctrl+Shift+7' },
  { combo: 'mod+shift+8', cmd: 'block.bullet', label: 'Ctrl+Shift+8' },
  { combo: 'mod+shift+9', cmd: 'block.task', label: 'Ctrl+Shift+9' },
  { combo: 'mod+shift+.', cmd: 'block.quote', label: 'Ctrl+Shift+.' },
  { combo: 'mod+shift+c', cmd: 'block.code', label: 'Ctrl+Shift+C' },
  { combo: 'mod+enter', cmd: 'block.toggle-task', label: 'Ctrl+Enter' },
  { combo: 'alt+arrowup', cmd: 'block.move-up', label: 'Alt+Up' },
  { combo: 'alt+arrowdown', cmd: 'block.move-down', label: 'Alt+Down' },
  { combo: 'mod+d', cmd: 'block.duplicate', label: 'Ctrl+D' },
  { combo: 'mod+shift+k', cmd: 'block.delete', label: 'Ctrl+Shift+K' },
  { combo: 'escape', cmd: 'block.select', label: 'Esc', hintOnly: true },
  // P2's proposal, taken: they fire only with the caret inside a table, so they cost nothing
  // anywhere else, and Alt+Shift+Arrow is bound by nothing today.
  { combo: 'shift+alt+arrowup', cmd: 'table.row-above', label: 'Alt+Shift+Up' },
  { combo: 'shift+alt+arrowdown', cmd: 'table.row-below', label: 'Alt+Shift+Down' },
  { combo: 'shift+alt+arrowleft', cmd: 'table.col-left', label: 'Alt+Shift+Left' },
  { combo: 'shift+alt+arrowright', cmd: 'table.col-right', label: 'Alt+Shift+Right' },
];

/**
 * A code block is a real editor: CodeMirror binds these six itself (move by syntax node, move
 * and copy a line, select the next occurrence, delete the line), and this listener runs in the
 * capture phase, so without an exemption it would take them before CodeMirror ever saw the key
 * (E18, P4's list). Everything else the shell binds still works inside a code block.
 *
 * Only two of the six can ever reach the check below, because `byCombo` is built from KEYMAP
 * alone: `alt+arrowleft` and `alt+arrowright`. The other four are body chords, and
 * `commands.js codeTarget()` has already stood the body keymap down inside a code block. The
 * set stays whole all the same — it is the list of what CodeMirror owns, not a list of what
 * this file happens to match today, and a chord that moves between the two tables must not
 * quietly lose its exemption on the way.
 */
export const CODE_KEYS = new Set([
  'alt+arrowleft', 'alt+arrowright', 'alt+arrowup', 'alt+arrowdown', 'mod+d', 'mod+shift+k',
]);

/**
 * A standalone `codeEditor` (`.ed-code`) is a document of its own: it binds Ctrl+S to its own
 * save (`src/editor/code-editor.js`) and carries CodeMirror's own search panel on Ctrl+F. A
 * code block inside a page is not one of these — there Ctrl+S saves the page and Ctrl+F opens
 * the page's find bar — which is why this is `.ed-code` and not `.cm-editor`.
 */
export const OWN_EDITOR_KEYS = new Set(['mod+s', 'mod+f']);

const PART_LABEL = {
  mod: () => (isMac() ? 'Cmd' : 'Ctrl'), ctrl: () => 'Ctrl', alt: () => (isMac() ? 'Option' : 'Alt'),
  shift: () => 'Shift', meta: () => (isMac() ? 'Cmd' : 'Win'), enter: () => 'Enter', escape: () => 'Esc',
  arrowleft: () => 'Left', arrowright: () => 'Right', arrowup: () => 'Up', arrowdown: () => 'Down',
};

/** `mod+shift+j` as the palette prints it: `Ctrl+Shift+J`, `Cmd+Shift+J` on a Mac. */
export function comboLabel(combo) {
  return String(combo || '').split('+').filter(Boolean)
    .map((p) => (PART_LABEL[p] ? PART_LABEL[p]() : (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))))
    .join('+');
}

/** The label of an entry on this platform. A binding carries no label: its combo is one. */
function labelOf(k) {
  if (!k.label) return comboLabel(k.combo);
  if (!isMac()) return k.label;
  return k.macLabel || k.label.replace(/\bCtrl\b/g, 'Cmd').replace(/\bAlt\b/g, 'Option');
}

/** The combo of an entry on this platform. */
export function comboFor(k) { return (isMac() && k.mac) || k.combo; }

// First entry wins, so a command with an alias still shows its primary shortcut. Rebuilt when
// the platform is settled: `data-os` may arrive after this module is first imported.
let byCmd = null;
let byCombo = null;
let builtMac = null;
let builtRev = -1;

/**
 * `ose.keys.bind(combo, commandId, { scope })` (docs/KERNEL.md): the rice's `keys.json` and a
 * module's `shortcut` come through here. Bindings are applied after the defaults, so a rice
 * that binds `mod+shift+j` takes that chord over whatever the shell had on it; removing the
 * binding gives the default back. `scope: 'body'` means the chord only fires with the caret in
 * a page editor, which is what `inBody` has always meant in BODY_KEYS.
 *
 * Normalised so `Mod+Shift+J`, `mod+shift+j` and `MOD+SHIFT+j` are one chord.
 */
const bindings = new Map();   // combo -> { combo, cmd, inBody }
export const normalizeCombo = (c) => String(c || '').toLowerCase().split('+').map((p) => p.trim()).filter(Boolean).join('+');

export function bindKey(combo, commandId, { scope = 'window' } = {}) {
  const key = normalizeCombo(combo);
  if (!key || !commandId) throw new Error('keys.bind: a combo and a command id are required');
  const entry = { combo: key, cmd: String(commandId), inBody: scope === 'body' };
  bindings.set(key, entry);
  byCmd = null;                                   // rebuilt on the next lookup
  return () => { if (bindings.get(key) === entry) { bindings.delete(key); byCmd = null; } };
}

/** What is bound to a combo right now: a binding, else the default, else null. */
export function bindingFor(combo) {
  index();
  return byCombo.get(normalizeCombo(combo)) || null;
}

/**
 * `commands.register({ shortcut })` is a binding, not a printed hint (docs/MODULES.md rule 4):
 * the chord fires the command and `shortcutFor` answers it. It is read off the registry here
 * rather than bound inside `commands.register`, so `registry.js` keeps importing nothing and
 * the chord goes with the command — the unsubscribe removes the command, the next index leaves
 * the chord out. Scope is always 'window'; a chord that should stand down inside the editor
 * body is `keys.bind(combo, id, { scope: 'body' })`.
 */
function commandShortcuts() {
  const out = [];
  for (const c of allCommands()) {
    if (!c.shortcut) continue;
    const combo = normalizeCombo(c.shortcut);
    if (!combo) continue;
    // A chord the kernel already owns is not a **module's** to take. Installing one used to
    // move Ctrl+Shift+N from `tree.new-folder` to whatever the module asked for, app-wide and
    // silently, and the sidebar then printed no chord at all for the command it had lost
    // (ADV-B, first finding). The kernel keeps its binding, the module's command keeps none —
    // it is still in the palette, and the rice may give it a chord in `keys.json` if the
    // vault's owner wants one. Said once per command per combo: `index()` runs on every
    // registration.
    //
    // The rice is not a module: it owns the window, and a rice that replaces `page.close` with
    // a `tab.close` of its own on Ctrl+W is doing what a rice is for (`cockpit/shell/tabs.js`).
    // Only a command the module facade tagged is held to this.
    const held = c.module ? kernelCombos().get(combo) : null;
    if (held) { warnOnce(combo, c.id, held); continue; }
    out.push({ combo, cmd: c.id, inBody: false });
  }
  return out;
}

/** The combos KEYMAP holds on this platform, combo -> the command the kernel gives it. */
let kernelComboCache = null;
let kernelComboMac = null;
function kernelCombos() {
  const mac = isMac();
  if (kernelComboCache && kernelComboMac === mac) return kernelComboCache;
  kernelComboMac = mac;
  kernelComboCache = new Map(KEYMAP.map((k) => [normalizeCombo(comboFor(k)), k.cmd]));
  return kernelComboCache;
}

const warned = new Set();
function warnOnce(combo, cmd, held) {
  const key = `${combo}|${cmd}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[keys] ${cmd} asks for ${combo}, which the kernel binds to ${held}: ${cmd} keeps no chord`);
}

function index() {
  const mac = isMac();
  const rev = commandsRevision();
  if (byCmd && builtMac === mac && builtRev === rev) return;
  builtMac = mac;
  builtRev = rev;
  byCmd = new Map();
  byCombo = new Map();
  const shortcuts = commandShortcuts();
  for (const k of KEYMAP) byCombo.set(normalizeCombo(comboFor(k)), k);
  // Then a command's own `shortcut`, then the explicit bindings: a rice's keys.json wins over
  // a module's shortcut, and both win over a default rather than fighting it.
  for (const k of shortcuts) byCombo.set(k.combo, k);
  for (const [combo, entry] of bindings) byCombo.set(combo, entry);
  // What a command prints is what its chord **does**. `byCombo` is the arbiter — a rice's
  // keys.json over a module's `shortcut` over a shell default — so the printed hints are read
  // back out of it rather than out of the three tables that fed it. A command whose chord was
  // taken by another command answers null and the palette prints nothing for it, instead of
  // printing a chord that runs something else (QA-K defect 4).
  //
  // Insertion order is KEYMAP, then the shortcuts, then the bindings, and a `set` on a combo
  // that is already there keeps its place. So the first chord a command was given still wins
  // its label, which is what keeps `app.zoom-in` printing Ctrl+= and not Ctrl+Shift+=.
  for (const entry of byCombo.values()) {
    if (!byCmd.has(entry.cmd)) byCmd.set(entry.cmd, labelOf(entry));
  }
  // Body chords are bound by `editor/commands.js` inside a ProseMirror keymap and are not in
  // `byCombo` at all. One still loses its chord if a **window** binding took the combo: the
  // window listener runs in the capture phase and only stands down for an entry of its own
  // that is marked `inBody`.
  for (const k of BODY_KEYS) {
    if (byCmd.has(k.cmd)) continue;
    const owner = byCombo.get(normalizeCombo(comboFor(k)));
    if (owner && owner.cmd !== k.cmd && !owner.inBody) continue;
    byCmd.set(k.cmd, labelOf(k));
  }
}

/** The palette, the slash menu and the context menu read their hints from here. */
export function shortcutFor(id) { index(); return byCmd.get(id) || null; }

// While an overlay input has focus these still fire; everything else is left to the overlay.
// `app.quit` is in the set for the same reason `app.settings` is: with the caret in a dialog
// input, Ctrl+Q used to do nothing at all — not even a toast, because the handler returns
// before `preventDefault` (QA severity 4).
const OVERLAY_SAFE = new Set([
  'app.palette', 'app.quickopen', 'app.settings', 'app.theme', 'app.search', 'app.quit',
  'app.zoom-in', 'app.zoom-out', 'app.zoom-reset',
]);

// Characters whose place moves with the layout. `event.code` is the physical key, so matching
// it as well as `event.key` is what makes Ctrl+1 reach Heading 1 on an AZERTY row, where the
// digit row is shift-only and `event.key` is `&é"'(-` (E26).
const BY_CODE = {
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4',
  Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9',
  Equal: '=', NumpadAdd: '=', Minus: '-', NumpadSubtract: '-',
  Period: '.', NumpadDecimal: '.', Comma: ',', Backquote: '`', Backslash: '\\',
};

/**
 * Every combo string this event could mean, most specific first: the one built from
 * `event.key`, then the one built from `event.code` when the physical key names a different
 * character. `mod` is the platform's command modifier; a plain Ctrl on a Mac is `ctrl` and
 * matches nothing in the map, which is exactly the point.
 */
export function combosOf(e) {
  const k = e.key;
  if (!k || k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return [];
  const mac = isMac();
  const parts = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('mod');
  if (mac && e.ctrlKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  const prefix = parts.length ? parts.join('+') + '+' : '';
  const key = k === ' ' ? 'space' : k.toLowerCase();
  const out = [prefix + key];
  const code = BY_CODE[e.code];
  if (code && code !== key) out.push(prefix + code);
  return out;
}

// Why a chord did nothing, in the user's terms. `commands.run` returns silently when a `when`
// guard says no, and Ctrl+S over a view used to be exactly that silence (D5).
const UNAVAILABLE = {
  'page.save': 'nothing to save here',
  'page.close': 'no page to close',
  'app.back': 'nothing to go back to',
  'app.forward': 'nothing to go forward to',
  'app.reopen-closed': 'nothing to reopen',
  'format.link': 'put the caret in the page first',
  'page.follow-link': 'no link under the caret',
};

function fire(id) {
  const c = commands.get(id);
  if (!c) { toast(`${id} is not available yet`, 'warn', 2200); return; }
  if (c.when && !c.when()) { toast(UNAVAILABLE[id] || `${(c.title || id).toLowerCase()}: not available here`, 'info', 2200); return; }
  try { commands.run(id); } catch (e) { console.error('[shell] command', id, e); toast(String(e.message || e), 'err'); }
}

const inside = (e, sel) => e.target instanceof Element && !!e.target.closest(sel);

export function initKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.isComposing) return;                        // an IME conversion is not a chord (E44)
    if (e.key === 'Escape') {
      if (overlayCount() > 0) { e.preventDefault(); e.stopPropagation(); closeTopOverlay(); return; }
      // No overlay: the newest toast goes, and the key still falls through, because the
      // editor's block selection uses Esc too and both may want it (D10).
      dismissToast();
      return;
    }

    index();
    let entry = null;
    let combo = null;
    for (const c of combosOf(e)) {
      entry = byCombo.get(normalizeCombo(c));
      if (entry) { combo = c; break; }
    }
    if (!entry) return;

    // A chord CodeMirror owns keeps working inside a code block (Alt+Arrows move by syntax
    // node there); everywhere else in the app it is the shell's.
    if (CODE_KEYS.has(combo) && inside(e, '.cm-editor')) return;
    if (OWN_EDITOR_KEYS.has(combo) && inside(e, '.ed-code')) return;
    // A chord the body keymap owns (Ctrl+0 = paragraph) falls through inside the body.
    if (entry.inBody && inside(e, '.ProseMirror')) return;

    // A chord typed into a dialog's input that is not overlay-safe belongs to the input
    // (Ctrl+A, Ctrl+Z...): leave it entirely alone, no preventDefault, or it dies in silence.
    if (overlayHasInputFocus() && !OVERLAY_SAFE.has(entry.cmd)) return;

    // Never let the browser act on a mapped combo (Ctrl+P print, Ctrl+S save page).
    e.preventDefault();
    e.stopPropagation();
    fire(entry.cmd);
  }, true);
}
