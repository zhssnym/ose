// What the format.* and block.* commands mean in Live, and the keymap that runs them.
//
// Every command is a text edit on the markdown itself: Ctrl+B writes `**` on both sides of the
// selection, Ctrl+2 writes `## ` at the start of the line. Nothing is converted and nothing is
// re-serialised; the characters typed are the characters saved. Each command is one
// transaction with a user event under `input.live.*`, so one Ctrl+Z takes it back.
//
// The chords are the body chords of the rest of the app: the table is `BODY_KEYS`, kept in
// `src/core/keys.ts` for the palette's hints and mirrored for the editor in `../keymap.ts`,
// which this file reads, so a chord means the same thing in Rich and in Live. Only the ids Live
// implements are bound here; the others fall through to CodeMirror or to the window.

import { ChangeSet, EditorSelection, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { copyLineDown, moveLineDown, moveLineUp } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import { completionStatus } from '@codemirror/autocomplete';
import { BODY_KEYS, comboFor, combosOf } from '../keymap.ts';
import { taskMarkerOnLine } from './state.ts';

/** The commands Live answers (contract §4.2): the required ones, then the optional ones. */
export const LIVE_COMMANDS = Object.freeze([
  'format.bold', 'format.italic', 'format.strike', 'format.code', 'format.link',
  'block.paragraph', 'block.h1', 'block.h2', 'block.h3', 'block.h4', 'block.h5', 'block.h6',
  'block.bullet', 'block.numbered', 'block.task', 'block.quote', 'block.toggle-task',
  'page.follow-link',
  'block.move-up', 'block.move-down', 'block.duplicate', 'block.delete', 'block.code',
]);

const LIVE_SET = new Set(LIVE_COMMANDS);

/** The inline marks, the characters Live writes for them, and the node they parse to. */
const WRAPS = {
  'format.bold': { mark: '**', node: 'StrongEmphasis', part: 'EmphasisMark' },
  'format.italic': { mark: '_', node: 'Emphasis', part: 'EmphasisMark' },
  'format.strike': { mark: '~~', node: 'Strikethrough', part: 'StrikethroughMark' },
  'format.code': { mark: '`', node: 'InlineCode', part: 'CodeMark' },
};

export type EditorView = import('@codemirror/view').EditorView;
export type EditorState = import('@codemirror/state').EditorState;

/**
 * Dispatch a spec as a Live edit.
 */
function edit(view: EditorView, spec: import('@codemirror/state').TransactionSpec, event: string) {
  view.dispatch(view.state.update(spec, { scrollIntoView: true, userEvent: `input.live.${event}` }));
  return true;
}

/**
 * Run a stock CodeMirror command, but dispatch what it answers as a Live edit: the stock
 * commands tag their own transactions (`move.line`, `delete.line`), and every change Live makes
 * says it is Live's.
 */
function stock(view: EditorView, command: import('@codemirror/state').StateCommand, event: string) {
  if (view.state.readOnly) return false;
  return command({
    state: view.state,
    dispatch: (tr) => {
      view.dispatch(tr.startState.update({
        changes: tr.changes, selection: tr.selection, scrollIntoView: true, userEvent: `input.live.${event}`,
      }));
    },
  });
}

// ---------------------------------------------------------------------------
// inline marks

/**
 * The innermost node named `name` that holds [from, to], or null.
 */
function enclosing(state: EditorState, name: string, from: number, to: number) {
  for (const side of ([1, -1] as const)) {
    let n: import('@lezer/common').SyntaxNode | null = syntaxTree(state).resolveInner(from, side);
    for (; n; n = n.parent) {
      if (n.name === name && n.from <= from && n.to >= to) return n;
    }
  }
  return null;
}

/**
 * Wrap the selection in a mark, or take the mark away when it is already there.
 */
function toggleWrap(view: EditorView, w: { mark: string; node: string; part: string; }) {
  const { state } = view;
  const len = w.mark.length;
  const spec = state.changeByRange((range) => {
    const node = enclosing(state, w.node, range.from, range.to);
    if (node) {
      const parts = node.getChildren(w.part);
      const open = parts[0];
      const close = parts[parts.length - 1];
      if (open && close && open !== close) {
        const changes = state.changes([{ from: open.from, to: open.to }, { from: close.from, to: close.to }]);
        return { changes, range: range.map(changes) };
      }
    }
    const before = state.sliceDoc(range.from - len, range.from);
    const after = state.sliceDoc(range.to, range.to + len);
    if (!range.empty && before === w.mark && after === w.mark) {
      return {
        changes: [{ from: range.from - len, to: range.from }, { from: range.to, to: range.to + len }],
        range: EditorSelection.range(range.from - len, range.to - len),
      };
    }
    return {
      changes: [{ from: range.from, insert: w.mark }, { from: range.to, insert: w.mark }],
      range: EditorSelection.range(range.from + len, range.to + len),
    };
  });
  return edit(view, spec, 'format');
}

/** A URL as a person pastes one. */
const looksLikeUrl = (s: string) => /^(?:https?:\/\/|mailto:|www\.)\S+$/i.test(s.trim());

/**
 * `[text](url)` around the selection: the caret lands where the missing half goes.
 * On a link already, the URL is selected.
 */
function insertLink(view: EditorView) {
  const { state } = view;
  const main = state.selection.main;
  const link = enclosing(state, 'Link', main.from, main.to);
  const url = link && link.getChild('URL');
  if (url) {
    view.dispatch({ selection: EditorSelection.range(url.from, url.to), scrollIntoView: true, userEvent: 'select.live.link' });
    return true;
  }
  const text = state.sliceDoc(main.from, main.to);
  if (text && looksLikeUrl(text) && !text.includes('\n')) {
    return edit(view, {
      changes: { from: main.from, to: main.to, insert: `[](${text.trim()})` },
      selection: { anchor: main.from + 1 },
    }, 'link');
  }
  const insert = `[${text}]()`;
  return edit(view, {
    changes: { from: main.from, to: main.to, insert },
    selection: text ? { anchor: main.from + insert.length - 1 } : { anchor: main.from + 1 },
  }, 'link');
}

// ---------------------------------------------------------------------------
// line prefixes

/** A line's leading markup: indent, quote markers, the space after them, the block marker. */
const PREFIX = /^([ \t]*)((?:>[ \t]?)*)([ \t]*)(#{1,6}[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+)?/;

/**
 * The lines a selection covers: a range that ends at the very start of a line does not take
 * that line in, as in every editor.
 */
function selectedLines(state: EditorState) {
  const seen: Map<number, import('@codemirror/state').Line> = new Map();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    let last = state.doc.lineAt(r.to).number;
    if (!r.empty && last > first && state.doc.line(last).from === r.to) last--;
    for (let n = first; n <= last; n++) if (!seen.has(n)) seen.set(n, state.doc.line(n));
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

function prefixOf(line: import('@codemirror/state').Line) {
  const m = (PREFIX.exec(line.text) as RegExpExecArray);
  const indent = m[1] || '';
  const quotes = m[2] || '';
  const space = m[3] || '';
  const block = m[4] || '';
  const at = line.from + indent.length + quotes.length + space.length;
  return { indent, quotes, block, at, end: at + block.length };
}

const isHeading = (b: string,n: number) => new RegExp(`^#{${n}}[ \\t]+$`).test(b);
const isTask = (b: string) => /^[-*+][ \t]+\[[ xX]\]/.test(b);
const isBullet = (b: string) => /^[-*+][ \t]+$/.test(b);
const isNumbered = (b: string) => /^\d{1,9}[.)][ \t]+$/.test(b);

/**
 * Set the block marker of every selected line. `kind` is `paragraph`, `h1`…`h6`, `bullet`,
 * `numbered` or `task`. When every line already has that marker, it is taken away instead
 * (Ctrl+2 on a heading 2 gives a paragraph back). Blank lines in a longer selection are left.
 */
function setBlock(view: EditorView, kind: string) {
  const { state } = view;
  const lines = selectedLines(state);
  const work = lines.length > 1 ? lines.filter((l) => l.text.trim() !== '') : lines;
  if (!work.length) return false;
  const level = /^h([1-6])$/.exec(kind);
  const has = (b: string) => (level ? isHeading(b, Number(level[1])) : kind === 'bullet' ? isBullet(b)
    : kind === 'numbered' ? isNumbered(b) : kind === 'task' ? isTask(b) : b === '');
  const off = kind !== 'paragraph' && work.every((l) => has(prefixOf(l).block));
  let n = 0;
  const changes = work.map((l) => {
    const p = prefixOf(l);
    let insert = '';
    if (!off) {
      if (level) insert = `${'#'.repeat(Number(level[1]))} `;
      else if (kind === 'bullet') insert = '- ';
      else if (kind === 'task') insert = '- [ ] ';
      else if (kind === 'numbered') insert = `${++n}. `;
    }
    return { from: p.at, to: p.end, insert };
  }).filter((c) => state.sliceDoc(c.from, c.to) !== c.insert);
  if (!changes.length) return true;
  return edit(view, { changes }, 'block');
}

/**
 * `> ` in front of every selected line, or one level of it taken away when every line that
 * has text is already quoted.
 */
function toggleQuote(view: EditorView) {
  const { state } = view;
  const lines = selectedLines(state);
  const work = lines.length > 1 ? lines.filter((l) => l.text.trim() !== '') : lines;
  if (!work.length) return false;
  const off = work.every((l) => /^[ \t]*>/.test(l.text));
  const changes = work.map((l) => {
    if (!off) return { from: l.from, insert: '> ' };
    const m = (/^([ \t]*)>[ \t]?/.exec(l.text) as RegExpExecArray);
    return { from: l.from + (m[1] || '').length, to: l.from + m[0].length, insert: '' };
  });
  return edit(view, { changes }, 'block');
}

/**
 * Tick or untick the task of every selected line: one character each. False when no selected
 * line is a task, so Ctrl+Enter falls through to its CodeMirror meaning.
 */
function toggleTasks(view: EditorView) {
  const { state } = view;
  const changes: any[] = [];
  for (const l of selectedLines(state)) {
    const m = taskMarkerOnLine(state, l.from);
    if (!m) continue;
    changes.push({ from: m.from + 1, to: m.from + 2, insert: m.done ? ' ' : 'x' });
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: 'input.live.task' });
  return true;
}

/**
 * The selected lines inside a fenced code block, or an empty fence with the caret in it.
 */
function codeBlock(view: EditorView) {
  const { state } = view;
  const lines = selectedLines(state);
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) return false;
  if (lines.length === 1 && first.text.trim() === '') {
    return edit(view, { changes: { from: first.from, to: first.to, insert: '```\n\n```' }, selection: { anchor: first.from + 4 } }, 'block');
  }
  return edit(view, {
    changes: [{ from: first.from, insert: '```\n' }, { from: last.to, insert: '\n```' }],
  }, 'block');
}

