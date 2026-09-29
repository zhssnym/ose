// The pure rules of Ose Web (src/host/rules.js): the hash, the hide rule plus Chrome's swap
// file, the sort, the decode and the encode. The expected values are the ones the old desktop
// host and its Node port answered (git history, dev/files.mjs at 6cee39d), frozen here, so the
// rules stay what files and agents already rely on. Encoding names are compared lowercased.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as web from '../../src/host/rules.js';

const runs = Number(process.env.OSE_FUZZ_RUNS) || 150;

/** 64-bit FNV-1a over the bytes (UTF-8 for a string), in hex: the reference for `hash`. */
function fnv1a(data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, '0');
}

/** The reference natural order: digit runs by value, everything else by lowercased code point. */
function naturalReference(a, b) {
  const A = [...String(a)];
  const B = [...String(b)];
  const digit = (c) => c >= '0' && c <= '9';
  const lower = (c) => [...c.toLowerCase()][0] || c;
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (digit(A[i]) && digit(B[j])) {
      const si = i;
      const sj = j;
      while (i < A.length && digit(A[i])) i++;
      while (j < B.length && digit(B[j])) j++;
      const na = A.slice(si, i).join('').replace(/^0+/, '');
      const nb = B.slice(sj, j).join('').replace(/^0+/, '');
      if (na.length !== nb.length) return na.length - nb.length;
      if (na !== nb) return na < nb ? -1 : 1;
    } else {
      const ca = lower(A[i]).codePointAt(0);
      const cb = lower(B[j]).codePointAt(0);
      if (ca !== cb) return ca - cb;
      i++;
      j++;
    }
  }
  return A.length - i - (B.length - j);
}

/** UTF-16BE: the UTF-16LE bytes, swapped pairwise. @param {string} s */
const utf16be = (s) => {
  const b = Buffer.from(s, 'utf16le');
  for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
  return b;
};

