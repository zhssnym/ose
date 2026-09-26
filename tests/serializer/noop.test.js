// An untouched file is never rewritten (CLAUDE.md, markdown fidelity). Every note of the fixture
// corpus and every synthetic case is opened the way the page opens it (doc.js parseDoc, the body
// parsed by the engine) and written back unedited: the file must come back byte for byte, the
// guard must call it `ok`, and the open-time check must find nothing missing.
//
// Each file is also read as a Windows file would be: CRLF endings, a BOM, and both. The notes
// are LF; those three variants are what doc.js has to carry back around an untouched body.

import { describe, expect, it } from 'vitest';
import { composeDoc, parseDoc } from '../../src/editor/doc.js';
import { corpus } from '../support/corpus.js';
import { pipeline } from '../support/pipeline.js';

const quiet = (fn) => {
  const log = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = log; }
};

/** The file as written, and as it would be with CRLF endings, a BOM, and both. */
function variants(text) {
  const bare = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lf = bare.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  return [['', text], [' (CRLF)', crlf], [' (BOM)', `\uFEFF${lf}`], [' (BOM, CRLF)', `\uFEFF${crlf}`]];
}

describe('a no-op save writes the file back unchanged', () => {
  for (const f of corpus()) {
    for (const [label, text] of variants(f.text)) {
      it(f.name + label, async () => {
        const P = await pipeline();
        const d = parseDoc(text);
        const doc = quiet(() => P.engine.parse(d.body));
        const w = P.checkWrite(doc, d.body);
        expect(w.status, w.reason).toBe('ok');
        expect(composeDoc(d, { title: d.title, body: w.text })).toBe(text);
        const open = quiet(() => P.checkOpen(d.body, doc));
        expect(open, JSON.stringify(open)).toEqual({ ok: true });
      });
    }
  }
});