/**
 * The selected lines taken out whole, separators and all; the caret lands at the start of the
 * line that moved up into their place.
 */
function deleteLines(view: EditorView) {
  const { state } = view;
  const lines = selectedLines(state);
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) return false;
  const len = state.doc.length;
  const from = last.to < len ? first.from : Math.max(0, first.from - 1);
  const to = last.to < len ? last.to + 1 : last.to;
  if (to <= from) return false;
  return edit(view, { changes: { from, to }, selection: { anchor: Math.min(from, len - (to - from)) } }, 'delete');
}

// ---------------------------------------------------------------------------
// Enter and Backspace in lists and quotes

/**
 * lang-markdown's Enter, told never to turn a tight list loose: on an empty item it takes one
 * level of markup away instead of moving the item down behind a blank line.
 */
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** A line that holds nothing but quote markers (and the spaces around them). */
const EMPTY_QUOTE = /^([ \t]*(?:>[ \t]?)+)[ \t]*$/;
/** A line that holds nothing but its container's markers: blank, in a quote or at the top. */
const CONTAINER_BLANK = /^[ \t]*(?:>[ \t]?)*[ \t]*$/;

function inBlockquote(state: EditorState, pos: number) {
  for (const side of ([1, -1] as const)) {
    let n: import('@lezer/common').SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    for (; n; n = n.parent) if (n.name === 'Blockquote') return true;
  }
  return false;
}

