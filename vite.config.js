// The browser dev server. Two jobs, and they are the same job:
//
// 1. Serve the rice as plain files, exactly as the host serves `.ose/app`, so the stock
//    cockpit runs in Chrome against the Node bridge with no build step of its own. The root is
//    `cockpit/`; `OSE_RICE=<dir>` serves another rice.
// 2. Resolve the four `ose:*` specifiers to the kernel sources, so a rice file and a module
//    file are byte-for-byte the same in the browser and in the host. In the host these come
//    from the import map the kernel injects (docs/KERNEL.md); here they are aliases.
//
// `npm run dev` is 5173 against the real vault; `npm run dev:test` is 5174 against
// `work/vault` (dev/test-server.mjs). Both run this config. Building is
// vite.kernel.config.js's job (`npm run build`): the kernel bundles, the fallback page and the
// self-test page into dist-kernel/, which the host embeds.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { bridgePlugin } from './dev/bridge-plugin.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

// The two kernel stylesheets at the names the kernel origin serves them under. In the host
// the `<link data-ose>` hrefs are rewritten to `<kernel origin>/ui.css`; here the origin is
// the dev server itself, and Vite's SPA fallback would answer the page for any unknown path,
// so the two names are served as text/css: ui.css from its sources (the `@import`s inlined),
// editor.css from the last kernel build when there is one (the editor's own JS injects its
// styles in dev anyway, so a missing build only costs the link).
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
        if (body === null) return next();
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      });
    },
  };
}

/**
 * The two pages of the repo that are not the rice: the round-trip harness
 * (`src/editor/harness.html`, every vault file through the serialiser) and the kernel's
 * self-test (`selftest.html`, the page the host opens for `ose --selftest`).
 *
 * The dev root is the rice, so nothing under `src/` is reachable by its own path any more and
 * the SPA fallback answered the *rice's* index.html with a 200 — the harness loaded, looked
 * right and did nothing, because its module script was never served (QA-K defect 6). The
 * self-test page was in the same hole.
 *
 * So both are served here, from their source files, with their absolute `/src/...` URLs
 * rewritten to the `/@fs/` paths Vite serves anything outside the root under. A `.css` asked
 * for by its own path is a JS module to Vite (that is how CSS hot reload works); `?direct` is
 * the query that asks for the stylesheet itself, with its `@import`s inlined and `text/css` on
 * it, which is what a `<link>` needs. The self-test's own `./ui.css` is the kernel stylesheet
 * the middleware above already serves at `/ui.css`.
 */
function repoPages() {
  const root = here('.').split('\\').join('/').replace(/\/+$/, '');
  const PAGES = new Map([
    ['/harness', 'src/editor/harness.html'],
    ['/harness.html', 'src/editor/harness.html'],
    ['/src/editor/harness.html', 'src/editor/harness.html'],
    ['/selftest', 'selftest.html'],
    ['/selftest.html', 'selftest.html'],
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

const riceRoot = process.env.OSE_RICE || here('cockpit');

const alias = {
  'ose:kernel': here('src/kernel/kernel.js'),
  'ose:ui': here('src/kernel/ui.js'),
  'ose:md': here('src/kernel/md.js'),
  'ose:editor': here('src/editor/lib.js'),
};

export default defineConfig({
  base: './',
  root: riceRoot,
  resolve: { alias },
  define: { __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  plugins: [kernelStylesheets(), repoPages(), bridgePlugin()],
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1',
    // The rice may be a folder beside the repo; the kernel sources it imports are inside it.
    fs: { allow: [here('.'), riceRoot] },
    watch: { ignored: ['**/host/**', '**/dist-host/**', '**/legacy/**', '**/state.json', '**/node_modules/**', '**/ci/**', '**/src-tauri/target/**', '**/.trash/**', '**/work/vault/**'] },
  },
});