describe('rules', () => {
  it('hashes as the host does', () => {
    expect(web.hash('')).toBe('cbf29ce484222325');
    expect(web.hash('a')).toBe('af63dc4c8601ec8c');
    expect(web.hash('hello')).toBe('a430d84680aabd0b');
    expect(web.hash(new Uint8Array([0, 255, 128]))).toBe('d6c4781869e88da0');
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (b) => web.hash(b) === fnv1a(Buffer.from(b))), { numRuns: runs });
    fc.assert(fc.property(fc.string(), (s) => web.hash(s) === fnv1a(s)), { numRuns: runs });
  });

  it('hides what the host hides, and Chrome swap files too', () => {
    // [path, classify, isInBin, isPathHidden]
    const cases = [
      ['a.md', 'shown', false, false],
      ['.ose/state.json', 'excluded', false, true],
      ['x/.git/HEAD', 'excluded', false, true],
      ['.GIT', 'excluded', false, true],
      ['ose.exe', 'excluded', false, false],
      ['deep/ose.exe', 'shown', false, false],
      ['.trash/.info/1-a.json', 'excluded', true, true],
      ['.trash/1-a.md', 'shown', true, true],
      ['.a.md.12.3.tmp', 'excluded', false, true],
      ['n/.b.md.1.case', 'excluded', false, true],
      ['~$doc.docx', 'excluded', false, false],
      ['.~lock.x.odt#', 'excluded', false, true],
      ['.env', 'hidden', false, true],
      ['x/.hidden/y.md', 'shown', false, true],
      ['WebView2Loader.dll', 'excluded', false, false],
    ];
    for (const [p, cls, bin, hidden] of cases) {
      expect([p, web.classify(p), web.isInBin(p), web.isPathHidden(p)]).toEqual([p, cls, bin, hidden]);
    }
    expect(web.isExcluded('notes/a.md.crswap')).toBe(true);
    expect(web.isExcluded('.crswap')).toBe(false);
  });

  it('sorts as the host does', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => Math.sign(web.naturalCompare(a, b)) === Math.sign(naturalReference(a, b))), { numRuns: runs });
    expect(['a10', 'a2', 'B1', 'a1'].sort(web.naturalCompare)).toEqual(['a1', 'a2', 'a10', 'B1']);
  });

  it('reads paths literally', () => {
    expect(web.vaultSegments('a/./b//c.md')).toEqual(['a', 'b', 'c.md']);
    expect(web.vaultSegments('')).toEqual([]);
    expect(() => web.vaultSegments('../x')).toThrow(expect.objectContaining({ code: 'escapes_vault' }));
    expect(() => web.vaultSegments('abs:/x')).toThrow(expect.objectContaining({ code: 'escapes_vault' }));
    expect(() => web.vaultSegments('con.txt', true)).toThrow(expect.objectContaining({ code: 'bad_name' }));
    expect(web.vaultSegments('con.txt', false)).toEqual(['con.txt']);
    expect(() => web.checkName('a/b.')).toThrow(expect.objectContaining({ code: 'bad_name' }));
    expect(() => web.checkName('a?.md')).toThrow(expect.objectContaining({ code: 'bad_name' }));
  });

  it('decodes and encodes as the host does', () => {
    /** @type {[Buffer, { text: string, encoding: string, bom: boolean, lossy: boolean }][]} */
    const cases = [
      [Buffer.from('plain\n'), { text: 'plain\n', encoding: 'utf-8', bom: false, lossy: false }],
      [Buffer.from('\ufeffbom\r\n'), { text: '\ufeffbom\r\n', encoding: 'utf-8', bom: true, lossy: false }],
      [Buffer.from([0xff, 0xfe, 0x61, 0x00]), { text: '\ufeffa', encoding: 'utf-16le', bom: true, lossy: false }],
      [Buffer.from([0xfe, 0xff, 0x00, 0x61]), { text: '\ufeffa', encoding: 'utf-16be', bom: true, lossy: false }],
      [Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x80]), { text: 'caf\u00e9\u20ac', encoding: 'windows-1252', bom: false, lossy: false }],
      [Buffer.from([0x61, 0x81]), { text: 'a\u0081', encoding: 'windows-1252', bom: false, lossy: false }],
      [Buffer.alloc(0), { text: '', encoding: 'utf-8', bom: false, lossy: false }],
    ];
    for (const [b, r] of cases) {
      const w = web.decodeText(new Uint8Array(b));
      expect({ ...w, encoding: w.encoding.toLowerCase() }).toEqual(r);
      expect(web.sameBytes(web.encodeText(w.text, w.encoding), new Uint8Array(b))).toBe(!w.lossy);
    }
    expect(() => web.decodeText(new Uint8Array([0xe9]), 'utf-8')).toThrow(expect.objectContaining({ code: 'not_utf8' }));
    expect(() => web.encodeText('€✓', 'windows-1252')).toThrow(expect.objectContaining({ code: 'unencodable' }));
    expect(() => web.encodingOf('shift_jis')).toThrow(expect.objectContaining({ code: 'unsupported' }));
    fc.assert(fc.property(fc.string(), (s) => {
      const want = { 'UTF-8': Buffer.from(s, 'utf8'), 'UTF-16LE': Buffer.from(s, 'utf16le'), 'UTF-16BE': utf16be(s) };
      for (const [enc, bytes] of Object.entries(want)) {
        if (!Buffer.from(web.encodeText(s, enc)).equals(bytes)) return false;
      }
      return true;
    }), { numRuns: runs });
  });

  it('sniffs as the host does', () => {
    /** @type {[Buffer, boolean, string | null][]} [bytes, sniffText, sniffEncoding] */
    const cases = [
      [Buffer.from('text'), true, 'windows-1252'],
      [Buffer.from([0, 1]), false, null],
      [Buffer.from([0x63, 0xe9]), false, 'windows-1252'],
      [Buffer.from([0xff, 0xfe, 0x61, 0]), false, 'utf-16le'],
    ];
    for (const [b, text, enc] of cases) {
      expect(web.sniffText(new Uint8Array(b))).toBe(text);
      const e = web.sniffEncoding(new Uint8Array(b));
      expect(e && e.toLowerCase()).toBe(enc);
    }
    const cut = Buffer.concat([Buffer.alloc(web.SNIFF_BYTES - 1, 0x61), Buffer.from([0xc3])]);
    expect(web.sniffText(new Uint8Array(cut))).toBe(true);
  });

  it('maps what the browser throws to host codes', () => {
    const dom = (name) => new DOMException('m', name);
    expect(web.fromDom(dom('NotFoundError'), 'a.md')).toMatchObject({ code: 'not_found', message: 'a.md: m' });
    expect(web.fromDom(dom('InvalidModificationError')).code).toBe('exists');
    expect(web.fromDom(dom('NotAllowedError')).code).toBe('no_vault');
    expect(web.fromDom(dom('QuotaExceededError')).code).toBe('write_failed');
    expect(web.fromDom(new Error('x')).code).toBe('io');
    const h = web.fail('bad_arg', 'b');
    expect(web.fromDom(h)).toBe(h);
  });
});
