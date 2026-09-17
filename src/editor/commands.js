// Formatting commands: every action inside the body as a registered command with a chord, in
// the palette. Marks, blocks, lists, checkbox toggle, block movement, wrap-selection-with-pair,
// link.
//
// Exports read by extensions.js: plugins(ctx, o), registerCommands(api).
//
// The chords are not written here: `keymap.js` BODY_KEYS is the one table, and the keymap
// below is a loop over it that runs the registered command. A key and a palette entry can
// therefore never mean two different things, and `shortcutFor` prints the same label in the
// palette, the slash menu and the context menu.

import { commands, clearRoute, copyText } from './host.js';
import { BODY_KEYS, comboFor, combosOf } from './keymap.js';
import { commandsCtx, editorViewCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core';
import { Fragment, Slice } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { findParent } from '@milkdown/kit/prose';
import {
  blockquoteSchema, bulletListSchema, codeBlockSchema, headingSchema, hrSchema,
  liftListItemCommand, listItemSchema, orderedListSchema, paragraphSchema,
  selectTextNearPosCommand, setBlockTypeCommand, sinkListItemCommand,
  toggleEmphasisCommand, toggleInlineCodeCommand, toggleStrongCommand, wrapInBlockTypeCommand,
} from '@milkdown/kit/preset/commonmark';
import { createTable, goToNextTableCellCommand, goToPrevTableCellCommand, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
import { canJoin } from '@milkdown/kit/prose/transform';
import { lift } from '@milkdown/kit/prose/commands';
import { postProcess } from './stringify.js';
import { deleteRange, duplicateRange, moveRange, selectBlock } from './blocks.js';
import { linkAt, linkCommand, removeLink } from './link.js';
import { turnIntoMenu } from './menu.js';
import { toast } from './deps.js';

// ---------------------------------------------------------------------------
// the open page, through the api index.js hands us (never an import back)

/** @type {any} */
let api = null;

const view = () => { try { return api && api.getView(); } catch { return null; } };
const hasBody = () => { const v = view(); return !!v && v.editable !== false; };

/** Run `fn(ctx)` on the open editor. Milkdown's own commands need the ctx, not the view. */
function withCtx(fn) {
  const crepe = api && api.getCrepe();
  if (!crepe) return undefined;
  try { return crepe.editor.action(fn); } catch (e) { console.error('[editor] command', e); return undefined; }
}

/** Milkdown command by key. */
const call = (ctx, key, payload) => ctx.get(commandsCtx).call(key, payload);

/**
 * The palette blurs the editor before it runs a command, and every one of these acts on the
 * caret, so the caret comes back first. ProseMirror keeps the selection across the blur.
 */
function focused() {
  const v = view();
  if (v && !v.hasFocus()) v.focus();
  return v;
}

// ---------------------------------------------------------------------------
// where the caret is

const inList = ($pos) => !!findParent((n) => n.type.name === 'list_item')($pos);
const parentOfType = ($pos, name) => findParent((n) => n.type.name === name)($pos);

function inCodeBlock(state) {
  const $from = state.selection.$from;
  if ($from.parent && $from.parent.type.spec.code) return true;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.spec.code) return true;
  return false;
}

const inTable = (state) => !!parentOfType(state.selection.$from, 'table');

/** The innermost list item, whatever kind. */
const itemAt = (state) => parentOfType(state.selection.$from, 'list_item');

/** The textblock the caret sits in: `paragraph`, `heading`, `code_block`, a table cell… */
const blockType = (state) => state.selection.$from.parent.type.name;

/** The list the innermost item belongs to: `bullet_list`, `ordered_list`, or null. */
function listKind(state) {
  const item = itemAt(state);
  if (!item) return null;
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'bullet_list' || name === 'ordered_list') {
      return { list: name, task: item.node.attrs.checked != null };
    }
  }
  return { list: 'bullet_list', task: item.node.attrs.checked != null };
}

// ---------------------------------------------------------------------------
// document edits (the same shapes slash.js uses, so a menu item and a chord agree)

