// What the serialiser tests run against: the engine and the guard, from src/editor when they
// have landed (CONTRACT 7.1, 7.4) and from tests/support until then.
//
// `landed` says which is which, and tests/serializer/landed.test.js fails while either is
// missing, so a stand-in can never make a run look finished. The stand-ins are the audit's
// engine (tests/support/engine.js) and a plain reading of the guard's contract
// (tests/support/reference-guard.js).
//
// `OSE_TEST_STANDIN=1` runs everything on the stand-ins even when src/editor has the real
// files: that is how the tests themselves are checked while the serialiser is being changed
// under them. landed.test.js still fails in that mode, on purpose.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fallbackEngine from './engine.js';
import * as reference from './reference-guard.js';

// From the file's own path: Vite rewrites `new URL(rel, import.meta.url)` in a happy-dom file.
const src = (name) => join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'editor', name);

/**
 * A module from src/editor if the file exists, else null. The specifier is built at run time
 * so Vite does not try to resolve a file that is not there yet.
 * @param {string} name
 */
async function optional(name) {
  const file = src(name);
  if (!existsSync(file)) return null;
  return import(/* @vite-ignore */ pathToFileURL(file).href);
}

let pending = null;

/**
 * @returns {Promise<{
 *   engine: any, checkWrite: Function, checkOpen: Function, docsEqual: Function,
 *   mdast: (md: string) => any,
 *   S: any,
 *   landed: { engine: boolean, guard: boolean },
 *   errors: { engine?: string, guard?: string },
 * }>}
 */
export function pipeline() {
  pending ??= load();
  return pending;
}

async function load() {
  const errors = {};
  // The audit engine is built either way: it is also where the mdast (and its positions) come
  // from, which the untouched-bytes property reads and the contract's engine does not expose.
  const audit = await fallbackEngine.makeEngine();

  const standIn = process.env.OSE_TEST_STANDIN === '1';
  let engine = audit;
  let engineLanded = false;
  if (standIn) errors.engine = 'OSE_TEST_STANDIN=1: the stand-ins were used';
  else try {
    const mod = await optional('engine.ts');
    if (mod && typeof mod.makeEngine === 'function') { engine = await mod.makeEngine(); engineLanded = true; }
    else if (mod) errors.engine = 'src/editor/engine.ts has no makeEngine export';
  } catch (e) {
    errors.engine = `src/editor/engine.ts failed to load: ${e && e.stack}`;
  }

  let guard = reference;
  let guardLanded = false;
  if (standIn) errors.guard = 'OSE_TEST_STANDIN=1: the stand-ins were used';
  else try {
    const mod = await optional('guard.ts');
    if (mod && ['checkWrite', 'checkOpen', 'docsEqual'].every((k) => typeof mod[k] === 'function')) { guard = mod; guardLanded = true; }
    else if (mod) errors.guard = 'src/editor/guard.ts lacks checkWrite, checkOpen or docsEqual';
  } catch (e) {
    errors.guard = `src/editor/guard.ts failed to load: ${e && e.stack}`;
  }

  // The reference guard reads `mdast` and `canonicalise` off the engine; the landed one is
  // handed an MdEngine and may read only parse and serialize.
  const forGuard = guardLanded ? engine : { ...engine, mdast: audit.mdast, canonicalise: engine.canonicalise ?? audit.canonicalise, S: engine.S ?? audit.S };
  return {
    engine,
    audit,
    mdast: audit.mdast,
    // The stringify module under test: src/editor/stringify.ts, or the copy OSE_TEST_EDITOR_DIR names.
    S: audit.S,
    checkWrite: (doc, original) => guard.checkWrite(forGuard, doc, original),
    checkOpen: (body, doc) => guard.checkOpen(forGuard, body, doc),
    docsEqual: (a, b) => guard.docsEqual(a, b),
    landed: { engine: engineLanded, guard: guardLanded },
    errors,
  };
}
