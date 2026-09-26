// `npm test`: the headless tests (H11). Node by default; a file that needs a DOM says so in its
// first line (`// @vitest-environment happy-dom`).
//
// This config stands alone on purpose. vite.config.js is the dev server and would bring the
// Node host, the vault resolution and the shell root with it; none of that belongs in a test,
// and no test ever reads a vault (tests/fixtures holds the corpus).
//
// `ose:planner` is the real entry (src/planner): the planner tests import its pure modules by
// path, and a test that wants the entry wants the real one.
//
// The kernel's three library specifiers resolve to small stubs: the editor sources import
// `ose:kernel` and `ose:ui` at module top level (host.js, deps.js), and the serialiser tests
// never touch what those stubs stand in for. `@milkdown/crepe` itself, the exact specifier, is
// a stub too: image.js imports it only for a feature-name constant, and the real package pulls
// the whole view layer and its stylesheets into a test that has no view. Its theme files
// (`@milkdown/crepe/theme/...css`) fall under the stylesheet rule with every other `.css`.
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
      { find: /^ose:kernel$/, replacement: here('tests/stubs/kernel.js') },
      { find: /^ose:ui$/, replacement: here('tests/stubs/ui.js') },
      { find: /^ose:planner$/, replacement: here('src/planner/index.js') },
      { find: /^@milkdown\/crepe$/, replacement: here('tests/stubs/crepe.js') },
      { find: /^.+\.css(\?.*)?$/, replacement: here('tests/stubs/empty.js') },
    ],
  },
  test: {
    environment: 'node',
    // The repo root, for tests/support/present.js (import.meta.url is not a file URL under
    // happy-dom).
    env: { OSE_REPO: here('.') },
    include: ['tests/**/*.test.js'],
    // tests/e2e is Playwright's (`npm run test:e2e`, playwright.config.js), not vitest's.
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
