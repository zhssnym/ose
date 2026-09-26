// The browser dev server. Two jobs, and they are the same job: be the exe, in Chrome.
//
// 1. Serve the shell as plain files, exactly as the exe serves what it embeds. The root is
//    `shell/`, so the page is `/index.html` and a shell file is `/<file>`.
// 2. Resolve the five `ose:*` specifiers to the kernel sources, so a shell file is
//    byte-for-byte the same in the browser and in the exe. In the exe these come from the
//    import map the host injects (docs/HOST.md); here they are aliases.
//
// `npm run dev` is 5173 against the configured vault; `npm run dev:test` is 5174 against a
// throwaway copy (dev/test-server.mjs). Both run this config. Building is
// vite.kernel.config.js's job (`npm run build`): the kernel bundles into dist-kernel/, which
// the exe embeds.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { bridgePlugin } from './dev/bridge-plugin.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const posix = (p) => p.split('\\').join('/');

// The three kernel stylesheets at the names the kernel origin serves them under. In the exe the
// `<link data-ose>` hrefs are rewritten to `<kernel origin>/ui.css`; here the origin is the dev
// server itself, and Vite's SPA fallback would answer the page for any unknown path, so the
// three names are served as text/css: ui.css from its sources (the `@import`s inlined),
// planner.css from its source the same way, editor.css from the last kernel build when there
// is one (the editor's own JS injects its styles in dev anyway, so a missing editor.css only
// costs the link).
function kernelStylesheets() {
  const inlineImports = (css, dir) => css.replace(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g, (_, rel) => {
    const file = here(dir + rel);
    return existsSync(file) ? inlineImports(readFileSync(file, 'utf8'), dir + rel.replace(/[^/]*$/, '')) : '';
  });
  return {
    name: 'ose-kernel-stylesheets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        let body = null;
        if (url === '/ui.css') body = inlineImports(readFileSync(here('src/kernel/ui.css'), 'utf8'), 'src/kernel/');
        else if (url === '/editor.css' && existsSync(here('dist-kernel/editor.css'))) body = readFileSync(here('dist-kernel/editor.css'), 'utf8');
        else if (url === '/editor.css') body = '/* editor.css comes from `npm run build`; in dev the editor injects its own styles */';
        else if (url === '/planner.css') body = inlineImports(readFileSync(here('src/planner/planner.css'), 'utf8'), 'src/planner/');
        if (body === null) return next();
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      });
    },
  };
}

/**
 * The one page of the repo that is not the shell: the round-trip harness
 * (`src/editor/harness.html`, every vault file through the serialiser).
 *
 * The dev root is the shell, so nothing under `src/` is reachable by its own path and the SPA
 * fallback answered the *shell's* index.html with a 200 — the harness loaded, looked right and
 * did nothing, because its module script was never served (QA-K defect 6). So it is served
 * here, from its source file, with its absolute `/src/...` URLs rewritten to the `/@fs/` paths
 * Vite serves anything outside the root under. A `.css` asked for by its own path is a JS
 * module to Vite (that is how CSS hot reload works); `?direct` is the query that asks for the
 * stylesheet itself, with its `@import`s inlined and `text/css` on it, which is what a `<link>`
 * needs.
 */
function repoPages() {
  const root = posix(here('.')).replace(/\/+$/, '');
  const PAGES = new Map([
    ['/harness', 'src/editor/harness.html'],
    ['/harness.html', 'src/editor/harness.html'],
    ['/src/editor/harness.html', 'src/editor/harness.html'],
  ]);
  return {
    name: 'ose-repo-pages',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const name = PAGES.get(url);
        if (!name || !existsSync(here(name))) return next();
        const html = readFileSync(here(name), 'utf8')
          .replace(/(href|src)="\/src\/([^"]+)"/g, (_, attr, rest) =>
            `${attr}="/@fs/${root}/src/${rest}${rest.endsWith('.css') ? '?direct' : ''}"`)
          .replace(/(href|src)="\.\/(ui|editor)\.css"/g, '$1="/$2.css"');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(html);
      });
    },
  };
}

const shellRoot = here('shell');

const alias = {
  'ose:kernel': here('src/kernel/kernel.js'),
  'ose:ui': here('src/kernel/ui.js'),
  'ose:editor': here('src/editor/lib.js'),
  'ose:planner': here('src/planner/index.js'),
};

export default defineConfig({
  base: './',
  root: shellRoot,
  resolve: { alias },
  define: { __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  plugins: [kernelStylesheets(), repoPages(), bridgePlugin()],
  // The editor and the planner load by dynamic import, from outside the root: named here so
  // Vite's dependency scan finds Milkdown, CodeMirror and date-fns at startup, instead of on
  // the first page opened, where the late optimisation reloads the window under the user (and
  // under a no-loss scenario).
  optimizeDeps: {
    entries: ['index.html', '../src/editor/lib.js', '../src/planner/index.js'],
  },
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1',
    // The no-loss suite (playwright.config.js sets OSE_E2E=1) drives pages that must not be
    // reloaded under it because someone saved a source file meanwhile.
    ...(process.env.OSE_E2E ? { hmr: false } : {}),
    // The kernel sources the shell imports, which are outside the root by definition.
    fs: { allow: [here('.')] },
    watch: { ignored: ['**/host/**', '**/dist-host/**', '**/legacy/**', '**/state.json', '**/node_modules/**', '**/ci/**', '**/src-tauri/target/**', '**/.trash/**', '**/work/v1/vault*/**'] },
  },
});
