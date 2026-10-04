// The formatting bar: one row of buttons over a Rich page, always there, the way a word
// processor has one.
//
// It adds no action of its own. Every button runs a command the editor already registers
// (commands.ts), so a button, a chord, the palette and the slash menu can never mean different
// things, and the keyboard needs none of this: the buttons are for the mouse, are out of the Tab
// order, and never take the focus from the text (a press is kept from the browser, the command
// puts the caret back). A button is lit when what it gives is what the caret is in.
//
// The bar is not in the page column: it is the column's elder sibling in the page's host, stuck
// to the top of the scroller, so it is not on the sheet (sheets.css) and not on paper (print.css).

import { commands } from './host.ts';
import { I } from './slash.ts';

type View = import('@milkdown/kit/prose/view').EditorView;

const letter = (ch: string, cls: string) => `<span class="ed-bar-l ${cls}" aria-hidden="true">${ch}</span>`;

// Inline code is the slash menu's `<>`; a block of it is the same mark in a frame.
const CODE_BLOCK = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5"/><path d="m6.75 6-2 2 2 2M9.25 6l2 2-2 2"/></svg>';

/** The buttons, left to right; `null` is the gap between two groups. */
const ITEMS: Array<{ cmd: string, title: string, glyph: string, on: string } | null> = [
  { cmd: 'block.paragraph', title: 'Paragraph', glyph: I.text, on: 'paragraph' },
  { cmd: 'block.h1', title: 'Heading 1', glyph: I.h1, on: 'h1' },
  { cmd: 'block.h2', title: 'Heading 2', glyph: I.h2, on: 'h2' },
  { cmd: 'block.h3', title: 'Heading 3', glyph: I.h3, on: 'h3' },
  null,
  { cmd: 'format.bold', title: 'Bold', glyph: letter('B', 'b'), on: 'strong' },
  { cmd: 'format.italic', title: 'Italic', glyph: letter('I', 'i'), on: 'emphasis' },
  { cmd: 'format.strike', title: 'Strikethrough', glyph: letter('S', 's'), on: 'strike_through' },
  { cmd: 'format.code', title: 'Inline code', glyph: I.code, on: 'inlineCode' },
  { cmd: 'format.link', title: 'Link', glyph: I.link, on: 'link' },
  null,
  { cmd: 'block.bullet', title: 'Bullet list', glyph: I.ul, on: 'bullet' },
  { cmd: 'block.numbered', title: 'Numbered list', glyph: I.ol, on: 'ordered' },
  { cmd: 'block.task', title: 'Task list', glyph: I.todo, on: 'task' },
  null,
  { cmd: 'block.quote', title: 'Quote', glyph: I.quote, on: 'quote' },
  { cmd: 'block.table', title: 'Table', glyph: I.table, on: 'table' },
  { cmd: 'block.code', title: 'Code block', glyph: CODE_BLOCK, on: 'code' },
  { cmd: 'block.divider', title: 'Divider', glyph: I.hr, on: '' },
];

const MARKS = ['strong', 'emphasis', 'strike_through', 'inlineCode', 'link'];

/** What the caret is in, as the `on` names above. */
export function activeAt(state: import('@milkdown/kit/prose/state').EditorState): Set<string> {
  const on = new Set<string>();
  const { $from, from, to, empty } = state.selection;

  for (const name of MARKS) {
    const type = state.schema.marks[name];
    if (!type) continue;
    const has = empty
      ? !!type.isInSet(state.storedMarks || $from.marks())
      : state.doc.rangeHasMark(from, to, type);
    if (has) on.add(name);
  }

  const block = $from.parent;
  if (block.type.name === 'heading') on.add(`h${block.attrs.level}`);
  else if (block.type.spec.code) on.add('code');

  let listed = false;
  let plain = block.type.name === 'paragraph';
  for (let d = $from.depth - 1; d > 0; d--) {
    const node = $from.node(d);
    const name = node.type.name;
    if (name === 'list_item' && !listed) {
      listed = true;
      plain = false;
      if (node.attrs.checked != null) on.add('task');
      else on.add($from.node(d - 1).type.name === 'ordered_list' ? 'ordered' : 'bullet');
    } else if (name === 'blockquote') { on.add('quote'); plain = false; }
    else if (name === 'table') { on.add('table'); plain = false; }
    else if (node.type.spec.code) { on.add('code'); plain = false; }
  }
  if (plain) on.add('paragraph');
  return on;
}

/**
 * The bar for one mounted Rich page. `getView` answers the page's editor view, or null while
 * there is none. The caller puts `el` in the document and calls `destroy` when the body goes.
 */
export function createBar(getView: () => View | null) {
  const el = document.createElement('div');
  el.className = 'ed-bar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', 'Formatting');
  const row = document.createElement('div');
  row.className = 'ed-bar-row';
  el.append(row);

  const buttons: Array<{ b: HTMLButtonElement, on: string }> = [];
  for (const item of ITEMS) {
    if (!item) {
      const gap = document.createElement('span');
      gap.className = 'ed-bar-gap';
      row.append(gap);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ed-bar-b';
    b.tabIndex = -1;
    b.title = item.title;
    b.setAttribute('aria-label', item.title);
    b.innerHTML = item.glyph;
    b.addEventListener('click', () => {
      const view = getView();
      if (!view) return;
      // The command acts on the page the caret is in: this one, whatever was focused before.
      if (!view.hasFocus()) view.focus();
      commands.run(item.cmd);
      paint();
    });
    row.append(b);
    buttons.push({ b, on: item.on });
  }
  // A press on the bar is not a press on the page: the selection stays where it is.
  el.addEventListener('mousedown', (e) => e.preventDefault());

  let frame = 0;
  function paint() {
    frame = 0;
    const view = getView();
    const on = view ? activeAt(view.state) : new Set<string>();
    for (const { b, on: name } of buttons) {
      const lit = !!name && on.has(name);
      b.classList.toggle('on', lit);
      if (name) b.setAttribute('aria-pressed', String(lit));
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
  // The caret moving and the text changing both show as one of these two, and neither is
  // dispatched inside a transaction, so the view's state is settled when the frame runs.
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('input', schedule, true);
  schedule();

  return {
    el,
    destroy() {
      document.removeEventListener('selectionchange', schedule);
      document.removeEventListener('input', schedule, true);
      if (frame) cancelAnimationFrame(frame);
      el.remove();
    },
  };
}
