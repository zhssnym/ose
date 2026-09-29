// Live's buffer (src/editor/live/state.ts): the file text is the only truth. `liveText` gives
// back the file byte for byte, an edit changes only the lines it touched (their separators
// included), and a task toggle is one byte.
import { describe, it, expect } from 'vitest';
import { liveState, liveText, toggleTaskAt, taskMarkerAt, liveFormat, setFormat } from '../../../src/editor/live/state.ts';
import { textFormat } from '../../../src/editor/source.ts';

const SHAPES = {
  lf: 'a\nb\nc\n',
  crlf: 'a\r\nb\r\nc\r\n',
  cr: 'a\rb\rc\r',
  mixed: 'a\r\nb\nc\rd\r\ne',
  bom: '﻿# T\r\n\r\nbody\r\n',
  empty: '',
  bomOnly: '﻿',
  noFinal: 'x\r\ny',
  blankRuns: '\n\n\r\n\r\n\n',
};

/** Apply a change to a state as a user edit. */
const edit = (s, from, to, insert) => s.update({ changes: { from, to, insert }, userEvent: 'input.type' }).state;

describe('liveText', () => {
  for (const [name, t] of Object.entries(SHAPES)) {
    it(`gives back a ${name} file exactly`, () => {
      expect(liveText(liveState(t))).toBe(t);
    });
  }

  it('keeps the BOM out of the document and puts it back', () => {
    const s = liveState('﻿hello\r\n');
    expect(s.doc.toString()).toBe('hello\n');
    expect(liveText(s)).toBe('﻿hello\r\n');
  });
});

describe('the format follows the edits', () => {
  it('an edit on one line of a mixed file keeps every other separator', () => {
    const t = 'one\r\ntwo\nthree\rfour\r\nfive';
    let s = liveState(t);
    const at = s.doc.line(3).to;                  // end of "three"
    s = edit(s, at, at, '!');
    expect(liveText(s)).toBe('one\r\ntwo\nthree!\rfour\r\nfive');
  });

  it('two edits far apart do not re-end the lines between them', () => {
    const t = ['a', 'b', 'c', 'd', 'e', 'f'].join('\r\n') + '\n' + ['g', 'h'].join('\r\n');
    let s = liveState(t);
    s = edit(s, s.doc.line(2).to, s.doc.line(2).to, '2');
    s = edit(s, s.doc.line(7).to, s.doc.line(7).to, '7');
    expect(liveText(s)).toBe('a\r\nb2\r\nc\r\nd\r\ne\r\nf\ng7\r\nh');
  });

  it('a new line gets the file\'s usual ending, and the line it split keeps its own after', () => {
    let s = liveState('x\ry\r\nz\r\n');           // usual ending CRLF
    s = edit(s, 1, 1, '\nnew');                  // split after "x"
    expect(liveText(s)).toBe('x\r\nnew\ry\r\nz\r\n');
  });

  it('deleting across lines drops the separators inside the run only', () => {
    let s = liveState('a\rb\nc\r\nd');
    s = edit(s, 1, 4, '');                        // "a" + "\nb\n" removed up to "c"
    expect(liveText(s)).toBe('ac\r\nd');
  });

  it('several ranges in one transaction', () => {
    let s = liveState('a\rb\rc\nd');
    s = s.update({ changes: [{ from: 0, insert: '1' }, { from: 2, insert: '2' }, { from: 4, insert: '\n' }], userEvent: 'input' }).state;
    const fmt = s.field(liveFormat);
    expect(fmt.seps.length).toBe(fmt.lines.length - 1);
    expect(liveText(s)).toBe('1a\r2b\r\rc\nd'.replace('\r\rc', '\r' + '\n'.replace('\n', '\r') + 'c'));
  });

  it('a plain file never grows a format', () => {
    let s = liveState('a\nb\n');
    s = edit(s, 0, 0, 'z\n');
    expect(s.field(liveFormat).plain).toBe(true);
    expect(liveText(s)).toBe('z\na\nb\n');
  });

  it('setFormat replaces the shape outright', () => {
    let s = liveState('a\nb');
    const next = 'a\r\nb';
    s = s.update({ effects: setFormat.of(textFormat(next)) }).state;
    expect(liveText(s)).toBe(next);
  });
});

describe('tasks', () => {
  const t = '- [ ] one\n- [x] two\n1. [X] three\n\n```\n- [ ] not a task\n```\n';

  it('toggles an open task with one byte', () => {
    const s = liveState(t);
    const pos = t.indexOf('[ ]');
    const spec = toggleTaskAt(s, pos + 1);
    expect(spec).toBeTruthy();
    expect(spec.userEvent).toBe('input.live.task');
    const out = liveText(s.update(spec).state);
    expect(out).toBe(t.replace('- [ ] one', '- [x] one'));
    expect(out.length).toBe(t.length);
  });

  it('unticks x and X', () => {
    const s = liveState(t);
    for (const [needle, fixed] of [['[x] two', '[ ] two'], ['[X] three', '[ ] three']]) {
      const pos = t.indexOf(needle);
      const out = liveText(s.update(toggleTaskAt(s, pos)).state);
      expect(out).toBe(t.replace(needle, fixed));
    }
  });

  it('either edge of the marker counts; the text after it does not', () => {
    const s = liveState(t);
    const pos = t.indexOf('[ ]');
    expect(taskMarkerAt(s, pos)).toBeTruthy();
    expect(taskMarkerAt(s, pos + 3)).toBeTruthy();
    expect(toggleTaskAt(s, pos + 5)).toBeNull();
  });

  it('a checkbox inside a code block is not a task', () => {
    const s = liveState(t);
    expect(toggleTaskAt(s, t.lastIndexOf('[ ]') + 1)).toBeNull();
  });

  it('keeps CRLF around a toggle', () => {
    const c = '- [ ] a\r\n- [ ] b\r\n';
    const s = liveState(c);
    const out = liveText(s.update(toggleTaskAt(s, s.doc.toString().lastIndexOf('[ ]'))).state);
    expect(out).toBe('- [ ] a\r\n- [x] b\r\n');
  });
});