function liftOutOfList(ctx) {
  const v = ctx.get(editorViewCtx);
  for (let i = 0; i < 10 && inList(v.state.selection.$from); i++) {
    if (!call(ctx, liftListItemCommand.key)) break;
  }
}

function turnInto(ctx, type, attrs) {
  liftOutOfList(ctx);
  call(ctx, setBlockTypeCommand.key, { nodeType: type(ctx), attrs: attrs || null });
}

/**
 * Merge the list the caret is in with an identical list touching it: two adjacent bullet lists
 * cannot be written as markdown without alternating the marker, which would rewrite a list the
 * user never touched (the reasoning is spelled out in slash.js).
 */
function joinNeighbourLists(ctx) {
  const v = ctx.get(editorViewCtx);
  const { state } = v;
  const $from = state.selection.$from;
  let d = $from.depth;
  while (d > 0 && !/_list$/.test($from.node(d).type.name)) d--;
  if (d === 0) return;
  let tr = state.tr;
  let joined = false;
  for (const pos of [$from.after(d), $from.before(d)]) {
    const $pos = tr.doc.resolve(pos);
    if ($pos.nodeBefore && $pos.nodeAfter && $pos.nodeBefore.type === $pos.nodeAfter.type
        && canJoin(tr.doc, pos)) { tr = tr.join(pos); joined = true; }
  }
  if (joined) v.dispatch(tr);
}

function wrapInto(ctx, type, attrs, join) {
  liftOutOfList(ctx);
  call(ctx, wrapInBlockTypeCommand.key, { nodeType: type(ctx), attrs: attrs || null });
  if (join) joinNeighbourLists(ctx);
}

/** Ctrl+N on a heading you already have takes it back to a paragraph, as Notion does. */
function heading(level) {
  return () => withCtx((ctx) => {
    focused();
    const { state } = ctx.get(editorViewCtx);
    const at = state.selection.$from.parent;
    if (blockType(state) === 'heading' && at.attrs.level === level) turnInto(ctx, paragraphSchema.type);
    else turnInto(ctx, headingSchema.type, { level });
  });
}

/** Out of every list, and then out of one blockquote if that is where the caret ended up. */
function toParagraph(ctx) {
  liftOutOfList(ctx);
  const v = ctx.get(editorViewCtx);
  if (parentOfType(v.state.selection.$from, 'blockquote')) lift(v.state, v.dispatch);
  turnInto(ctx, paragraphSchema.type);
}

/** A list command: the same list twice is a paragraph, a different list converts. */
function list(kind, attrs) {
  return () => withCtx((ctx) => {
    focused();
    const { state } = ctx.get(editorViewCtx);
    const held = listKind(state);
    const wanted = kind === 'ordered_list' ? 'ordered_list' : 'bullet_list';
    const task = !!(attrs && attrs.checked !== undefined);
    if (held && held.list === wanted && held.task === task) { toParagraph(ctx); return; }
    const type = task ? listItemSchema.type
      : (wanted === 'ordered_list' ? orderedListSchema.type : bulletListSchema.type);
    wrapInto(ctx, type, attrs, true);
  });
}

function quote() {
  return () => withCtx((ctx) => {
    focused();
    const { state } = ctx.get(editorViewCtx);
    if (parentOfType(state.selection.$from, 'blockquote')) { toParagraph(ctx); return; }
    wrapInto(ctx, blockquoteSchema.type);
  });
}

/** A whole block after the current one, or in its place when the current one is empty. */
function putBlock(ctx, make) {
  const v = ctx.get(editorViewCtx);
  const node = make(ctx);
  if (!node) return;
  const { state } = v;
  const $from = state.selection.$from;
  const d = $from.depth;
  const empty = $from.parent.isTextblock && $from.parent.content.size === 0;
  const at = empty ? $from.before(d) : $from.after(d);
  const tr = empty ? state.tr.replaceWith(at, $from.after(d), node) : state.tr.insert(at, node);
  const inside = node.isTextblock || node.type.name === 'table';
  const end = at + node.nodeSize;
  if (!inside) {
    const next = tr.doc.resolve(end).nodeAfter;
    if (!next || !next.isTextblock) tr.insert(end, paragraphSchema.type(ctx).createAndFill());
  }
  v.dispatch(tr);
  call(ctx, selectTextNearPosCommand.key, { pos: at + (inside ? 1 : node.nodeSize) });
}

