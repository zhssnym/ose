// The shell is served as written: no bundler resolves what it imports, the browser does. A
// module it names must be a path (`./x.js`) or one of the import map's specifiers (`ose:core`,
// ...). A package name (`@vercel/analytics`) resolves to nothing, the entry fails to load and
// the page stays blank, which is how this test came to be.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SHELL = path.join(process.env.OSE_REPO || '.', 'shell');
const html = readFileSync(path.join(SHELL, 'index.html'), 'utf8');
const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] || '{}');
const known = new Set(Object.keys(map.imports || {}));

/** Every module a file names: static imports, re-exports and `import('...')` with a literal. */
function specifiers(text) {
  const out = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gms)) out.push(m[1]);
  for (const m of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

describe('the shell imports only what a browser can resolve', () => {
  const files = readdirSync(SHELL).filter((f) => f.endsWith('.js'));

  it('has an import map and modules to check', () => {
    expect(known.size).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s', (file) => {
    const text = readFileSync(path.join(SHELL, file), 'utf8');
    for (const spec of specifiers(text)) {
      const ok = /^(\.\.?\/|\/)/.test(spec) || known.has(spec);
      expect(ok, `${file} imports "${spec}": not a path and not in the import map`).toBe(true);
    }
  });
});
