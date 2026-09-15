// The kernel build (docs/KERNEL.md). `npm run build:kernel` emits `dist-kernel/`, which the
// Rust host embeds and serves from the `ose` origin:
//
//   kernel.js  editor.js  ui.js  md.js      the four bundles the import map names
//   ui.css     editor.css                   the two stylesheets the rice links
//   index.html                              the fallback page (no rice in this vault)
//   selftest.html  selftest.js              the page `ose --selftest` navigates to
//
// Not an app build: nothing here is hashed, nothing is inlined into HTML, and the four entry
// file names are part of the contract — the host's import map spells them literally.
//
// Who imports whom. `ose:kernel` is the base and bundles everything with state in it: the
// registries, the bridge, the router, the key engine, the module loader, and the dialogs
// (there must be one overlay stack in a running Ose, not two). `ose:ui` is a facade that names
// those again from `ose:kernel`; `ose:editor` is K1c's and imports `ose:kernel` and `ose:ui`;
// `ose:md` is pure parsers and stands alone. So every `ose:*` specifier is **external** in
// every bundle, and nothing is bundled twice.

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

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

// `ose:editor` is K1c's entry. Until it exists the other three still build, so neither package
// waits on the other; the build says which entries it emitted.
const ENTRIES = {
  kernel: here('src/kernel/kernel.js'),
  ui: here('src/kernel/ui.js'),
  md: here('src/kernel/md.js'),
  'ui.css': here('src/kernel/ui.css'),
  index: here('src/kernel/fallback.html'),   // emitted as dist-kernel/index.html, see renameFallback
  selftest: here('selftest.html'),
};
if (existsSync(here('src/editor/lib.js'))) ENTRIES.editor = here('src/editor/lib.js');

const s = stamp();

/**
 * An HTML input is emitted under its path relative to the project root, so the fallback page
 * lands at `dist-kernel/src/kernel/fallback.html`. The host asks for
 * `<kernel origin>/index.html` (docs/RICE.md step 3), so it is moved after the write: the
 * bundle's own asset records are read-only here, and a copy of the page at the repo root
 * would be a second file to keep in step. Its links were written one folder deep, so `../../`
 * becomes `./` on the way.
 */
function renameFallback(outDir) {
  return {
    name: 'ose-fallback-at-root',
    closeBundle() {
      const from = path.join(outDir, 'src', 'kernel', 'fallback.html');
      if (!existsSync(from)) return;
      const html = readFileSync(from, 'utf8').split('../../').join('./');
      writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
      rmSync(path.join(outDir, 'src'), { recursive: true, force: true });
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
  plugins: [renameFallback(here('dist-kernel'))],
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
