// The one Vite config of Ose: the page Tauri shows (src-tauri). The Rust host answers every
// host command.
//
//   npm run dev       `vite`: index.html and src/ served on http://127.0.0.1:5173, which
//                     `tauri dev` opens in the app window.
//   npm run build     `vite build`: the page in `dist/`, which `tauri build` bundles into the app.
//
// One app build: index.html loads src/shell/main.ts, and everything else is reached from there.
// The editor and the views load by dynamic import, so they are chunks of their own and the
// first paint does not wait for Milkdown or CodeMirror.
//
// The tests (vitest.config.js) stand alone and do not load this file.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

const ALIAS = {
  // See src/editor/katex-absent.ts: Crepe's unused Latex feature would drag KaTeX in.
  katex: here('src/editor/katex-absent.ts'),
};

/** The build stamp: the package version, the commit and its date. */
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

export default defineConfig(() => {
  const s = stamp();
  return {
    base: './',
    root: here('.'),
    publicDir: false,
    resolve: { alias: ALIAS },
    define: {
      __OSE_VERSION__: JSON.stringify(s.version),
      __OSE_SHA__: JSON.stringify(s.sha),
      __OSE_SHORT__: JSON.stringify(s.short),
      __OSE_DATE__: JSON.stringify(s.date),
      __VUE_OPTIONS_API__: 'false',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    // The editor and the views load by dynamic import: named here so Vite's dependency scan
    // finds Milkdown, CodeMirror and date-fns at startup, instead of on the first page opened,
    // where the late optimisation would reload the window under the user.
    optimizeDeps: {
      entries: ['index.html', 'src/editor/lib.ts', 'src/views/index.ts'],
    },
    server: {
      port: 5173,
      strictPort: true,
      host: '127.0.0.1',
      watch: { ignored: ['**/node_modules/**', '**/dist/**', '**/src-tauri/**', '**/tests/**'] },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      modulePreload: false,
    },
  };
});
