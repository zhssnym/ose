// The block field rebuilds by region (src/editor/live/blocks.js). Whatever the edits and the
// caret moves, what it holds must be exactly what a whole rebuild would draw.
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { Decoration, WidgetType } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { coreExtensions, docOf } from '../../../src/editor/live/state.js';
import { blockField, buildBlocks } from '../../../src/editor/live/blocks.js';
import { revealedSpans, revealer, setFocused } from '../../../src/editor/live/reveal.js';
import { collect } from '../../../src/editor/live/registry.js';
import { textFormat } from '../../../src/editor/source.js';

class Box extends WidgetType {
  /** @param {string} text */
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() { return document.createElement('div'); }
}

/** A block widget over tables, one replace of its lines: enough to see regions rebuilt. */
const tableWidget = {
  id: 'table-test', kind: 'block', nodes: ['Table'],
  decorate(ctx, node, out) {
    const doc = ctx.state.doc;
    const from = doc.lineAt(node.from).from;
    const to = doc.lineAt(node.to).to;
    out.add(from, to, Decoration.replace({ block: true, widget: new Box(doc.sliceString(from, to)) }));
  },
};

const collected = collect([tableWidget]);
const base = {
  collected, path: 'a.md', resolveAsset: () => null, resolveWikilink: null, openLink: () => {},
  inlineHtml: (s) => s, toggleTask: () => false, openFrontmatter: () => {},
};
const field = blockField(base);

function dump(set, state) {
  const out = [];
  set.between(0, state.doc.length, (f, t, v) => {
    const w = v.spec.widget;
    out.push(`${f}-${t}:${w ? `${w.constructor.name}${w.text !== undefined ? `=${w.text}` : ''}` : ''}`);
  });
  return out.sort().join(' | ');
}

const full = (state) => buildBlocks(state, { ...base, revealed: revealer(revealedSpans(state)) });

/** A seeded generator, so a failure replays. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const DOC = [
  '---', 'title: T', 'tags: [a]', '---', '# Title', '',
  'Para one with text.', '',
  '| a | b |', '|---|---|', '| 1 | 2 |', '',
  '- item', '- item two', '',
  '| c | d |', '|---|---|', '| 3 | 4 |', '',
  '```', 'code', '```', '',
  'Last paragraph.', '',
].join('\n');

const PIECES = ['x', '\n', '\n\n', '| e |', '---', '```', '|---|---|', '- ', '# ', '', '| f | g |\n|---|---|\n| 5 | 6 |\n'];

function create(text) {
  const fmt = textFormat(text);
  return EditorState.create({ doc: docOf(fmt), extensions: [coreExtensions(fmt, collected), field] });
}

describe('the block field by region', () => {
  const seed = Number(process.env.OSE_FUZZ_SEED) || 20260926;

  it('matches a whole rebuild after every edit and caret move', () => {
    const next = rng(seed);
    let state = create(DOC);
    state = state.update({ effects: setFocused.of(true) }).state;
    for (let step = 0; step < 400; step++) {
      const len = state.doc.length;
      const r = next();
      let spec;
      if (r < 0.45) {
        const from = Math.floor(next() * (len + 1));
        const to = Math.min(len, from + Math.floor(next() * 6));
        spec = { changes: { from, to, insert: PIECES[Math.floor(next() * PIECES.length)] }, userEvent: 'input' };
      } else if (r < 0.9) {
        const a = Math.floor(next() * (len + 1));
        spec = { selection: { anchor: a, head: next() < 0.3 ? Math.floor(next() * (len + 1)) : a } };
      } else {
        spec = { effects: setFocused.of(next() < 0.5) };
      }
      state = state.update(spec).state;
      ensureSyntaxTree(state, state.doc.length, 1000);
      // A tree that grew after the fact arrives in a transaction of its own in a view; here the
      // empty update stands in for it.
      state = state.update({}).state;
      expect(dump(state.field(field).deco, state), `step ${step} (seed ${seed})`).toBe(dump(full(state), state));
    }
  });

  it('a caret moving along its line keeps the same value', () => {
    let state = create(DOC).update({ effects: setFocused.of(true), selection: { anchor: 5 } }).state;
    const v1 = state.field(field);
    state = state.update({ selection: { anchor: 7 } }).state;
    expect(state.field(field)).toBe(v1);
  });

  it('folds the frontmatter and draws the tables off the caret', () => {
    const state = create(DOC);
    const d = dump(state.field(field).deco, state);
    expect(d.match(/PropertiesWidget/g)?.length).toBe(1);
    expect(d.match(/Box=/g)?.length).toBe(2);
  });
});
