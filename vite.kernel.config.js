// The kernel build (docs/KERNEL.md). `npm run build:kernel` emits `dist-kernel/`, which the
// Rust host embeds:
//
//   kernel.js  editor.js  ui.js  md.js      the four bundles the import map names
//   ui.css     editor.css                   the two stylesheets the shell links
//   shell/                                  the interface, copied verbatim from shell/
//   index.html                              the blank page the window opens on
//
// The `ose` origin serves the bundles; the `app` origin serves `shell/` (and the vault's
// plugins, which are never built and never embedded). The last two come from
// scripts/embed-shell.mjs, which the closeBundle hook below runs and which also runs by hand.
//
// Not an app build: nothing here is hashed, nothing is inlined into HTML, and the four entry
// file names are part of the contract — the host's import map spells them literally.
//
// Who imports whom. `ose:kernel` is the base and bundles everything with state in it: the
// registries, the bridge, the router, the key engine, the plugin loader, and the dialogs
// (there must be one overlay stack in a running Ose, not two). `ose:ui` is a facade that names
// those again from `ose:kernel`; `ose:editor` imports `ose:kernel` and `ose:ui`; `ose:md` is
// pure parsers and stands alone. So every `ose:*` specifier is **external** in every bundle,
// and nothing is bundled twice.

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { embedShell } from './scripts/embed-shell.mjs';

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

// Until `ose:editor` exists the other three still build, so neither package waits on the
// other; the build says which entries it emitted.
const ENTRIES = {
  kernel: here('src/kernel/kernel.js'),
  ui: here('src/kernel/ui.js'),
  md: here('src/kernel/md.js'),
  'ui.css': here('src/kernel/ui.css'),
};
if (existsSync(here('src/editor/lib.js'))) ENTRIES.editor = here('src/editor/lib.js');

const s = stamp();

/** The shell into `dist-kernel/shell/`, after the bundles, so one build makes the whole exe. */
function shellIntoTheBuild(outDir) {
  return {
    name: 'ose-embed-shell',
    closeBundle() {
      embedShell(outDir);
    },
  };
}

export default defineConfig({
  // Relative, because the page is served from `http://ose.localhost` on Windows and
  // `ose://localhost` on macOS and must not care which.
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
  plugins: [shellIntoTheBuild(here('dist-kernel'))],
  build: {
    outDir: 'dist-kernel',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // One stylesheet per entry that has one, under its own name, instead of one merged file.
    cssCodeSplit: true,
    modulePreload: false,
    rollupOptions: {
      input: ENTRIES,
      // Library entries, not app entries: every export must survive even though nothing in
      // this build imports it. Without this the bundler shakes `md.js` down to nothing,
      // because from inside the build no one asks for `parseTimetable`.
      preserveEntrySignatures: 'strict',
      // The import map resolves these in the browser; the bundler must leave them alone.
      external: (id) => id.startsWith('ose:'),
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        // `ui.css` and `editor.css` are named in the host's link rewrite, so no hash here
        // either. Fonts and images, if a stylesheet ever pulls one in, go under assets/.
        assetFileNames: (info) => {
          const name = info.names ? info.names[0] : info.name;
          return /\.css$/.test(name || '') ? '[name][extname]' : 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
