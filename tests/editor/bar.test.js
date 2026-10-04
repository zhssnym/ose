// The formatting bar (src/editor/bar.ts): which buttons are lit for where the caret is.

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from '@milkdown/kit/prose/state';

const { makeEngine } = await import('../../src/editor/engine.ts');
const { activeAt } = await import('../../src/editor/bar.ts');

const engine = await makeEngine();

/** What is lit with the caret (or a selection of `len`) at the first `needle` of `md`. */
function at(md, needle, len = 0) {
  const doc = engine.parse(md);
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text.includes(needle)) pos = p + node.text.indexOf(needle);
  });
  expect(pos).toBeGreaterThan(-1);
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, pos + 1, pos + 1 + len) });
  return [...activeAt(state)].sort();
}

describe('activeAt', () => {
  it('lights the block the caret is in', () => {
    expect(at('plain text', 'plain')).toEqual(['paragraph']);
    expect(at('## Section', 'Section')).toEqual(['h2']);
    expect(at('```\ncode\n```', 'code')).toEqual(['code']);
  });

  it('lights the list kind, and not Paragraph, inside an item', () => {
    expect(at('- item', 'item')).toEqual(['bullet']);
    expect(at('1. item', 'item')).toEqual(['ordered']);
    expect(at('- [ ] item', 'item')).toEqual(['task']);
    expect(at('1. outer\n   - inner', 'inner')).toEqual(['bullet']);
  });

  it('lights what holds the block', () => {
    expect(at('> quoted', 'quoted')).toEqual(['quote']);
    expect(at('| a |\n| - |\n| cell |', 'cell')).toEqual(['table']);
  });

  it('lights the marks at the caret and over a selection', () => {
    expect(at('some **bold** text', 'bold')).toEqual(['paragraph', 'strong']);
    expect(at('some _slanted_ text', 'slanted', 3)).toEqual(['emphasis', 'paragraph']);
    expect(at('some ~~gone~~ text', 'gone')).toEqual(['paragraph', 'strike_through']);
    expect(at('a [link](https://example.com)', 'link')).toEqual(['link', 'paragraph']);
  });
});
