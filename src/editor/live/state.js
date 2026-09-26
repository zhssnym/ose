// The state Live holds, and the pure functions over it.
//
// The file text is the only truth. CodeMirror keeps the text of each line and joins lines
// with `\n`; the two things it cannot hold, a byte-order mark and the separator each line had
// (`\r\n`, `\r`, `\n`), live in one state field, `liveFormat`, in the shape `textFormat` of
// source.js gives them. `liveText(state)` is `applyFormat(doc.toString(), format)`, the tested
// helper of source.js, and it is the only thing a save ever writes. There is no serializer and
// no model: the decorations only draw, so a widget bug is a display glitch, never a byte.
//
// The field follows the document. A file loaded or replaced from outside (`setFormat`) takes
// its shape from that text; an edit replaces the text of the lines it touched and gives the
// separators *between* them the file's usual ending, and every other line keeps its own text
// and its own separator. So `applyFormat` always finds every line equal and puts each line's
// own separator back, however many edits came before, which a format frozen at load time
// could not do for a file with mixed endings (the head/tail rule of `applyFormat` would have
// re-ended every line between two edits). A file with no mark and nothing but `\n` is `plain`
// and stays so: its field is never touched.

import { EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { applyFormat, textFormat } from '../source.js';
import { liveLanguage } from './syntax.js';
import { collect } from './registry.js';
import { focusField, setFocused, revealedSpans, revealer } from './reveal.js';
import { buildInline } from './inline.js';
import { buildBlocks } from './blocks.js';

/** @typedef {ReturnType<typeof textFormat>} TextFormat */

/** @type {import('@codemirror/state').StateEffectType<TextFormat>} */
export const setFormat = StateEffect.define();

/**
 * The format after `tr`: the lines it touched get their new text, the separators inside the
 * touched run get `eol`, and the separator after the run is the one that was there.
 * @param {TextFormat} fmt
 * @param {import('@codemirror/state').Transaction} tr
 * @returns {TextFormat}
 */
function mapFormat(fmt, tr) {
  if (fmt.plain || !tr.docChanged) return fmt;
  const oldDoc = tr.startState.doc;
  const newDoc = tr.newDoc;
  /** @type {[number, number, number, number][]} */
  const runs = [];
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => { runs.push([fromA, toA, fromB, toB]); });
  const lines = fmt.lines.slice();
  const seps = fmt.seps.slice();
  // From the last run to the first, so the indices of the runs still to do stay valid.
  for (let i = runs.length - 1; i >= 0; i--) {
    const [fromA, toA, fromB, toB] = /** @type {[number, number, number, number]} */ (runs[i]);
    const a0 = oldDoc.lineAt(fromA).number - 1;
    const a1 = oldDoc.lineAt(toA).number - 1;
    const b0 = newDoc.lineAt(fromB).number - 1;
    const b1 = newDoc.lineAt(toB).number - 1;
    /** @type {string[]} */
    const text = [];
    for (let n = b0; n <= b1; n++) text.push(newDoc.line(n + 1).text);
    lines.splice(a0, a1 - a0 + 1, ...text);
    seps.splice(a0, a1 - a0, ...new Array(b1 - b0).fill(fmt.eol));
  }
  return { ...fmt, lines, seps };
}

/** The file's own shape: its mark and each line's separator. */
export const liveFormat = StateField.define({
  create: (state) => textFormat(state.doc.toString()),
  update(fmt, tr) {
    for (const e of tr.effects) if (e.is(setFormat)) return e.value;
    return mapFormat(fmt, tr);
  },
});

/**
 * What CodeMirror holds for a file text: its lines joined by `\n`, with no mark.
 * @param {TextFormat} fmt
 */
export const docOf = (fmt) => fmt.lines.join('\n');

/**
 * The bytes of `state`: what a save writes.
 * @param {EditorState} state
 */
export function liveText(state) {
  return applyFormat(state.doc.toString(), state.field(liveFormat, false) || null);
}

/**
 * The extensions every Live state carries, view or no view: the format, the language and the
 * focus field. The view adds the rest (view.js).
 * @param {TextFormat} fmt
 * @param {import('./registry.js').Collected} collected
 */
export function coreExtensions(fmt, collected) {
  return [liveFormat.init(() => fmt), liveLanguage(collected), focusField];
}

/**
 * Pure, no view: the state Live would hold for `text`.
 * @param {string} text
 * @param {{ path?: string, focused?: boolean, selection?: { from?: number, to?: number, anchor?: number, head?: number },
 *   widgets?: readonly import('./registry.js').LiveWidget[] }} [o]
 * @returns {EditorState}
 */
