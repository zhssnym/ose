// The marquee's geometry (src/editor/marquee.ts): which run of top-level blocks a band drawn
// from the air meets, top to bottom only.

import { describe, expect, it } from 'vitest';

const { blocksInBand } = await import('../../src/editor/marquee.ts');

const rects = [
  { top: 0, bottom: 20 },
  { top: 30, bottom: 50 },
  { top: 60, bottom: 60 },                // no height: never met
  { top: 70, bottom: 100 },
];

describe('blocksInBand', () => {
  it('answers the run of blocks the band overlaps, whichever way it was drawn', () => {
    expect(blocksInBand(rects, 10, 40)).toEqual({ first: 0, last: 1 });
    expect(blocksInBand(rects, 80, 15)).toEqual({ first: 0, last: 3 });
    expect(blocksInBand(rects, 35, 35)).toEqual({ first: 1, last: 1 });
  });

  it('answers null for a band in a gap, and skips a block with no height', () => {
    expect(blocksInBand(rects, 22, 28)).toBeNull();
    expect(blocksInBand(rects, 55, 65)).toBeNull();
    expect(blocksInBand(rects, 20, 30)).toBeNull();
  });
});
