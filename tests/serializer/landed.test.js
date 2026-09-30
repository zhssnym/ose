// The serialiser tests run on src/editor/engine.ts and src/editor/guard.ts (CONTRACT 7.1, 7.4).
// Until both are there and work, the other files in this folder run on stand-ins
// (tests/support/pipeline.js), and this file fails, so a green run never rests on a stand-in.
//
// Depends on: serializer (engine.ts, guard.ts, and the stringify.ts they import).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pipeline } from '../support/pipeline.js';

const EDITOR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'editor');
const src = (name) => readFileSync(join(EDITOR, name), 'utf8');

describe('the engine and the guard have landed', () => {
  it('src/editor/engine.ts and guard.ts are the ones under test', async () => {
    const P = await pipeline();
    expect(P.errors).toEqual({});
    expect(P.landed).toEqual({ engine: true, guard: true });
  });

  it('the engine parses and serialises a small page', async () => {
    const P = await pipeline();
    const md = '# T\n\npara one\n\n- a\n- b\n';
    const doc = P.engine.parse(md);
    expect(doc.childCount).toBeGreaterThan(0);
    expect(typeof P.engine.serialize(doc)).toBe('string');
    expect(P.engine.canonicalise(md)).toBe(md);
    expect(P.engine.roundTrip(md)).toBe(md);
  });

  it('checkWrite writes an untouched page back byte for byte', async () => {
    const P = await pipeline();
    const md = 'para one\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(P.checkWrite(P.engine.parse(md), md)).toEqual({ status: 'ok', text: md });
  });

  // CONTRACT 7.4: these import without a DOM, without CSS and without `ose:*` at module top
  // level. The tests alias `ose:*` to stubs anyway, so the rule is read from the source.
  // The serializer is stringify.ts and the parts in stringify/, so the rule holds for each.
  const serializer = readdirSync(join(EDITOR, 'stringify')).map((f) => `stringify/${f}`);
  it.each(['engine.ts', 'guard.ts', 'stringify.ts', ...serializer, 'space.ts', 'fidelity.ts', 'doc.ts'])(
    '%s imports no ose:* module and no stylesheet at top level',
    (name) => {
      const text = src(name);
      const imports = [...text.matchAll(/^(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]);
      const bare = [...text.matchAll(/^import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      for (const spec of [...imports, ...bare]) {
        expect(spec.startsWith('ose:'), `${name} imports ${spec}`).toBe(false);
        expect(/\.css($|\?)/.test(spec), `${name} imports ${spec}`).toBe(false);
      }
    },
  );

  it('crepe.ts exports the three the page uses', async () => {
    const text = src('crepe.ts');
    for (const name of ['engineOf', 'readMarkdownChecked', 'openCheck']) {
      expect(text, `crepe.ts export ${name}`).toMatch(new RegExp(`export (async )?function ${name}\\b|export const ${name}\\b`));
    }
  });
});
