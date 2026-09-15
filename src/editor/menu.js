// The editor's context menu (batch 12, package P3, D8): right-click, Shift+F10 and the Menu
// key in the body. Built on shell/dialog.js `contextMenu`, the same component the tree uses, so
// arrows, Home/End, letter jumps, Enter and Esc are already right and the two menus cannot
// drift apart. See docs/CONTRACT.md batch 12 "The editor's context menu".
//
// Every row is a registered command, drawn from the registry with its own title and its own
// chord: a command that is not registered yet (P2's tables, P5's images) simply has no row,
// and one whose `when` is false is left out of the menu the same way it is left out of the
// palette. Nothing here knows what a table op does.
//
// Exports read by extensions.js: plugins(ctx, o).

import { commands, contextMenu, shortcutFor, toast } from './host.js';
import { isMac } from './keymap.js';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';

const KEY = new PluginKey('os-editor-menu');

// ---------------------------------------------------------------------------
// rows

/** One row per registered, currently allowed command; nothing when it is neither. */
function row(id, label) {
  const c = commands.get(id);
  if (!c) return null;
  if (c.when && !c.when()) return null;
  return { label: label || c.title, shortcut: shortcutFor(id) || c.shortcut || '', run: () => commands.run(id) };
}

const rows = (...ids) => ids.map((id) => (Array.isArray(id) ? row(id[0], id[1]) : row(id))).filter(Boolean);

/** A separator, but only between two groups that both have rows. */
function join(groups) {
  const out = [];
  for (const g of groups) {
    if (!g.length) continue;
    if (out.length) out.push({ sep: true });
    out.push(...g);
  }
  return out;
}

const TURN_INTO = [
  ['block.paragraph', 'Paragraph'],
  ['block.h1', 'Heading 1'], ['block.h2', 'Heading 2'], ['block.h3', 'Heading 3'],
  ['block.h4', 'Heading 4'], ['block.h5', 'Heading 5'], ['block.h6', 'Heading 6'],
  ['block.bullet', 'Bullet list'], ['block.numbered', 'Numbered list'], ['block.task', 'Task list'],
  ['block.quote', 'Quote'], ['block.code', 'Code block'],
];

/**
 * The "Turn into…" list, as a menu of its own at the same place. `contextMenu` has no
 * submenus and one level of menu is enough: the second menu takes the focus, Esc returns.
 */
export function turnIntoMenu(view, at) {
  const point = at || caretPoint(view);
  const items = TURN_INTO.map(([id, label]) => row(id, label)).filter(Boolean);
  if (items.length) contextMenu(point.x, point.y, items);
}

/** Where a keyboard-invoked menu should appear: at the caret, in viewport coordinates. */
function caretPoint(view) {
  try {
    const c = view.coordsAtPos(view.state.selection.from);
    return { x: Math.round(c.left), y: Math.round(c.bottom) };
  } catch {
    const r = view.dom.getBoundingClientRect();
    return { x: Math.round(r.left + 24), y: Math.round(r.top + 24) };
  }
}

/**
 * The clipboard three. Cut and copy go through `document.execCommand`, which runs
 * ProseMirror's own copy handler, so what leaves is the same rich slice Ctrl+C sends — the
 * editor has to be focused first, or the DOM selection is the menu's and not the page's.
 * Paste cannot: no browser lets a script run the paste command. It reads the clipboard
 * instead and hands the result to the view's own paste path, which is the same code Ctrl+V
 * ends in; when the read is refused, the row says which key to press.
 */
function clipboardRows(view) {
  const mod = isMac() ? 'Cmd' : 'Ctrl';
  const empty = view.state.selection.empty;
  const out = [];
  if (!empty) {
    out.push({ label: 'Cut', shortcut: `${mod}+X`, run: () => { view.focus(); document.execCommand('cut'); } });
    out.push({ label: 'Copy', shortcut: `${mod}+C`, run: () => { view.focus(); document.execCommand('copy'); } });
  }
  out.push({ label: 'Paste', shortcut: `${mod}+V`, run: () => void paste(view, mod) });
  out.push(...rows(['format.paste-plain', 'Paste as plain text']));
  if (!empty) out.push(...rows(['format.copy-markdown', 'Copy as markdown']));
  return out;
}

async function paste(view, mod) {
  view.focus();
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes('text/html')) {
        view.pasteHTML(await (await item.getType('text/html')).text());
        return;
      }
      if (item.types.includes('text/plain')) {
        view.pasteText(await (await item.getType('text/plain')).text());
        return;
      }
    }
  } catch { /* the read was refused, or there is no rich clipboard api */ }
  try {
    const text = await navigator.clipboard.readText();
    if (text) { view.pasteText(text); return; }
  } catch { /* fall through to the hint */ }
  toast(`press ${mod}+V to paste`, 'info');
}

function build(view, event) {
  const onImage = event && event.target instanceof Element
    && !!event.target.closest('milkdown-image-block, milkdown-image-inline, img');
  return join([
    clipboardRows(view),
    [
      { label: 'Turn into…', run: () => turnIntoMenu(view, event ? { x: event.clientX, y: event.clientY } : null) },
      ...rows(['format.link', 'Link…'], 'format.link-remove', 'format.clear'),
    ].filter(Boolean),
    rows('table.row-above', 'table.row-below', 'table.col-left', 'table.col-right',
      'table.delete-row', 'table.delete-col', 'table.delete',
      'table.align-left', 'table.align-center', 'table.align-right'),
    onImage ? rows('image.open', 'image.copy-path', 'image.caption') : [],
    rows('block.select', 'block.duplicate', 'block.delete'),
  ]);
}

// ---------------------------------------------------------------------------
// when the menu is ours

/**
 * Spelling (D8). The brief asks that a right-click on a word the WebView has underlined fall
 * through to the native menu, so its suggestions stay reachable — but no browser exposes
 * whether a given word is underlined, and the only signal that exists ("this element is
 * spellchecked") is true of the whole body, which would mean never showing our menu at all.
 * So the fall-through is a gesture instead: hold Shift while right-clicking and the page does
 * not claim the event. It is the one honest version of the rule. (Whether anything answers it
 * is the host's: with the WebView's own menu switched off there are no suggestions to reach.)
 */
const nativeMenuWanted = (event) => event.shiftKey;

function open(view, event, point) {
  const items = build(view, event);
  if (!items.length) return false;
  event.preventDefault();
  contextMenu(point.x, point.y, items);
  return true;
}

export function plugins() {
  return [new Plugin({
    key: KEY,
    props: {
      handleDOMEvents: {
        contextmenu: (view, event) => {
          if (!view.editable) return false;
          if (event.target instanceof Element && event.target.closest('.cm-editor')) return false;
          if (nativeMenuWanted(event)) return false;            // Shift: the native menu
          return open(view, event, { x: event.clientX, y: event.clientY });
        },
      },
      handleKeyDown: (view, event) => {
        if (event.isComposing) return false;
        const wanted = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
        if (!wanted) return false;
        if (event.target instanceof Element && event.target.closest('.cm-editor')) return false;
        return open(view, event, caretPoint(view));
      },
    },
  })];
}