/**
 * Obsidian's checkbox cycle: a plain item becomes an unchecked task, an unchecked task becomes
 * checked, a checked task goes back to a plain item (E11). One `setNodeMarkup`, so the file
 * changes by exactly the three characters that changed.
 */
function toggleTask() {
  const v = focused();
  if (!v) return;
  const item = itemAt(v.state);
  if (!item) return;
  const checked = item.node.attrs.checked;
  const next = checked == null ? false : (checked === false ? true : null);
  const tr = v.state.tr.setNodeMarkup(item.from, undefined, { ...item.node.attrs, checked: next });
  v.dispatch(tr);
}

/** Clear every inline mark over the selection (or the stored marks, with a caret). */
function clearMarks() {
  const v = focused();
  if (!v) return;
  const { state } = v;
  const sel = state.selection;
  if (sel.empty) { v.dispatch(state.tr.setStoredMarks([])); return; }
  v.dispatch(state.tr.removeMark(sel.from, sel.to).scrollIntoView());
}

// ---------------------------------------------------------------------------
// markdown of a selection (S8)

/**
 * The selection as the markdown a save would write. Inline content is wrapped in a paragraph
 * first: `doc` is `block+` and would refuse it. Falls back to plain text, never throws — a
 * copy that fails silently is worse than a copy that loses its markers.
 */
export function sliceMarkdown(ctx, slice) {
  try {
    const schema = ctx.get(schemaCtx);
    let content = slice.content;
    const first = content.firstChild;
    if (first && first.isInline) content = Fragment.from(schema.nodes.paragraph.create(null, content));
    const doc = schema.nodes.doc.create(null, content);
    const md = postProcess(ctx.get(serializerCtx)(doc));
    return md.replace(/\n+$/, '');
  } catch (e) {
    console.error('[editor] copy as markdown', e);
    return slice.content.textBetween(0, slice.content.size, '\n\n');
  }
}

function copySelectionMarkdown() {
  const v = focused();
  if (!v || v.state.selection.empty) return;
  const md = withCtx((ctx) => sliceMarkdown(ctx, v.state.selection.content()));
  if (!md) return;
  void copyText(md).then((ok) => toast(ok ? 'copied' : 'could not copy', ok ? 'info' : 'err'));
}

/**
 * Ctrl+Shift+V is the browser's own plain paste and needs no code; the command exists so the
 * palette says so (S9) and so a menu row can do it. It reads the clipboard itself, which the
 * host and the dev server both allow (a secure context).
 */
async function pastePlain() {
  const v = focused();
  if (!v) return;
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { text = ''; }
  if (!text) { toast('nothing to paste · Ctrl+Shift+V pastes plain text', 'info'); return; }
  const { state } = v;
  const { schema } = state;
  // Plain means plain: every line is a paragraph of text, and nothing is parsed as markdown.
  // Open on both ends, so a single line lands inline instead of splitting the block.
  const paras = text.replace(/\r\n/g, '\n').split('\n')
    .map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line) : null));
  v.dispatch(state.tr.replaceSelection(new Slice(Fragment.from(paras), 1, 1)).scrollIntoView());
  v.focus();
}

// ---------------------------------------------------------------------------
// the commands

const def = (id, title, group, run, when) => ({ id, title, group, run, when: when || hasBody });

