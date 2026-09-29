// The pure rules of Ose Web (src/web/rules.js) against their reference, dev/files.mjs (the port
// of the host's hide.rs, vault.rs and encoding.rs): the same hash, the same hide rule plus
// Chrome's swap file, the same sort, the same decode and encode. Only the encoding names differ
// on purpose: the web answers them as the host does (`UTF-8`), the dev bridge lowercased.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as ref from '../../dev/files.mjs';
import * as web from '../../src/web/rules.js';

const runs = Number(process.env.OSE_FUZZ_RUNS) || 150;

describe('rules', () => {
  it('hashes as the host does', () => {
    expect(web.hash('')).toBe('cbf29ce484222325');
    expect(web.hash('a')).toBe('af63dc4c8601ec8c');
    fc.assert(fc.property(fc.uint8Array({ maxLength: 300 }), (b) => web.hash(b) === ref.hash(Buffer.from(b))), { numRuns: runs });
    fc.assert(fc.property(fc.string(), (s) => web.hash(s) === ref.hash(s)), { numRuns: runs });
  });

  it('hides what the host hides, and Chrome swap files too', () => {
    const paths = ['a.md', '.ose/state.json', 'x/.git/HEAD', '.GIT', 'ose.exe', 'deep/ose.exe', '.trash/.info/1-a.json',
      '.trash/1-a.md', '.a.md.12.3.tmp', 'n/.b.md.1.case', '~$doc.docx', '.~lock.x.odt#', '.env', 'x/.hidden/y.md', 'WebView2Loader.dll'];
    for (const p of paths) {
      expect([p, web.classify(p)]).toEqual([p, ref.classify(p)]);
      expect([p, web.isInBin(p)]).toEqual([p, ref.isInBin(p)]);
      expect([p, web.isPathHidden(p)]).toEqual([p, ref.isPathHidden(p)]);
    }
    expect(web.isExcluded('notes/a.md.crswap')).toBe(true);
    expect(web.isExcluded('.crswap')).toBe(false);
  });

  it('sorts as the host does', () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => Math.sign(web.naturalCompare(a, b)) === Math.sign(ref.naturalCompare(a, b))), { numRuns: runs });
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
    const cases = [
      Buffer.from('plain\n'), Buffer.from('﻿bom\r\n'), Buffer.from([0xff, 0xfe, 0x61, 0x00]), Buffer.from([0xfe, 0xff, 0x00, 0x61]),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x80]), Buffer.from([0x61, 0x81]), Buffer.alloc(0),
    ];
    for (const b of cases) {
      const w = web.decodeText(new Uint8Array(b));
      const r = ref.decodeText(b);
      expect({ ...w, encoding: w.encoding.toLowerCase() }).toEqual(r);
      expect(web.sameBytes(web.encodeText(w.text, w.encoding), new Uint8Array(b))).toBe(!w.lossy);
    }
    expect(() => web.decodeText(new Uint8Array([0xe9]), 'utf-8')).toThrow(expect.objectContaining({ code: 'not_utf8' }));
    expect(() => web.encodeText('€✓', 'windows-1252')).toThrow(expect.objectContaining({ code: 'unencodable' }));
    expect(() => web.encodingOf('shift_jis')).toThrow(expect.objectContaining({ code: 'unsupported' }));
    fc.assert(fc.property(fc.string(), (s) => {
      for (const enc of ['UTF-8', 'UTF-16LE', 'UTF-16BE']) {
        const b = web.encodeText(s, enc);
        if (!Buffer.from(b).equals(ref.encodeText(s, enc.toLowerCase()))) return false;
      }
      return true;
    }), { numRuns: runs });
  });

  it('sniffs as the host does', () => {
    for (const b of [Buffer.from('text'), Buffer.from([0, 1]), Buffer.from([0x63, 0xe9]), Buffer.from([0xff, 0xfe, 0x61, 0])]) {
      expect(web.sniffText(new Uint8Array(b))).toBe(ref.sniffText(b));
      const e = web.sniffEncoding(new Uint8Array(b));
      expect(e && e.toLowerCase()).toBe(ref.sniffEncoding(b));
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
