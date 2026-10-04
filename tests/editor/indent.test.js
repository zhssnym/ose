// Tab in a paragraph types an em space (src/editor/commands.ts `INDENT`): the one indent a
// markdown file can hold. It has to be written as it is and read back as it is, wherever it
// sits, and never turn the paragraph into something else.

import { describe, expect, it } from 'vitest';

const { makeEngine } = await import('../../src/editor/engine.ts');

const engine = await makeEngine();
const EM = ' ';

describe('an em space indent', () => {
  it('stays a paragraph and is saved byte for byte', () => {
    for (const md of [`${EM}Une suite`, `${EM}${EM}deux`, `a${EM}b`, `> ${EM}cité`]) {
      expect(engine.parse(md).textContent).toContain(EM);
      expect(engine.roundTrip(md)).toBe(md);
    }
    expect(engine.parse(`${EM}Une suite`).firstChild.type.name).toBe('paragraph');
  });

  it('is written raw when typed at the start of a paragraph, never as an entity', () => {
    const s = engine.schema;
    const doc = s.node('doc', null, [s.node('paragraph', null, [s.text(`${EM}typed`)])]);
    expect(engine.serialize(doc)).toBe(`${EM}typed\n`);
  });
});
