// The chords that only mean anything with the caret in a page body — the editor's own.
//
// This table once lived beside the window chords, because the shell owned every key in the
// app. The window chords are the shell's now (`keys.json`, docs/SHELL.md) and every command
// below is one `ose:editor` registers itself, so the table came with it: commands.js binds
// them into the ProseMirror keymap, where they have to be answered before Milkdown's own
// bindings see the key, and the menus print them.
//
// `ose.keys.bind(combo, id, { scope: 'body' })` is the other half: the shell binds a body
// chord through the kernel, and `ose.keys.shortcutFor(id)` then prints it. This table is what
// the editor answers by itself, in the editor, with no trip through the window listener.

/** True on a Mac, by what the host told the page, else by what the browser says. */
export const isMac = () => {
  const os = document.documentElement.dataset.os;
  if (os) return os === 'mac';
  const p = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /mac/i.test(p);
};

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

/** The combo an entry means on this platform. */
export const comboFor = (k) => (isMac() && k.mac) || k.combo;

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
 * matches nothing in the table, which is exactly the point.
 *
 * The same normalisation the kernel's key engine does, because the two have to agree on what
 * a key is called; if `ose.keys` ever offers it, this goes and that is called instead.
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
