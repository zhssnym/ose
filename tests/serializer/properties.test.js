// Property tests of the save path (H11): random edit sequences over the fixture corpus and over
// generated documents, the shapes of the audit's fuzzers (work/audit/roundtrip/fuzz.mjs and
// parsefuzz.mjs), each run through the write guard the page uses (CONTRACT 7.1).
//
//   1. checkWrite never throws, after any edit of any sequence (an autosave can land anywhere);
//   2. an `ok` or `fellBack` text parses back to the document on screen;
//   3. an `ok` text keeps the bytes of every block the edits did not touch;
//   4. a written text, opened and saved again untouched, comes back byte for byte;
//   5. a CRLF file with a BOM, edited in Rich, is written with a BOM and CRLF on every line.
//
// `unsafe` is an allowed answer: the page writes nothing and opens the text as Source. What is
// never allowed is a throw, or a text the guard passed that means something else.
//
// OSE_FUZZ_RUNS (default 150) and OSE_FUZZ_SEED (a number, or `random`) make a run longer or
// draw new cases; a failure prints the seed and the shrunk counterexample. What another seed
// found is kept below as a fixed case, so the default seed is not the only thing standing
// between a regression and a green run.
//
// Depends on: serializer. The fixed cases of property 3 (an untouched indented code block
// written as a fence) fail until stringify.js keeps an indented code block's bytes.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BLOCK_FRAGMENTS, FRAGMENTS } from '../fixtures/fragments.js';
import { composeDoc, parseDoc } from '../../src/editor/doc.js';
import { corpus } from '../support/corpus.js';
import { bodyOf, untouchedMissing } from '../support/docs.js';
import { applyEdits, EDIT_NAMES } from '../support/edits.js';
import { pipeline } from '../support/pipeline.js';

// A fixed seed by default, so `npm test` (and CI) runs the same cases every time and a red run
// is a change in the code, not a new draw. OSE_FUZZ_SEED=random draws a new seed per run.
const RUNS = Number(process.env.OSE_FUZZ_RUNS || 150);
const SEED_ENV = process.env.OSE_FUZZ_SEED || '20260925';
const SEED = SEED_ENV === 'random' ? undefined : Number(SEED_ENV);
const params = (runs = RUNS) => ({ numRuns: runs, ...(SEED === undefined ? {} : { seed: SEED }) });

const FILES = corpus();

/** A source is a whole file; `body` is what the page edits (doc.js parseDoc: no frontmatter, no title). */
const source = (name, file) => ({ name, file, body: bodyOf(file) });
const notes = fc.constantFrom(...FILES.map((f) => source(f.name, f.text)));
const fragments = (list, sep) => fc.tuple(fc.array(fc.constantFrom(...list), { minLength: 2, maxLength: 14 }), fc.boolean())
  .map(([lines, nl]) => source('generated', lines.join(sep) + (nl ? '\n' : '')));

/**
 * A file of the corpus, or a document made of fragments. `soup` joins the fragments line under
 * line, so they run into each other (lazy continuations, setext underlines, a fence swallowing
 * the rest): the safety properties hold for any text at all. `blocks` puts a blank line between
 * whole blocks (fixtures/fragments.js BLOCK_FRAGMENTS), the way notes are written: the fidelity
 * properties are read on those.
 */
const soup = fc.oneof(notes, fragments(FRAGMENTS, '\n'));
const blocks = fc.oneof(notes, fragments(BLOCK_FRAGMENTS, '\n\n'));

/**
 * The same sources as a Windows file: every line ending CRLF and a UTF-8 BOM in front. The body
 * the page edits is LF either way (doc.js parseDoc); what property 5 reads is the whole file
 * composeDoc gives back around it.
 */
const windows = (s) => ({ name: s.name, file: `\uFEFF${s.file.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')}` });