/**
 * Enter on the empty last line of a quote (a callout too) leaves the quote, with exactly one
 * blank line between the quote and the new line. One level only: in `> > ` the inner quote
 * is left and the caret stays in the outer one. Null when the line is not that.
 */
function leaveQuote(state: EditorState): import('@codemirror/state').TransactionSpec | null {
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const m = EMPTY_QUOTE.exec(line.text);
  if (!m || pos !== line.to || !inBlockquote(state, line.from)) return null;
  // Inside the quote, an empty `>` line is a paragraph break the quote keeps.
  if (line.number < state.doc.lines && /^[ \t]*>/.test(state.doc.line(line.number + 1).text)) return null;
  const prefix = m[1] || '';
  const depth = (prefix.match(/>/g) || []).length;
  const outer = depth > 1 ? `${prefix.replace(/>[ \t]*$/, '').trimEnd()} ` : '';
  const prev = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const prevEmptyQuote = prev && EMPTY_QUOTE.test(prev.text)
    && ((EMPTY_QUOTE.exec(prev.text)?.[1] || '').match(/>/g) || []).length === depth;
  if (prev && prevEmptyQuote) {
    // `>` then `> `: the separator is there already, and it becomes the blank line.
    const changes = [{ from: prev.from, to: prev.to, insert: outer.trimEnd() }, { from: line.from, to: line.to, insert: outer }];
    const set = state.changes(changes);
    return { changes: set, selection: { anchor: set.mapPos(line.to, 1) } };
  }
  const blankBefore = !prev || (CONTAINER_BLANK.test(prev.text) && (outer ? /^[ \t]*>/.test(prev.text) : !/\S/.test(prev.text)));
  const insert = blankBefore ? outer : `${outer.trimEnd()}\n${outer}`;
  return { changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length } };
}