export function liveState(text, o = {}) {
  const fmt = textFormat(text);
  const doc = docOf(fmt);
  const collected = collect(o.widgets || []);
  const s = o.selection;
  let selection;
  if (s) {
    const anchor = clamp(s.anchor ?? s.from ?? 0, doc.length);
    const head = clamp(s.head ?? s.to ?? anchor, doc.length);
    selection = EditorSelection.single(anchor, head);
  }
  const state = EditorState.create({ doc, selection, extensions: coreExtensions(fmt, collected) });
  return o.focused ? state.update({ effects: setFocused.of(true) }).state : state;
}

/** @param {number} n @param {number} max */
const clamp = (n, max) => Math.max(0, Math.min(max, Math.floor(Number(n) || 0)));

/**
 * Every decoration Live would draw for `state`, inline ones over the whole document here (the
 * view builds those over the visible ranges only). For the property tests: it never throws on
 * a widget, and never changes `state`.
 * @param {EditorState} state
 * @param {{ selection?: any, focused?: boolean, widgets?: readonly import('./registry.js').LiveWidget[], path?: string }} [o]
 */
export function liveDecorations(state, o = {}) {
  ensureSyntaxTree(state, state.doc.length, 5000);
  const collected = collect(o.widgets || []);
  const spans = revealedSpans(state, { selection: o.selection, focused: !!o.focused });
  const env = pureEnv(collected, revealer(spans), o.path || '');
  return {
    inline: buildInline(state, [{ from: 0, to: state.doc.length }], env),
    block: buildBlocks(state, env),
  };
}

/**
 * The environment the builders read, with no view behind it: nothing resolves, nothing opens.
 * @param {import('./registry.js').Collected} collected
 * @param {(from: number, to: number) => boolean} revealed
 * @param {string} path
 * @returns {import('./inline.js').Env}
 */
function pureEnv(collected, revealed, path) {
  return {
    collected, revealed, path,
    resolveAsset: () => null,
    resolveWikilink: null,
    openLink: () => {},
    inlineHtml: (md) => md,
    toggleTask: () => false,
    openFrontmatter: () => {},
  };
}

// ---------------------------------------------------------------------------
// tasks

/**
 * The `[ ]` / `[x]` marker of a task whose marker holds `pos` (either edge counts), as
 * `{ from, to, done }`; null when there is none. Read from the syntax tree, so a `- [ ]` inside
 * a fenced code block is not a task.
 * @param {EditorState} state
 * @param {number} pos
 */
export function taskMarkerAt(state, pos) {
  if (pos < 0 || pos > state.doc.length) return null;
  const line = state.doc.lineAt(pos);
  const tree = ensureSyntaxTree(state, line.to, 200) || syntaxTree(state);
  /** @type {{ from: number, to: number, done: boolean }[]} */
  const found = [];
  tree.iterate({
    from: line.from, to: line.to,
    enter(n) {
      if (found.length) return false;
      if (n.name !== 'TaskMarker') return undefined;
      if (n.from <= pos && pos <= n.to) {
        const c = state.doc.sliceString(n.from + 1, n.from + 2);
        found.push({ from: n.from, to: n.to, done: c === 'x' || c === 'X' });
      }
      return false;
    },
  });
  return found[0] || null;
}

/**
 * The first task marker on the line that holds `pos`, or null.
 * @param {EditorState} state
 * @param {number} pos
 */
export function taskMarkerOnLine(state, pos) {
  const line = state.doc.lineAt(pos);
  const m = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(\[[ xX]\])/.exec(line.text);
  if (!m) return null;
  const at = line.from + /** @type {number} */ (m.index) + m[0].length - 3;
  return taskMarkerAt(state, at);
}

/**
 * The one-character change that toggles the task whose `[ ]` / `[x]` holds `pos`, or null.
 * `[ ]` becomes `[x]` and `[x]` or `[X]` becomes `[ ]`: one character replaced by one.
 * @param {EditorState} state
 * @param {number} pos
 * @returns {import('@codemirror/state').TransactionSpec | null}
 */
export function toggleTaskAt(state, pos) {
  const m = taskMarkerAt(state, pos);
  if (!m) return null;
  return {
    changes: { from: m.from + 1, to: m.from + 2, insert: m.done ? ' ' : 'x' },
    userEvent: 'input.live.task',
  };
}