export function registerCommands(editorApi) {
  api = editorApi;

  const marks = [
    ['format.bold', 'Bold', toggleStrongCommand],
    ['format.italic', 'Italic', toggleEmphasisCommand],
    ['format.strike', 'Strikethrough', toggleStrikethroughCommand],
    ['format.code', 'Inline code', toggleInlineCodeCommand],
  ];
  for (const [id, title, cmd] of marks) {
    commands.register(def(id, title, 'format', () => withCtx((ctx) => { focused(); call(ctx, cmd.key); })));
  }

  commands.register(def('format.link', 'Link…', 'format', () => { const v = focused(); if (v) void linkCommand(v); }));
  commands.register(def('format.link-remove', 'Remove link', 'format',
    () => { const v = focused(); if (v) removeLink(v); },
    () => { const v = view(); return !!v && !!linkAt(v.state); }));
  commands.register(def('format.clear', 'Clear formatting', 'format', clearMarks));
  commands.register(def('format.copy-markdown', 'Copy selection as markdown', 'format', copySelectionMarkdown,
    () => { const v = view(); return !!v && !v.state.selection.empty; }));
  commands.register(def('format.paste-plain', 'Paste as plain text', 'format', () => void pastePlain()));

  commands.register(def('block.paragraph', 'Paragraph', 'block',
    () => withCtx((ctx) => { focused(); toParagraph(ctx); })));
  for (let level = 1; level <= 6; level++) {
    commands.register(def(`block.h${level}`, `Heading ${level}`, 'block', heading(level)));
  }
  commands.register(def('block.bullet', 'Bullet list', 'block', list('bullet_list', null)));
  commands.register(def('block.numbered', 'Numbered list', 'block', list('ordered_list', null)));
  commands.register(def('block.task', 'Task list', 'block', list('bullet_list', { checked: false })));
  commands.register(def('block.quote', 'Quote', 'block', quote()));
  commands.register(def('block.code', 'Code block', 'block', () => withCtx((ctx) => {
    focused();
    const v = ctx.get(editorViewCtx);
    if (inCodeBlock(v.state)) turnInto(ctx, paragraphSchema.type);
    else turnInto(ctx, codeBlockSchema.type);
  })));
  commands.register(def('block.divider', 'Divider', 'block',
    () => withCtx((ctx) => { focused(); putBlock(ctx, (x) => hrSchema.type(x).createAndFill()); })));
  commands.register(def('block.table', 'Table', 'block', () => {
    focused();
    // P2 owns tables: their insert knows about headers and alignment. Ours is the fallback
    // for the moment before their module registers.
    if (commands.get('table.insert')) { commands.run('table.insert'); return; }
    withCtx((ctx) => putBlock(ctx, (x) => createTable(x, 3, 3)));
  }));

  commands.register(def('block.toggle-task', 'Toggle checkbox', 'block', toggleTask,
    () => { const v = view(); return !!v && !!itemAt(v.state); }));
  commands.register(def('block.move-up', 'Move block up', 'block', () => { const v = focused(); if (v) moveRange(v, -1); }));
  commands.register(def('block.move-down', 'Move block down', 'block', () => { const v = focused(); if (v) moveRange(v, 1); }));
  commands.register(def('block.duplicate', 'Duplicate block', 'block', () => { const v = focused(); if (v) duplicateRange(v); }));
  commands.register(def('block.delete', 'Delete block', 'block', () => { const v = focused(); if (v) deleteRange(v); }));
  commands.register(def('block.select', 'Select block', 'block', () => { const v = focused(); if (v) selectBlock(v); }));
  commands.register(def('block.turn-into', 'Turn into…', 'block', () => { const v = focused(); if (v) turnIntoMenu(v); }));

  commands.register({
    id: 'page.close', title: 'Close page', group: 'page',
    when: () => !!api.getPath(),
    run: () => void closePage(),
  });
  commands.register({
    id: 'page.replace', title: 'Find and replace', group: 'page',
    when: () => !!api.getPath(),
    run: () => openReplace(),
  });
}

/** Ctrl+W: the page is saved through the normal path, then the start surface takes over. */
async function closePage() {
  try { await api.saveNow({ explicit: true }); } catch (e) { console.error('[editor] close', e); }
  clearRoute();
}

