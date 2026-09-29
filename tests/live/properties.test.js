// Property tests of Live (CONTRACT X2, §3.7): the file text is the only truth, so over every
// note of the fixture corpus (when the folder is there), the serializer's synthetic cases and
// 300 generated files (tests/fixtures/live-synth.js: LF, CRLF, CR and mixed endings, a BOM,
// frontmatter, tables, maths, callouts, tasks and wikilinks):
//
//   1. identity: `liveText(liveState(t)) === t`, byte for byte;
//   2. edit locality: after a random sequence of user edits (insert, delete, replace at random
//      offsets), every line of the original the edits never touched is byte-identical in the
//      bytes a save writes, at the position the changes map it to, its separator included, and
//      those bytes read back as the document on screen;
//   3. decorations are pure: `liveDecorations` for 50 random selections, focused or not, never
//      throws and never changes the document;
//   4. a task toggle is one byte: `toggleTaskAt` changes exactly one byte of `liveText`.
//
// OSE_FUZZ_SEED (a number, default 20260925, or `random`) draws other files, edits and
// selections; a failure names the seed and the file.
//
// Depends on: live-core (src/editor/live), live-widgets (the parser extensions, through
// live/index.js).

import { describe, expect, it } from 'vitest';
import { liveDecorations, liveState, liveText, toggleTaskAt } from '../../src/editor/live/index.ts';
import { liveSynth, rng } from '../fixtures/live-synth.js';
import { corpus } from '../support/corpus.js';

const SEED_ENV = process.env.OSE_FUZZ_SEED || '20260925';
const SEED = SEED_ENV === 'random' ? Math.floor(Math.random() * 2 ** 31) : Number(SEED_ENV);
const DOCS = [...corpus(), ...liveSynth(300, SEED)];
const at = (name) => `${name} (OSE_FUZZ_SEED=${SEED})`;

/** The lines of a file text with their separators: `a\r\nb` -> ['a\r\n', 'b']. The mark stays
 *  on the first line. A text ending in a separator has an empty last line. */
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

/** Text a user types or pastes, chosen to cross the constructs Live draws. */
const TYPED = ['x', ' ', 'é', '🙂', '\n', '\n\n', '- ', '- [ ] ', '# ', '> ', '> [!note] ', '|', '| a | b |\n|---|---|\n',
  '$', '$$\n', '```\n', '---\n', '[[', ']]', '**', '_', '`', '![a](b.png)', '\t', 'line one\nline two'];

/** A random edit of `state` as a user transaction spec, or null when there is nothing to do. */
function randomEdit(r, state) {
  const len = state.doc.length;
  const kind = r.pick(['insert', 'insert', 'delete', 'replace']);
  const from = r.int(len + 1);
  if (kind === 'insert') return { changes: { from, insert: r.pick(TYPED) }, userEvent: 'input.type' };
  if (!len) return null;
  const to = Math.min(len, from + 1 + r.int(Math.min(40, len)));
  if (from >= to) return null;
  if (kind === 'delete') return { changes: { from, to }, userEvent: 'delete' };
  return { changes: { from, to, insert: r.pick(TYPED) }, userEvent: 'input.type' };
}