/** A sequence of edits, each with the numbers that choose where it lands. */
const steps = fc.array(
  fc.record({
    name: fc.constantFrom(...EDIT_NAMES),
    nums: fc.array(fc.integer({ min: 0, max: 0xffffffff }), { minLength: 1, maxLength: 4 }),
  }),
  { minLength: 1, maxLength: 6 },
);

/** Milkdown logs, and goes on, when the schema refuses a node; that noise is not a result. */
function quiet(fn) {
  const log = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = log; }
}

/** The document the page would hold for `body`, or null when it cannot be opened at all. */
function open(P, body) {
  try { return quiet(() => P.engine.parse(body)); } catch { return null; }
}

const STATUSES = new Set(['ok', 'fellBack', 'unsafe']);

/** True when `text` has a line feed that is not the end of a CRLF. */
const bareLf = (text) => /(^|[^\r])\n/.test(text);

/**
 * Property 3 on one case: `body` opened, `seq` applied, the guard asked. Null when the case
 * does not qualify (it cannot be opened, the parsed blocks are not the file's, or an edit lost
 * track of where the blocks came from); else the guard's status and, when it is `ok`, the
 * untouched blocks whose bytes the written text lost.
 * @returns {null | { status: string, ok: boolean, missing: string[], where: string }}
 */
function untouched(P, body, seq) {
  const doc = open(P, body);
  if (doc === null) return null;
  const tree = P.mdast(body);
  if (tree.children.length !== doc.childCount) return null;
  const { doc: edited, origin, applied } = applyEdits(doc, seq);
  if (origin === null) return null;
  const w = quiet(() => P.checkWrite(edited, body));
  const ok = w.status === 'ok';
  return {
    status: w.status,
    ok,
    missing: ok ? untouchedMissing(body, tree, origin, edited, w.text) : [],
    where: `${w.status} after ${applied.join(', ') || 'no edit'}, written:\n${JSON.stringify(w.text)}`,
  };
}

