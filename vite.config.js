// The browser dev server. Two jobs, and they are the same job: be the exe, in Chrome.
//
// 1. Serve the shell as plain files, exactly as the exe serves what it embeds. The root is
//    `shell/`, so the page is `/index.html` and a shell file is `/<file>`.
// 2. Resolve the four `ose:*` specifiers to the kernel sources, so a shell file is
//    byte-for-byte the same in the browser and in the exe. In the exe these come from the
//    import map in `shell/index.html`; here they are aliases, and the import map is inert,
//    because Vite rewrites the aliased imports before the browser sees them.
//
// `npm run dev` is 5173 against the configured vault, and it is also the `devUrl` that
// `tauri dev` opens (tauri.conf.json), in which case the dev bridge stays off; `npm run dev:test`
// is 5174 against a throwaway copy (dev/test-server.mjs). Both run this config. Building is
// vite.kernel.config.js's job (`npm run build`).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig } from 'vite';
import { bridgePlugin } from './dev/bridge-plugin.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const posix = (p) => p.split('\\').join('/');

// The three kernel stylesheets, at the paths the shell's links name: `/ose/ui.css`,
// `/ose/editor.css` and `/ose/planner.css` (shell/index.html, CONTRACT §5.4). Vite's SPA fallback
// would answer the page for any unknown path, so the three are answered here as text/css:
// ui.css and planner.css from their sources with their relative `@import`s inlined, editor.css
// as a list of `@import`s of every stylesheet the editor's modules import, in the order they run,
// each one through Vite's own CSS pipeline (`?direct`, which resolves bare `@import`s and
// answers the stylesheet itself). The editor's JS injects the same rules in dev anyway, so the
// link only has to be right, not first.
function kernelStylesheets() {
  const inlineImports = (css, dir) => css.replace(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g, (_, rel) => {
    const file = here(dir + rel);
    return existsSync(file) ? inlineImports(readFileSync(file, 'utf8'), dir + rel.replace(/[^/]*$/, '')) : '';
  });
  /** @type {import('vite').ViteDevServer | null} */
  let dev = null;
  // Every `import '…'`, `import('…')` and `export … from '…'` of a module, in source order.
  const IMPORT = /\b(?:import|export)\s*(?:[\w*{}\s,$]+\sfrom\s*)?\(?\s*['"]([^'"]+)['"]/g;
  /** The stylesheets the editor's modules import, depth first in execution order. */
  const editorSheets = async () => {
    const seen = new Set();
    const sheets = [];
    const visit = async (file) => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const [, spec] of src.matchAll(IMPORT)) {
        if (spec.startsWith('ose:')) continue;
        if (/\.css$/.test(spec)) {
          const r = await dev.pluginContainer.resolveId(spec, file).catch(() => null);
          const id = r && (typeof r === 'string' ? r : r.id);
          if (id && !sheets.includes(id)) sheets.push(id);
        } else if (spec.startsWith('.')) {
          await visit(fileURLToPath(new URL(spec, pathToFileURL(file))));
        }
      }
    };
    await visit(here('src/editor/lib.js'));
    return sheets.map((id) => `@import url("/@fs/${posix(id).replace(/^\/+/, '').split('?')[0]}?direct");`).join('\n');
  };
  const sheet = async (name) => {
    if (name === 'ui.css') return inlineImports(readFileSync(here('src/kernel/ui.css'), 'utf8'), 'src/kernel/');
    if (name === 'planner.css') return inlineImports(readFileSync(here('src/planner/planner.css'), 'utf8'), 'src/planner/');
    if (name === 'editor.css') return editorSheets();
    return null;
  };
  return {
    name: 'ose-kernel-stylesheets',
    configureServer(server) {
      dev = server;
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const m = /^\/ose\/(ui|editor|planner)\.css$/.exec(url);
        if (!m) return next();
        try {
          const body = await sheet(`${m[1]}.css`);
          if (body === null) return next();
          res.setHeader('Content-Type', 'text/css; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        } catch (e) {
          next(e);
        }
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
  define: { __OSE_WEB__: 'false', __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  // The dev bridge is the Node host for a browser. Under `tauri dev` the page talks to the real
  // host, and a second watcher on the vault would only cost (CONTRACT F11).
  plugins: [kernelStylesheets(), repoPages(), ...(process.env.TAURI_ENV_PLATFORM ? [] : [bridgePlugin()])],
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