/**
 * Enter, Live's way (CLAUDE.md: one blank line separates two blocks, and that is what Enter
 * twice leaves):
 *   - on a line in a list or quote, the markup goes on to the new line, as lang-markdown does;
 *   - on an empty item, one level of markup is taken away; when that leaves the line empty in
 *     its container (the list is left, not a nested level), a blank line is put between the
 *     list and the new line, so what is typed next is a paragraph of its own and not a lazy
 *     continuation of the last item, which Reading and Rich would draw inside it;
 *   - on the empty last line of a quote or callout, the quote is left the same way.
 * One transaction, `input.live.newline`. False (plain Enter) outside lists and quotes.
 */
export function liveEnter(view: EditorView) {
  const { state } = view;
  if (state.readOnly || completionStatus(state) === 'active') return false;
  const single = state.selection.ranges.length === 1 && state.selection.main.empty;
  if (single) {
    const quote = leaveQuote(state);
    if (quote) return edit(view, quote, 'newline');
  }
  let got: import('@codemirror/state').Transaction | null = null;
  if (!continueMarkup({ state, dispatch: (tr) => { got = tr; } }) || !got) return false;
  const tr: import('@codemirror/state').Transaction = got;
  let changes = tr.changes;
  let selection = tr.selection || state.selection;
  if (single && tr.newDoc.lines === state.doc.lines) {
    // No line was added: markup was taken off an empty item. Is the line now empty?
    const doc = tr.newDoc;
    const head = selection.main.head;
    const line = doc.lineAt(head);
    const prev = line.number > 1 ? doc.line(line.number - 1) : null;
    if (CONTAINER_BLANK.test(line.text) && prev && !CONTAINER_BLANK.test(prev.text)) {
      const keep = line.text.trimEnd();
      const insert = `${keep}\n${keep ? `${keep} ` : ''}`;
      const more = ChangeSet.of([{ from: line.from, to: line.to, insert }], doc.length);
      changes = changes.compose(more);
      selection = EditorSelection.single(line.from + insert.length);
    }
  }
  view.dispatch({ changes, selection, scrollIntoView: true, userEvent: 'input.live.newline' });
  return true;
}

