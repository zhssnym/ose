// `npm test`: the headless tests (H11). Node by default; a file that needs a DOM says so in its
// first line (`// @vitest-environment happy-dom`).
//
// This config stands alone on purpose. vite.config.js is the dev server and would bring the
// Node host, the vault resolution and the shell root with it; none of that belongs in a test,
// and no test ever reads a vault (tests/fixtures holds the corpus).
//
// The core is a stub for the editor (tests/stubs/core.js): the editor sources import it at
// module top level (host.ts), and the serialiser tests never touch what it stands in for.
// `@milkdown/crepe` itself, the exact specifier, is a stub too: image.js imports it only for a
// feature-name constant, and the real package pulls the whole view layer and its stylesheets
// into a test that has no view. Its theme files (`@milkdown/crepe/theme/...css`) fall under the
// stylesheet rule with every other `.css`.
//
// Switches, all environment variables: OSE_FUZZ_RUNS (property runs, default 150),
// OSE_FUZZ_SEED (a number, default 20260925, or `random`), OSE_TEST_STANDIN=1 (the serializer
// tests on the audit engine and the reference guard in tests/support), and
// OSE_TEST_EDITOR_DIR=<dir> (the serializer tests against another copy of src/editor, such as
// work/audit/roundtrip/orig, to see a test fail on the old code).

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // The editor reaches the app through one file, src/editor/host.ts, which imports the core
      // as `../core/core.ts`: that one specifier is the stub (the core's own tests import it by
      // its full path, which this does not match).
      { find: /^\.\.\/core\/core\.ts$/, replacement: here('tests/stubs/core.js') },
      { find: /^@milkdown\/crepe$/, replacement: here('tests/stubs/crepe.js') },
      { find: /^.+\.css(\?.*)?$/, replacement: here('tests/stubs/empty.js') },
    ],
  },
  test: {
    environment: 'node',
    // The repo root, for a test that reads a repository file (tests/core/keys.test.js), since
    // import.meta.url is not a file URL under happy-dom.
    env: { OSE_REPO: here('.') },
    include: ['tests/**/*.test.js'],
        exclude: ['tests/e2e/**', '**/node_modules/**'],
    // The property tests parse and serialise a few thousand documents; the first file in a
    // worker also pays for loading Milkdown.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Several files build an engine and a temp folder each; one fork per file keeps the
    // globals the headless engine installs (engine.js: document, requestAnimationFrame) out of
    // the files that run in happy-dom.
    pool: 'forks',
    server: {
      deps: {
        // Milkdown's packages are ESM that Node loads as they are; the editor sources that
        // import them go through Vite, so the aliases above apply to them.
        inline: [/tests\/stubs/],
      },
    },
  },
});
