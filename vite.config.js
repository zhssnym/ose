// The browser dev server. Three jobs, and they are the same job: be the exe, in Chrome.
//
// 1. Serve the shell as plain files, exactly as the exe serves what it embeds. The root is
//    `shell/`, so the page is `/index.html` and a shell file is `/<file>`.
// 2. Serve `/plugins/<id>/<file>` from `<vault>/.ose/plugins/<id>/<file>`, which is where the
//    exe serves a plugin from, and never from a cache.
// 3. Resolve the four `ose:*` specifiers to the kernel sources, so a shell file and a plugin
//    file are byte-for-byte the same in the browser and in the exe. In the exe these come from
//    the import map the kernel injects (docs/KERNEL.md); here they are aliases.
//
// `npm run dev` is 5173 against the configured vault; `npm run dev:test` is 5174 against a
// throwaway copy (dev/test-server.mjs). Both run this config. Building is
// vite.kernel.config.js's job (`npm run build`): the kernel bundles into dist-kernel/, which
// the exe embeds.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { bridgePlugin } from './dev/bridge-plugin.mjs';
import { vaultRoot } from './dev/root.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const posix = (p) => p.split('\\').join('/');

// The two kernel stylesheets at the names the kernel origin serves them under. In the exe the
// `<link data-ose>` hrefs are rewritten to `<kernel origin>/ui.css`; here the origin is the dev
// server itself, and Vite's SPA fallback would answer the page for any unknown path, so the
// two names are served as text/css: ui.css from its sources (the `@import`s inlined),
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
 * `/plugins/**` — the hard part of being the exe in a browser.
 *
 * A plugin lives in the vault, outside this server's root, and imports `ose:ui`, `ose:md`,
 * `ose:editor` and `../_lib/`. In the exe an import map resolves the `ose:*` specifiers; here
 * the aliases do, and an alias only applies to a file Vite transforms. So a plugin's JavaScript
 * is not read and sent: the request is rewritten to the `/@fs/<absolute path>` URL Vite serves
 * anything outside the root under, and handed to Vite's own pipeline, which resolves every
 * specifier in it to exactly the URL the shell's own imports resolve to. One `ose:kernel`
 * module in the page, one `ose` object, one overlay stack — the same guarantee the exe gives.
 * Everything else (a stylesheet the loader links, a Python script, an image) is bytes.
 *
 * The folder is followed to its real path first: a test vault reaches the repo's `plugins/`
 * through a junction, and two paths for one file would be two module graphs.
 */
function vaultPlugins(dir) {
  const MIME = {
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.py': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  };
  return {
    name: 'ose-vault-plugins',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [urlPath, query] = (req.url || '').split('?');
        if (!urlPath.startsWith('/plugins/')) return next();
        let rel;
        try { rel = decodeURIComponent(urlPath.slice('/plugins/'.length)); } catch { rel = ''; }
        const file = path.resolve(dir, rel);
        // A `..` in the URL is the only way out of the folder, and there is no way out.
        if (!rel || (file !== dir && !file.startsWith(dir + path.sep))) { res.statusCode = 403; res.end('outside the plugins folder'); return; }
        if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end('no such plugin file'); return; }
        const ext = path.extname(file).toLowerCase();
        if (ext !== '.js' && ext !== '.mjs') {
          res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          res.end(readFileSync(file));
          return;
        }
        // Vite answers a transformed module with `no-cache` and an ETag; a plugin is a file the
        // user is editing, so nothing about it is ever taken from a cache.
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) => setHeader(name, /^cache-control$/i.test(name) ? 'no-store' : value);
        req.url = `/@fs/${posix(file)}${query ? `?${query}` : ''}`;
        next();
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
// The vault's plugins folder, followed through any junction. A vault with none is still a
// vault: the folder is simply never there and every request under `/plugins/` is a 404.
const pluginsDir = path.join(vaultRoot(), '.ose', 'plugins');
const pluginsReal = existsSync(pluginsDir) ? realpathSync(pluginsDir) : pluginsDir;

const alias = {
  'ose:kernel': here('src/kernel/kernel.js'),
  'ose:ui': here('src/kernel/ui.js'),
  'ose:md': here('src/kernel/md.js'),
  'ose:editor': here('src/editor/lib.js'),
};

export default defineConfig({
  base: './',
  root: shellRoot,
  resolve: { alias },
  define: { __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  plugins: [kernelStylesheets(), vaultPlugins(pluginsReal), repoPages(), bridgePlugin()],
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1',
    // The kernel sources the shell imports, and the plugins folder of the vault being served,
    // which is where `/plugins/**` reads from and is outside the root by definition.
    fs: { allow: [here('.'), pluginsDir, pluginsReal] },
    watch: { ignored: ['**/host/**', '**/dist-host/**', '**/legacy/**', '**/state.json', '**/node_modules/**', '**/ci/**', '**/src-tauri/target/**', '**/.trash/**', '**/work/v1/vault*/**'] },
  },
});
