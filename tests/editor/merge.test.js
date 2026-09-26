// The 3-way merge of external changes (CONTRACT §5.3, H7): `merge3` and `keepBoth`, pure, line
// based, each side's line endings kept. A change on disk that touches other lines than the
// buffer's merges; one that touches the same lines is a conflict and the buffer is `ours`.
//
// Depends on: editor (src/editor/merge.js). Skipped until that file exists.

import { describe, expect, it } from 'vitest';
import { present as exists } from '../support/present.js';

const present = exists('src/editor/merge.js');
const { merge3, keepBoth } = present ? await import('../../src/editor/merge.js') : {};

const base = '# Title\n\nOne.\n\nTwo.\n\nThree.\n\nFour.\n\nFive.\n';

describe.skipIf(!present)('merge3', () => {
  it('answers the other side when only one side changed', () => {
    const theirs = base.replace('Five.', 'Five, on disk.');
    expect(merge3(base, base, theirs)).toEqual({ clean: true, text: theirs });
    const ours = base.replace('One.', 'One, typed.');
    expect(merge3(base, ours, base)).toEqual({ clean: true, text: ours });
  });

  it('merges changes to lines far apart', () => {
    const ours = base.replace('One.', 'One, typed.');
    const theirs = base.replace('Five.', 'Five, on disk.');
    const r = merge3(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.text).toBe(base.replace('One.', 'One, typed.').replace('Five.', 'Five, on disk.'));
  });

  it('merges an insertion on one side and a deletion on the other', () => {
    const ours = base.replace('Two.\n', 'Two.\n\nTwo and a half.\n');
    const theirs = base.replace('\nFour.\n', '');
    const r = merge3(base, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.text).toContain('Two and a half.');
    expect(r.text).not.toContain('Four.');
  });

  it('the same change on both sides is no conflict', () => {
    const both = base.replace('Three.', 'Three!');
    expect(merge3(base, both, both)).toEqual({ clean: true, text: both });
  });

  it('an overlap is a conflict, and the text is ours', () => {
    const ours = base.replace('Three.', 'Three, mine.');
    const theirs = base.replace('Three.', 'Three, theirs.');
    const r = merge3(base, ours, theirs);
    expect(r.clean).toBe(false);
    expect(r.text).toBe(ours);
    expect(r.conflicts).toHaveLength(1);
    const [c] = r.conflicts;
    expect(c.ours).toContain('Three, mine.');
    expect(c.theirs).toContain('Three, theirs.');
    expect(c.base).toContain('Three.');
    expect(typeof c.at).toBe('number');
  });

  it('counts each overlapping region', () => {
    const ours = base.replace('One.', 'One, mine.').replace('Five.', 'Five, mine.');
    const theirs = base.replace('One.', 'One, theirs.').replace('Five.', 'Five, theirs.');
    const r = merge3(base, ours, theirs);
    expect(r.clean).toBe(false);
    expect(r.conflicts).toHaveLength(2);
  });

  it('keeps CRLF line endings', () => {
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    const b = crlf(base);
    const ours = crlf(base.replace('One.', 'One, typed.'));
    const theirs = crlf(base.replace('Five.', 'Five, on disk.'));
    const r = merge3(b, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.text).toBe(crlf(base.replace('One.', 'One, typed.').replace('Five.', 'Five, on disk.')));
    expect(r.text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('keeps a missing final newline, and a BOM', () => {
    const b = '﻿a\n\nb\n\nc';
    const ours = '﻿a, typed\n\nb\n\nc';
    const theirs = '﻿a\n\nb\n\nc, on disk';
    const r = merge3(b, ours, theirs);
    expect(r.clean).toBe(true);
    expect(r.text).toBe('﻿a, typed\n\nb\n\nc, on disk');
  });

  it('merges from an empty base', () => {
    expect(merge3('', '', 'x\n')).toEqual({ clean: true, text: 'x\n' });
  });
});

describe.skipIf(!present)('keepBoth', () => {
  it('writes each overlap as ours then theirs, with no markers', () => {
    const ours = base.replace('Three.', 'Three, mine.');
    const theirs = base.replace('Three.', 'Three, theirs.');
    const text = keepBoth(base, ours, theirs);
    expect(text).toContain('Three, mine.');
    expect(text).toContain('Three, theirs.');
    expect(text.indexOf('Three, mine.')).toBeLessThan(text.indexOf('Three, theirs.'));
    expect(text).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expect(text.startsWith('# Title\n\nOne.\n\nTwo.\n\n')).toBe(true);
    expect(text.endsWith('\n\nFour.\n\nFive.\n')).toBe(true);
  });

  it('keeps the clean parts merged', () => {
    const ours = base.replace('One.', 'One, typed.').replace('Three.', 'Three, mine.');
    const theirs = base.replace('Five.', 'Five, on disk.').replace('Three.', 'Three, theirs.');
    const text = keepBoth(base, ours, theirs);
    expect(text).toContain('One, typed.');
    expect(text).toContain('Five, on disk.');
    expect(text).toContain('Three, mine.');
    expect(text).toContain('Three, theirs.');
  });

  it('keeps CRLF', () => {
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    const text = keepBoth(crlf(base), crlf(base.replace('Three.', 'A.')), crlf(base.replace('Three.', 'B.')));
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(text).toContain('A.\r\n');
    expect(text).toContain('B.\r\n');
  });
});
