// The kernel build (docs/KERNEL.md). `npm run build` (the standard layout, CONTRACT X4): the
// library bundles into `dist/ose/` and the shell beside them, verbatim, by
// scripts/copy-shell.mjs. Tauri serves `dist/` (`frontendDist`) from its own asset protocol, and
// `index.html` is the shell's own page:
//
//   dist/index.html  dist/main.js  dist/boot.js  ...          the shell, copied from shell/
//   dist/ose/kernel.js  editor.js  planner.js  ui.js  chunks/  the four bundles the import map names
//   dist/ose/ui.css  editor.css  planner.css                   the three stylesheets the shell links
//
// Not an app build: nothing here is hashed, nothing is inlined into HTML, and the entry file
// names are part of the contract: the import map spells them literally.
//
// Who imports whom. `ose:kernel` is the base and bundles everything with state in it: the
// registries, the bridge, the router, the tabs, the key engine and the dialogs (there must be
// one overlay stack in a running Ose, not two). `ose:ui` is a facade that names those again
// from `ose:kernel`; `ose:editor` imports `ose:kernel` and `ose:ui`; `ose:planner` (Day, Week,
// Month and Journal, built in) imports `ose:ui` and, lazily, `ose:editor`, and is handed `ose`
// by the shell. So every `ose:*` specifier is **external** in every bundle, and nothing is
// bundled twice. date-fns is bundled into planner.js, tree-shaken to what the planner uses.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { copyShell } from './scripts/copy-shell.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

/** The build stamp, the same three fields the host prints for `--version`. */
function stamp() {
  const pkg = JSON.parse(readFileSync(here('package.json'), 'utf8'));
  let sha = 'dev';
  let date = new Date().toISOString().slice(0, 10);
  try {
    sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    date = execSync('git log -1 --format=%cs', { encoding: 'utf8' }).trim();
  } catch { /* a source tree with no git: the dev values stand */ }
  return { version: pkg.version, sha, short: sha.slice(0, 7), date };
}

// Every entry is part of the exe: a missing source fails the build, it never ships an exe
// without it.
const ENTRIES = {
  kernel: here('src/kernel/kernel.js'),
  ui: here('src/kernel/ui.js'),
  editor: here('src/editor/lib.js'),
  planner: here('src/planner/index.js'),
  'ui.css': here('src/kernel/ui.css'),
};

const s = stamp();

/** The shell into the build, after the bundles, beside `dist/ose/`: one build makes the whole exe. */
function shellIntoTheBuild() {
  let outDir = here('dist/ose');
  return {
    name: 'ose-copy-shell',
    // The directory this build really writes (`--outDir` on the command line included), so a
    // check build somewhere else never rewrites the real output.
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    closeBundle() { copyShell(path.dirname(outDir)); },
  };
}

export default defineConfig(() => ({
  // Relative: the page must not care which origin serves it.
  base: './',
  define: {
    __OSE_VERSION__: JSON.stringify(s.version),
    __OSE_SHA__: JSON.stringify(s.sha),
    __OSE_SHORT__: JSON.stringify(s.short),
    __OSE_DATE__: JSON.stringify(s.date),
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  plugins: [shellIntoTheBuild()],
  // See src/editor/katex-absent.js: Crepe's unused Latex feature would drag KaTeX in.
  resolve: { alias: { katex: here('src/editor/katex-absent.js') } },
  build: {
    outDir: 'dist/ose',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // One stylesheet per entry that has one, under its own name, instead of one merged file.
    cssCodeSplit: true,
    modulePreload: false,
    rollupOptions: {
      input: ENTRIES,
      // Library entries, not app entries: every export must survive even though nothing in
      // this build imports it. Without this the bundler shakes an entry down to what
      // this build itself asks for, while the other bundles import the rest at run time.
      preserveEntrySignatures: 'strict',
      // The import map resolves these in the browser; the bundler must leave them alone.
      external: (id) => id.startsWith('ose:'),
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        // `ui.css`, `editor.css` and `planner.css` are named in the shell's links, so no hash here
        // either. Fonts and images, if a stylesheet ever pulls one in, go under assets/.
        assetFileNames: (info) => {
          const name = info.names ? info.names[0] : info.name;
          return /\.css$/.test(name || '') ? '[name][extname]' : 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
}));