/**
 * Ctrl+H. index.js knows which bar the open page has — the block editor's, or CodeMirror's
 * own panel in source mode, where replace is built in. Asking `find.js currentFind()` here
 * meant the chord did nothing at all on a page in source mode (QA F5).
 */
function openReplace() {
  api.openFind({ replace: true });
}

// ---------------------------------------------------------------------------
// the keymap

let byCombo = null;
function bodyCombos() {
  if (byCombo) return byCombo;
  byCombo = new Map();
  for (const k of BODY_KEYS) if (!k.hintOnly) byCombo.set(comboFor(k), k);
  return byCombo;
}

/** A code block keeps every key it has; so does anything CodeMirror draws. */
function codeTarget(v, event) {
  const t = event.target;
  if (t instanceof Element && t.closest('.cm-editor, .milkdown-code-block')) return true;
  return inCodeBlock(v.state);
}

// The pairs a selection can be wrapped in (E25). `*`, `_` and the backtick mean marks in a
// WYSIWYG — writing the characters themselves would put literal asterisks in the file and the
// serialiser would escape them — so those three run the mark command. `(` and `"` are ordinary
// punctuation and are written as they are; `[` opens the link dialog, as it does in Obsidian.
const WRAP_MARK = { '*': toggleEmphasisCommand, _: toggleEmphasisCommand, '`': toggleInlineCodeCommand };
const WRAP_PAIR = { '(': ')', '"': '"' };

const TASK_START = /^\[([ xX]?)\]$/;

/**
 * The one keydown handler for the body. Order matters: Tab and Backspace are rules, not
 * commands, and the BODY_KEYS loop comes last so a chord whose command says `when: false`
 * (a table chord outside a table) falls through to whatever else wants it.
 */
function handleKeyDown(ctx, v, event) {
  if (event.isComposing || event.keyCode === 229) return false;      // E44
  if (codeTarget(v, event)) return false;

  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    return handleTab(ctx, v, event);
  }

  // E31: Backspace at the start of a heading is one press to a paragraph, not a walk down the
  // levels. Milkdown binds `downgradeHeadingCommand` here and is asked after us.
  if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    const sel = v.state.selection;
    if (sel.empty && sel.$from.parent.type.name === 'heading' && sel.$from.parentOffset === 0) {
      event.preventDefault();
      turnInto(ctx, paragraphSchema.type);
      return true;
    }
  }

  // CODE_KEYS are CodeMirror's inside a code block; `codeTarget` above has already stood down
  // for those, so in prose every body chord is ours.
  const map = bodyCombos();
  for (const combo of combosOf(event)) {
    const entry = map.get(combo);
    if (!entry) continue;
    const c = commands.get(entry.cmd);
    if (!c || (c.when && !c.when())) continue;
    event.preventDefault();
    commands.run(entry.cmd);
    return true;
  }
  return false;
}

/**
 * Tab, and the whole of D2. `plugin-indent` is gone (crepe.js removes it), so nothing types
 * spaces any more; this decides everything instead, and always claims the key so focus can
 * never walk out of the page.
 */
function handleTab(ctx, v, event) {
  const { state } = v;
  event.preventDefault();

  // A selection with the toolbar up, or a link with its tooltip up: Tab goes to the buttons.
  if (!event.shiftKey && tabIntoTooling(v)) return true;

  if (inTable(state)) {
    call(ctx, event.shiftKey ? goToPrevTableCellCommand.key : goToNextTableCellCommand.key);
    return true;                                   // the last cell: nothing, never a space
  }
  if (itemAt(state)) {
    call(ctx, event.shiftKey ? liftListItemCommand.key : sinkListItemCommand.key);
    return true;                                   // the first item: nothing, never a space
  }
  return true;                                     // D2: Tab in prose does nothing at all
}

/**
 * E41: the selection toolbar and the link tooltip are real buttons, so Tab reaches them and
 * Enter acts. They are only on screen when they are on screen — the toolbar follows a
 * selection, the link tooltip a hover — so this only fires when there is something to enter.
 */
