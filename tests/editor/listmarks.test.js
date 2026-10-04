// An outline's numbering (src/editor/listmarks.ts): which list items wear I. A. a. and which
// keep the editor's own 1.

import { describe, expect, it } from 'vitest';

const { makeEngine } = await import('../../src/editor/engine.ts');
const { letters, listMarks, roman } = await import('../../src/editor/listmarks.ts');

const engine = await makeEngine();
const marks = (md) => listMarks(engine.parse(md)).map((m) => m.mark);

describe('listMarks', () => {
  it('leaves a numbered list with no numbered list inside it alone', () => {
    expect(marks('1. one\n2. two\n3. three')).toEqual([]);
    expect(marks('1. one\n   - a bullet\n2. two')).toEqual([]);
  });

  it('numbers an outline I. A. 1. a.', () => {
    const md = [
      '1. first',
      '   1. sub one',
      '   2. sub two',
      '      1. third level',
      '         1. fourth level',
      '2. second',
    ].join('\n');
    // document order; the third level keeps its own `1.` and wears no mark
    expect(marks(md)).toEqual(['I.', 'A.', 'B.', 'a.', 'II.']);
  });

  it('follows the number a list starts at', () => {
    expect(marks('3. third\n   1. sub\n4. fourth')).toEqual(['III.', 'A.', 'IV.']);
  });

  it('counts the numbered lists an item is in, whatever lies between them', () => {
    expect(marks('1. first\n   - a bullet\n     1. under it')).toEqual(['I.', 'A.']);
  });

  it('judges each list on its own', () => {
    expect(marks('1. flat\n2. flat\n\ntext\n\n1. outline\n   1. sub')).toEqual(['I.', 'A.']);
  });
});

describe('roman and letters', () => {
  it('writes the numbers a list reaches', () => {
    expect([1, 4, 9, 14, 40, 1999].map(roman)).toEqual(['I', 'IV', 'IX', 'XIV', 'XL', 'MCMXCIX']);
    expect([1, 26, 27, 52, 53].map(letters)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA']);
  });
});