/**
 * Backspace just after list or quote markup takes one level of it away (lang-markdown's
 * command), as a Live edit.
 */
export function liveBackspace(view: EditorView) {
  return stock(view, deleteMarkupBackward, 'delete');
}

// ---------------------------------------------------------------------------
// the entry points

/**
 * Run a Live command on `view`. `page.follow-link` is the view's (it needs `onOpenLink`), so
 * it answers false here. False also means "not applicable here": a read-only page, no task
 * under the caret.
 */
export function runCommand(view: EditorView, id: string): boolean {
  if (!LIVE_SET.has(id) || view.state.readOnly) return false;
  const wrap = WRAPS[(id as keyof typeof WRAPS)];
  if (wrap) return toggleWrap(view, wrap);
  switch (id) {
    case 'format.link': return insertLink(view);
    case 'block.paragraph': return setBlock(view, 'paragraph');
    case 'block.h1': case 'block.h2': case 'block.h3': case 'block.h4': case 'block.h5': case 'block.h6':
      return setBlock(view, id.slice(6));
    case 'block.bullet': return setBlock(view, 'bullet');
    case 'block.numbered': return setBlock(view, 'numbered');
    case 'block.task': return setBlock(view, 'task');
    case 'block.quote': return toggleQuote(view);
    case 'block.toggle-task': return toggleTasks(view);
    case 'block.code': return codeBlock(view);
    case 'block.move-up': return stock(view, moveLineUp, 'move');
    case 'block.move-down': return stock(view, moveLineDown, 'move');
    case 'block.duplicate': return stock(view, copyLineDown, 'duplicate');
    case 'block.delete': return deleteLines(view);
    default: return false;
  }
}

/**
 * The Live keymap: the body chords of `BODY_KEYS` for the ids Live implements, matched the way
 * the rest of the app matches them (`combosOf`: Ctrl+1 reaches Heading 1 on an AZERTY row).
 * A command that answers false lets the key go on to CodeMirror.
 */
export function liveKeymap(run: (id: string) => boolean) {
  let byCombo: Map<string, string> | null = null;
  const combos = () => {
    if (byCombo) return byCombo;
    byCombo = new Map();
    for (const k of BODY_KEYS) if (!k.hintOnly && LIVE_SET.has(k.cmd)) byCombo.set(comboFor(k), k.cmd);
    return byCombo;
  };
  return Prec.high(keymap.of([
    // lang-markdown's own keymap is off (syntax.ts): these two are its commands, as Live edits.
    { key: 'Enter', run: liveEnter },
    { key: 'Backspace', run: liveBackspace },
    {
      any(_view, event) {
        if (event.type !== 'keydown' || event.isComposing) return false;
        const map = combos();
        for (const combo of combosOf(event)) {
          const id = map.get(combo);
          if (!id) continue;
          if (run(id)) { event.preventDefault(); return true; }
          return false;
        }
        return false;
      },
    },
  ]));
}
