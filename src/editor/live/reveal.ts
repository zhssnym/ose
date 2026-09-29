// Which ranges show their raw markup.
//
// The rule, all of it: a range is revealed while the editor has focus, or while its find panel
// is open, and some selection range touches one of its lines. The find panel counts as focus
// because it takes the focus while it selects: a match inside a drawn table, a hidden link URL
// or the folded frontmatter has to show raw, or the match (and what Replace would change) is
// invisible. A block construct (frontmatter, a table, block maths, a fenced code
// block, a callout) asks about its whole extent, so it is revealed whole as soon as one of its
// lines is. Unfocused, nothing is revealed and the page reads as a document.
//
// Because each selection range is widened to whole lines here, "touches its lines" is a plain
// overlap test on positions: [from, to] shares a line with a widened range exactly when the two
// overlap. So `revealed(from, to)` never looks a line up.
//
// Focus is state, not a DOM question, because the block decorations come from a StateField and
// have to be computable from a state alone (and the property tests have no DOM). CodeMirror
// adds the effect to its own focus transaction (`focusChangeEffect`); Live never dispatches
// for it.

import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { searchPanelOpen } from '@codemirror/search';

export const setFocused: import('@codemirror/state').StateEffectType<boolean> = StateEffect.define();

/** Whether the editor has focus, as far as the decorations are concerned. */
export const focusField = StateField.define({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) value = e.value;
    return value;
  },
});

/** The focus field and the hook that keeps it true to the DOM. */
export const focusTracking = [
  focusField,
  EditorView.focusChangeEffect.of((state, focusing) =>
    (state.field(focusField, false) === focusing ? null : setFocused.of(focusing))),
];

/**
 * Whether `state` reveals its selection: the editor has focus, or its find panel is open.
 */
export const revealing = (state: import('@codemirror/state').EditorState) => state.field(focusField, false) === true || searchPanelOpen(state);

export type Span = { from: number, to: number };
export type RevealInput = { selection?: EditorSelection | Span | Span[] | null, focused?: boolean };

/**
 * The selection ranges of `input` (or of the state), each widened to whole lines, sorted.
 * Empty when not focused and no find panel is open: then nothing is revealed.
 */
export function revealedSpans(state: import('@codemirror/state').EditorState, input?: RevealInput): Span[] {
  const focused = input && typeof input.focused === 'boolean' ? input.focused : revealing(state);
  if (!focused) return [];
  let ranges;
  const sel = input && input.selection;
  if (!sel) ranges = state.selection.ranges;
  else if (sel instanceof EditorSelection) ranges = sel.ranges;
  else ranges = Array.isArray(sel) ? sel : [sel];
  const len = state.doc.length;
  const out: Span[] = [];
  for (const r of ranges) {
    // A caret may come as `{ from }` alone, or as `{ anchor, head }`.
    const any = (r as { from?: number, to?: number, anchor?: number, head?: number });
    const x = Number(any.from ?? any.anchor ?? 0) || 0;
    const y = Number(any.to ?? any.head ?? x) || 0;
    const a = Math.max(0, Math.min(len, Math.min(x, y)));
    const b = Math.max(0, Math.min(len, Math.max(x, y)));
    out.push({ from: state.doc.lineAt(a).from, to: state.doc.lineAt(b).to });
  }
  out.sort((x, y) => x.from - y.from);
  return out;
}

/**
 * `revealed(from, to)` for a set of widened spans.
 */
export function revealer(spans: Span[]): (from: number, to: number) => boolean {
  if (!spans.length) return () => false;
  return (from, to) => {
    for (const s of spans) {
      if (s.from > to) return false;           // sorted: nothing further can touch
      if (s.to >= from) return true;
    }
    return false;
  };
}

/**
 * A short key for the spans: two states with the same key reveal exactly the same ranges.
 * The block field compares it to skip a rebuild when the caret only moved along its line.
 */
export const spansKey = (spans: Span[]) => spans.map((s) => `${s.from}-${s.to}`).join(',');
