// @vitest-environment happy-dom
// The widgets through the core's own entry (live/index.js): every widget draws off the caret,
// nothing draws where the caret reveals it, and nothing changes the document.

import './dom-shim.js';
import { describe, expect, it } from 'vitest';
import { liveDecorations, liveState, liveText } from '../../../src/editor/live/index.ts';

const DOC = [
  '# Title',
  '',
  'Inline $x^2$ and ![a](x.png) here.',
  '',
  '![[pic.png|200]]',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '$$',
  '\\frac{1}{2}',
  '$$',
  '',
  '```js',
  'let a = 1;',
  '```',
  '',
].join('\n');

/** The widget classes a decoration set draws, by name, with the line each starts on. */
function widgets(state, set) {
  const out = [];
  const iter = set.iter();
  while (iter.value) {
    const w = iter.value.spec.widget;
    if (w) out.push([w.constructor.name, state.doc.lineAt(iter.from).number]);
    iter.next();
  }
  return out;
}

describe('widgets through the core', () => {
  it('off the caret, each widget draws where it belongs', () => {
    const state = liveState(DOC, { path: 'p.md' });
    const { inline, block } = liveDecorations(state, { focused: false });
    const drawn = [...widgets(state, inline), ...widgets(state, block)];
    expect(drawn).toEqual(expect.arrayContaining([
      ['MathWidget', 3], ['ImageWidget', 3], ['ImageWidget', 5], ['TableWidget', 7], ['MathWidget', 11],
    ]));
    expect(liveText(state)).toBe(DOC);
  });

  it('the caret in the table shows it raw; in the formula, the formula', () => {
    const state = liveState(DOC, { path: 'p.md' });
    const inTable = state.doc.line(8).from + 1;
    const t = liveDecorations(state, { focused: true, selection: { anchor: inTable, head: inTable } });
    expect(widgets(state, t.block).some(([name]) => name === 'TableWidget')).toBe(false);
    const inMath = state.doc.line(12).from;
    const m = liveDecorations(state, { focused: true, selection: { anchor: inMath, head: inMath } });
    expect(widgets(state, m.block).some(([name, line]) => name === 'MathWidget' && line === 11)).toBe(false);
    expect(widgets(state, m.block).some(([name]) => name === 'TableWidget')).toBe(true);
    expect(liveText(state)).toBe(DOC);
  });
});