describe('Live: the file text is the only truth', () => {
  it('has files to run over', () => {
    expect(DOCS.length).toBeGreaterThan(300);
  });

  it('1. identity: liveText(liveState(t)) === t, byte for byte', () => {
    for (const { name, text } of DOCS) {
      expect(liveText(liveState(text, { path: 'note.md' })), at(name)).toBe(text);
    }
  });

  it('2. edit locality: untouched lines keep their bytes and their separators', () => {
    const r = rng(SEED ^ 0x5eed);
    for (const { name, text } of DOCS) {
      for (let round = 0; round < 6; round++) {
        let state = liveState(text, { path: 'note.md' });
        const orig = linesOf(text);
        // Each original line: its range in the document, the separator's position included
        // (clamped to the end), and whether an edit has touched it yet.
        const lines = [];
        let pos = 0;
        for (let i = 0; i < state.doc.lines; i++) {
          const line = state.doc.line(i + 1);
          lines.push({ i, from: line.from, to: Math.min(line.to + 1, state.doc.length), touched: false });
          pos = line.to + 1;
        }
        expect(pos - 1, at(name)).toBe(state.doc.length);
        expect(lines.length, at(name)).toBe(orig.length);
        const steps = 1 + r.int(8);
        const log = [];
        for (let k = 0; k < steps; k++) {
          const spec = randomEdit(r, state);
          if (!spec) continue;
          log.push(spec.changes);
          const tr = state.update(spec);
          for (const l of lines) {
            if (l.touched) continue;
            if (tr.changes.touchesRange(l.from, l.to)) { l.touched = true; continue; }
            l.from = tr.changes.mapPos(l.from, 1);
            l.to = tr.changes.mapPos(l.to, -1);
          }
          state = tr.state;
        }
        const saved = liveText(state);
        const out = linesOf(saved);
        // The bytes a save writes read back as the document on screen: no two separators run
        // together into one (a `\r` then a `\n` is one CRLF), so no line is lost on reopen.
        expect(out.length, `${at(name)} after ${JSON.stringify(log)}`).toBe(state.doc.lines);
        expect(liveState(saved).doc.toString(), at(name)).toBe(state.doc.toString());
        for (const l of lines) {
          if (l.touched) continue;
          const k = state.doc.lineAt(l.from).number - 1;
          expect(out[k], `${at(name)} line ${l.i + 1} after ${JSON.stringify(log)}`).toBe(orig[l.i]);
        }
      }
    }
  });

  it('3. decorations are pure: they never throw and never change the document', () => {
    const r = rng(SEED ^ 0xdec0);
    for (const { name, text } of DOCS) {
      const state = liveState(text, { path: 'note.md' });
      const before = state.doc;
      const len = before.length;
      for (let k = 0; k < 50; k++) {
        const a = r.int(len + 1);
        const b = r.chance(0.5) ? a : r.int(len + 1);
        const selection = { from: Math.min(a, b), to: Math.max(a, b) };
        const focused = r.chance(0.7);
        let got;
        expect(() => { got = liveDecorations(state, { selection, focused }); }, `${at(name)} ${JSON.stringify(selection)}`).not.toThrow();
        expect(got && got.inline && got.block, at(name)).toBeTruthy();
        expect(state.doc, at(name)).toBe(before);
      }
      expect(liveText(state), at(name)).toBe(text);
    }
  });

  it('4. a task toggle is one byte', () => {
    const r = rng(SEED ^ 0x7a5c);
    let toggled = 0;
    for (const { name, text } of DOCS) {
      const state = liveState(text, { path: 'note.md' });
      const doc = state.doc.toString();
      // Every `[ ]`, `[x]` and `[X]` in the document, and a few random positions besides.
      const spots = [];
      for (const m of doc.matchAll(/\[[ xX]\]/g)) spots.push(m.index + 1);
      for (let k = 0; k < 5; k++) spots.push(r.int(doc.length + 1));
      const bytes = Buffer.from(liveText(state), 'utf8');
      for (const p of spots) {
        const spec = toggleTaskAt(state, p);
        if (!spec) continue;
        toggled++;
        const next = Buffer.from(liveText(state.update(spec).state), 'utf8');
        expect(next.length, at(name)).toBe(bytes.length);
        let diff = 0;
        for (let i = 0; i < bytes.length; i++) if (bytes[i] !== next[i]) diff++;
        expect(diff, `${at(name)} at ${p}`).toBe(1);
      }
    }
    expect(toggled).toBeGreaterThan(50);
  });

  it('4b. a plain task line toggles, both ways, in every line ending', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      for (const [from, to] of [[' ', 'x'], ['x', ' '], ['X', ' ']]) {
        const text = `﻿# T${eol}${eol}- [${from}] task${eol}`;
        const state = liveState(text, { path: 'note.md' });
        const p = state.doc.toString().indexOf('[') + 1;
        const spec = toggleTaskAt(state, p);
        expect(spec, JSON.stringify(text)).toBeTruthy();
        expect(liveText(state.update(spec).state)).toBe(`﻿# T${eol}${eol}- [${to}] task${eol}`);
      }
    }
  });
});