describe('the write guard, over random edits', () => {
  it('never throws, after any edit of any sequence', async () => {
    const P = await pipeline();
    fc.assert(fc.property(soup, steps, ({ body }, seq) => {
      const doc = open(P, body);
      fc.pre(doc !== null);
      for (let k = 1; k <= seq.length; k++) {
        const { doc: edited } = applyEdits(doc, seq.slice(0, k));
        let w;
        try { w = quiet(() => P.checkWrite(edited, body)); } catch (e) {
          throw new Error(`checkWrite threw after ${seq.slice(0, k).map((s) => s.name).join(', ')}: ${e && e.stack}`);
        }
        expect(STATUSES.has(w.status), `status ${w.status}`).toBe(true);
        if (w.status !== 'unsafe') expect(typeof w.text).toBe('string');
        else expect(w.text === null || typeof w.text === 'string').toBe(true);
      }
    }), params());
  });

  it('writes only a text that parses back to the document on screen', async () => {
    const P = await pipeline();
    fc.assert(fc.property(soup, steps, ({ body }, seq) => {
      const doc = open(P, body);
      fc.pre(doc !== null);
      const { doc: edited, applied } = applyEdits(doc, seq);
      const w = quiet(() => P.checkWrite(edited, body));
      if (w.status === 'unsafe') return;
      const back = quiet(() => P.engine.parse(w.text));
      expect(P.docsEqual(back, edited), `${w.status} after ${applied.join(', ')}:\n${JSON.stringify(w.text)}`).toBe(true);
    }), params());
  });

  /** Property 3 over one source of documents. */
  const keepsUntouched = (P, from) => fc.property(from, steps, ({ body }, seq) => {
    const r = untouched(P, body, seq);
    fc.pre(r !== null);
    if (r.ok) expect(r.missing, r.where).toEqual([]);
  });

  it('keeps the bytes of every block the edits did not touch, when it says ok: the notes', async () => {
    fc.assert(keepsUntouched(await pipeline(), notes), params());
  });

  it('keeps the bytes of every block the edits did not touch, when it says ok: generated notes', async () => {
    fc.assert(keepsUntouched(await pipeline(), fragments(BLOCK_FRAGMENTS, '\n\n')), params());
  });

  // The counterexamples other seeds found (OSE_FUZZ_SEED 1, 3, 4 and 6), kept as fixed cases so
  // property 3 does not rest on the default seed never drawing them. Each is a generated note
  // holding an indented code block the edits never touch; the text the guard calls `ok` must
  // still hold its four-space lines.
  const SEEDED = {
    'seeds 1 and 3: the last paragraph deleted under an indented code block with a blank line in it': [
      '    indented code\n    more\n\n    indented code\n    more\n\npara text\n\npara text', [{ name: 'delLast', nums: [0] }]],
    'seed 4: a paragraph typed at the top, then one quoted, above an indented code block': [
      'para text\n\npara text\n\n    indented code\n    more\n\npara text\n\npara text',
      [{ name: 'insertParaTop', nums: [0] }, { name: 'wrapQuote', nums: [858993460] }]],
    'seed 6: an indented code block with a blank line in it, saved as it is': [
      '    indented code\n    more\n\n    indented code\n    more', [{ name: 'delLast', nums: [0] }]],
  };
  for (const [name, [body, seq]] of Object.entries(SEEDED)) {
    it(`keeps the bytes of every block the edits did not touch: ${name}`, async () => {
      const r = untouched(await pipeline(), body, seq);
      expect(r, 'the case no longer opens as the file\'s blocks').not.toBeNull();
      expect(r.status, r.where).toBe('ok');
      expect(r.missing, r.where).toEqual([]);
    });
  }

  // Read on whole files, the way the page writes them: doc.js composeDoc puts the frontmatter,
  // the title and the file's line endings back around the body.
  it('writes a file that a second, untouched save leaves as it is', async () => {
    const P = await pipeline();
    fc.assert(fc.property(blocks, steps, ({ file, body }, seq) => {
      const doc = open(P, body);
      fc.pre(doc !== null);
      const { doc: edited, applied } = applyEdits(doc, seq);
      const w = quiet(() => P.checkWrite(edited, body));
      if (w.status !== 'ok') return;
      const d = parseDoc(file);
      const saved = composeDoc(d, { title: d.title, body: w.text });
      const d2 = parseDoc(saved);
      const again = quiet(() => P.checkWrite(P.engine.parse(d2.body), d2.body));
      expect(again.status, again.reason).not.toBe('unsafe');
      expect(composeDoc(d2, { title: d2.title, body: again.text }), `after ${applied.join(', ')}`).toBe(saved);
    }), params());
  });

  // Nothing else reads line endings: the other properties compare bodies, which are LF, and a
  // file composed back unedited is the no-op test's. A CRLF file keeps CRLF on the lines an edit
  // touched too (doc.js restoreEols gives them the file's usual ending), and its BOM stays. A
  // file with no line terminator at all has no ending to follow, so it is left out.
  it('writes a CRLF file with a BOM with a BOM and CRLF on every line', async () => {
    const P = await pipeline();
    fc.assert(fc.property(blocks.map(windows), steps, ({ file }, seq) => {
      const d = parseDoc(file);
      const doc = open(P, d.body);
      fc.pre(doc !== null);
      const { doc: edited, applied } = applyEdits(doc, seq);
      const w = quiet(() => P.checkWrite(edited, d.body));
      if (w.status === 'unsafe') return;
      const saved = composeDoc(d, { title: d.title, body: w.text });
      const where = `${w.status} after ${applied.join(', ') || 'no edit'}:\n${JSON.stringify(saved)}`;
      expect(saved.startsWith('\uFEFF'), `no BOM, ${where}`).toBe(true);
      if (file.includes('\r\n')) expect(bareLf(saved), `a bare LF, ${where}`).toBe(false);
    }), params());
  });
});