function tabIntoTooling(v) {
  const root = v.dom.closest('.milkdown') || document;
  const preview = shown(root.querySelector('.milkdown-link-preview'));
  if (preview && linkAt(v.state)) {
    keyboardEnable(preview);
    const first = preview.querySelector('[data-os-kb]');
    if (first) { first.focus(); return true; }
  }
  const bar = shown(root.querySelector('.milkdown-toolbar'));
  if (bar && !v.state.selection.empty) {
    const first = bar.querySelector('.toolbar-item');
    if (first) { first.focus(); return true; }
  }
  return false;
}

const shown = (el) => (el && el.getClientRects().length ? el : null);

/** Give the tooltip's icon buttons a tab stop and a role; idempotent. */
function keyboardEnable(host) {
  for (const el of host.querySelectorAll('.link-edit-button, .link-remove-button, .link-icon')) {
    if (el.dataset.osKb) continue;
    el.dataset.osKb = '1';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
  }
}

/**
 * Enter and Space on a focused tooltip icon, and Escape from anywhere in the toolbar or the
 * tooltip, which puts the caret back where it was. Bound on the editor's own container, so it
 * dies with the page.
 */
function toolingKeys(v) {
  const root = v.dom.closest('.milkdown');
  if (!root) return () => {};
  const onKey = (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    const inTooling = el.closest('.milkdown-toolbar, .milkdown-link-preview');
    if (!inTooling) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); v.focus(); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = el.closest('.toolbar-item, [data-os-kb]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    // Crepe's toolbar listens for `pointerdown`, not `click`, so Enter has to say it that way.
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    if (item.hasAttribute('data-os-kb')) item.click();
  };
  root.addEventListener('keydown', onKey, true);
  return () => root.removeEventListener('keydown', onKey, true);
}

// ---------------------------------------------------------------------------
// text input: wrapping a selection, and `[] ` for a task

function handleTextInput(ctx, v, from, to, text) {
  const { state } = v;
  if (inCodeBlock(state)) return false;
  const sel = state.selection;

  // E25: a pair typed over a selection wraps it instead of replacing it.
  if (!sel.empty && text.length === 1 && from === sel.from && to === sel.to) {
    if (sel.$from.marks().some((m) => m.type.spec.code)) return false;
    if (text === '[') { void linkCommand(v); return true; }
    const mark = WRAP_MARK[text];
    if (mark) { call(ctx, mark.key); return true; }
    const close = WRAP_PAIR[text];
    if (close) {
      const tr = state.tr.insertText(close, to).insertText(text, from);
      tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1));
      v.dispatch(tr.scrollIntoView());
      return true;
    }
    return false;
  }

  // E12/L22: `[] `, `[ ] `, `[x] ` at the start of a paragraph makes a task item. Inside a
  // list item Milkdown's own rule already does it.
  if (text === ' ' && sel.empty && !itemAt(state)) {
    const parent = sel.$from.parent;
    if (!parent.isTextblock || parent.type.name !== 'paragraph') return false;
    const before = parent.textBetween(0, sel.$from.parentOffset, undefined, '￼');
    const m = TASK_START.exec(before);
    if (!m) return false;
    const start = sel.$from.pos - before.length;
    v.dispatch(state.tr.delete(start, sel.$from.pos));
    wrapInto(ctx, listItemSchema.type, { checked: m[1].toLowerCase() === 'x' }, true);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// the plugin

const KEY = new PluginKey('os-editor-commands');

export function plugins(ctx) {
  return [new Plugin({
    key: KEY,
    props: {
      handleKeyDown: (v, event) => handleKeyDown(ctx, v, event),
      handleTextInput: (v, from, to, text) => handleTextInput(ctx, v, from, to, text),
      // S8: what a copy puts on `text/plain` is the selection's markdown, through the same
      // clean-up a save uses, so pasting into a terminal or another editor keeps the markers.
      clipboardTextSerializer: (slice) => sliceMarkdown(ctx, slice),
    },
    view: (v) => {
      const off = toolingKeys(v);
      return { destroy: off };
    },
  })];
}
