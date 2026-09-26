// The documents the serialiser tests run over: the notes in tests/fixtures/corpus and the
// synthetic cases in tests/fixtures/synth.js.
//
// The notes are copies of a dozen school and reading notes from the throwaway vault
// (work/vault/2-learning), chosen for what they hold (maths, tables, fences inside quotes,
// long prose, French) and for holding nothing private. They are read as bytes and never
// written. No test reads work/vault or a real vault. The notes are LF; CRLF, a BOM and mixed
// endings are synthetic cases. tests/fixtures/.gitattributes keeps every fixture byte for byte.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYNTH } from '../fixtures/synth.js';

// Paths from the file's own path, not `new URL(rel, import.meta.url)`: Vite rewrites that
// pattern into a served URL in a happy-dom test file.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'corpus');

/** @returns {Array<{ name: string, text: string }>} every note of the fixture corpus, sorted */
export function notes() {
  // The notes are copies of Hassan's own and stay on his machine (gitignored): the repository is
  // public. Without them, CI runs the synthetic cases only.
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.md')).sort()
    .map((n) => ({ name: `corpus/${n}`, text: readFileSync(join(dir, n), 'utf8') }));
}

/** @returns {Array<{ name: string, text: string }>} the synthetic cases */
export function synthetic() {
  return Object.entries(SYNTH).map(([n, text]) => ({ name: `synth/${n}`, text }));
}

/** Notes, then synthetic cases. */
export function corpus() {
  return [...notes(), ...synthetic()];
}
