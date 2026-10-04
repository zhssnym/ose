// Property tests of Source mode's byte keeping (M3): CodeMirror holds a file as lines joined by
// `\n` with no mark, and `applyFormat` puts the file's BOM and line endings back on save. Over
// every note of the fixture corpus (when the folder is there), and 300 generated files
// (tes../fixtures/synth-files.js: LF, CRLF, CR and mixed endings, a BOM, frontmatter, tables,
// maths, tasks):
//
//   1. identity: a file loaded and saved untouched is the same bytes;
//   2. edit locality: after random edits, every line before the first edit and after the last
//      keeps its bytes, its separator included, and the saved bytes read back as the text on
//      screen.
//
// This took over from tests/live/properties.test.js when Live was removed: that file proved
// the same of Live, which saved through the same `applyFormat`.
//
// OSE_FUZZ_SEED (a number, default 20260925, or `random`) draws other files and edits; a
// failure names the seed and the file.

import { describe, expect, it } from 'vitest';
import { applyFormat, textFormat } from '../../src/editor/source.ts';
import { liveSynth, rng } from '../fixtures/synth-files.js';
import { corpus } from '../support/corpus.js';

const SEED_ENV = process.env.OSE_FUZZ_SEED || '20260925';
const SEED = SEED_ENV === 'random' ? Math.floor(Math.random() * 2 ** 31) : Number(SEED_ENV);
const DOCS = [...corpus(), ...liveSynth(300, SEED)];
const at = (name) => `${name} (OSE_FUZZ_SEED=${SEED})`;

/** The lines of a file text with their separators: `a\r\nb` -> ['a\r\n', 'b']. */
function linesOf(text) {
  const out = [];
  const re = /\r\n|\r|\n/g;
  let from = 0;
  let m;
  while ((m = re.exec(text))) {
    out.push(text.slice(from, re.lastIndex));
    from = re.lastIndex;
  }
  out.push(text.slice(from));
  return out;
}

/** What the view holds for a file: its lines joined by `\n`, no mark. */
const viewOf = (fmt) => fmt.lines.join('\n');

const TYPED = ['x', ' ', 'é', '🙂', '\n', '\n\n', '- ', '- [ ] ', '# ', '> ', '|', '$', '$$\n', '```\n', '---\n',
  '**', '_', '`', '![a](b.png)', '\t', 'line one\nline two'];

describe('Source: the file keeps its bytes', () => {
  it('has files to run over', () => {
    expect(DOCS.length).toBeGreaterThan(300);
  });

  it('1. identity: loaded and saved untouched, byte for byte', () => {
    for (const { name, text } of DOCS) {
      const fmt = textFormat(text);
      expect(applyFormat(viewOf(fmt), fmt), at(name)).toBe(text);
    }
  });

  it('2. edit locality: lines before the first edit and after the last keep their bytes', () => {
    const r = rng(SEED ^ 0x5eed);
    for (const { name, text } of DOCS) {
      const fmt = textFormat(text);
      const orig = linesOf(text);
      for (let round = 0; round < 6; round++) {
        let doc = viewOf(fmt);
        // Everything before `lo` and the last `tail` characters were never touched.
        let lo = doc.length;
        let tail = doc.length;
        const log = [];
        const steps = 1 + r.int(4);
        for (let k = 0; k < steps; k++) {
          const len = doc.length;
          const kind = len ? r.pick(['insert', 'insert', 'delete', 'replace']) : 'insert';
          const from = r.int(len + 1);
          const to = kind === 'insert' ? from : Math.min(len, from + 1 + r.int(Math.min(40, len)));
          const insert = kind === 'delete' ? '' : r.pick(TYPED);
          log.push({ from, to, insert });
          doc = doc.slice(0, from) + insert + doc.slice(to);
          lo = Math.min(lo, from);
          tail = Math.min(tail, len - to);
        }
        const saved = applyFormat(doc, fmt);
        const where = `${at(name)} after ${JSON.stringify(log)}`;
        expect(viewOf(textFormat(saved)), where).toBe(doc);

        const out = linesOf(saved);
        // Head: original line i, separator included, wholly before `lo`.
        let pos = 0;
        for (let i = 0; i < fmt.lines.length - 1; i++) {
          pos += fmt.lines[i].length + 1;
          if (pos > lo) break;
          expect(out[i], `${where} head line ${i + 1}`).toBe(orig[i]);
        }
        // Tail: original lines counted from the end, wholly inside the last `tail` characters,
        // with the separator before them on the untouched side too.
        let back = 0;
        for (let j = 1; j < fmt.lines.length; j++) {
          back += fmt.lines[fmt.lines.length - j].length;
          if (back + 1 > tail) break;
          expect(out[out.length - j], `${where} tail line -${j}`).toBe(orig[orig.length - j]);
          back += 1;
        }
      }
    }
  });
});
