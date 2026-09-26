// @vitest-environment happy-dom
// Live's maths syntax: the pandoc rule of math-rule.js, on lezer's parser (contract §8.1).

import './dom-shim.js';
import { GFM, parser as base } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { mathSyntax, math, mathBlock, MathWidget } from '../../../src/editor/live/widgets/math.js';

const parser = base.configure([GFM, mathSyntax]);


/** Every node of `name` in `text`, as the source it covers. */
function nodes(text, name) {
  const out = [];
  parser.parse(text).iterate({
    enter(n) { if (n.name === name) out.push(text.slice(n.from, n.to)); },
  });
  return out;
}

describe('inline maths: the pandoc rule', () => {
  it.each([
    ['$x$', ['$x$']],
    ['a $x^2$ b', ['$x^2$']],
    ['5 $ puis 10 $', []],
    ['$20,000 and $30,000', []],
    ['\\$x$', []],
    ['a $$b$$ c', []],
    ['$x $', []],
    ['$ x$', []],
    ['$a$ and $b$', ['$a$', '$b$']],
    ['$a\\$b$', ['$a\\$b$']],
    ['`$x$`', []],
    ['$x$5', []],
    ['one $a\nb$ two', []],
  ])('%j', (text, want) => {
    expect(nodes(text, 'InlineMath')).toEqual(want);
  });

  it('a `$` right after another `$` opens nothing', () => {
    expect(nodes('a$$b$', 'InlineMath')).toEqual([]);
  });

  it('marks the two dollars', () => {
    expect(nodes('a $x$ b', 'MathMark')).toEqual(['$', '$']);
  });
});

describe('display maths', () => {
  it('one line', () => {
    expect(nodes('$$x$$\n', 'BlockMath')).toEqual(['$$x$$']);
  });

  it('several lines, with a blank line kept inside', () => {
    const text = 'before\n\n$$\na\n\nb\n$$\n\nafter\n';
    expect(nodes(text, 'BlockMath')).toEqual(['$$\na\n\nb\n$$']);
    expect(nodes(text, 'Paragraph')).toEqual(['before', 'after']);
  });

  it('a closer with text before it on its line', () => {
    expect(nodes('$$\nx = 1 $$\n', 'BlockMath')).toEqual(['$$\nx = 1 $$']);
  });

  it('never closed: a paragraph', () => {
    const text = '$$\nx\n\nmore\n';
    expect(nodes(text, 'BlockMath')).toEqual([]);
    expect(nodes(text, 'Paragraph').length).toBe(2);
  });

  it('does not interrupt a paragraph', () => {
    const text = 'a sentence\n$$\nx\n$$\n';
    expect(nodes(text, 'BlockMath')).toEqual([]);
  });

  it('three dollars are not a fence', () => {
    expect(nodes('$$$x$$\n', 'BlockMath')).toEqual([]);
  });

  it('indented four spaces is code, not maths', () => {
    expect(nodes('    $$x$$\n', 'BlockMath')).toEqual([]);
  });

  it('inside a quote, the quote marks are children', () => {
    const text = '> $$\n> x\n> $$\n';
    expect(nodes(text, 'BlockMath')).toEqual(['$$\n> x\n> $$']);
    expect(nodes(text, 'QuoteMark').length).toBe(3);
  });

  it('text after the block parses as usual', () => {
    const text = '$$\nx\n$$\n# Title\n';
    expect(nodes(text, 'ATXHeading1')).toEqual(['# Title']);
  });
});

describe('the widgets', () => {
  it('math and math-block are an inline and a block registration', () => {
    expect(math.kind).toBe('inline');
    expect(math.nodes).toEqual(['InlineMath']);
    expect(mathBlock.kind).toBe('block');
    expect(mathBlock.nodes).toEqual(['BlockMath']);
  });

  it('renders with Temml, and a refused formula shows its source in cm-live-math-error', () => {
    const view = /** @type {any} */ ({});
    const ok = new MathWidget('x^2', false, 1).toDOM(view);
    expect(ok.className).toBe('cm-live-math');
    expect(ok.querySelector('math')).not.toBeNull();
    const bad = new MathWidget('\\frac{', false, 1).toDOM(view);
    expect(bad.classList.contains('cm-live-math-error')).toBe(true);
    expect(bad.textContent).toBe('$\\frac{$');
    const block = new MathWidget('\\frac{', true, 2).toDOM(view);
    expect(block.textContent).toBe('$$\\frac{$$');
  });

  it('eq compares the formula, not the position', () => {
    expect(new MathWidget('x', false, 1).eq(new MathWidget('x', false, 1))).toBe(true);
    expect(new MathWidget('x', false, 1).eq(new MathWidget('y', false, 1))).toBe(false);
  });
});
