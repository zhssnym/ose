// The one Vite config of Ose: the page Tauri shows (src-tauri). The Rust host answers every
// host command.
//
//   npm run dev       `vite`: the shell served as plain files from `shell/`, the four `ose:*`
//                     specifiers aliased to their sources and the core stylesheets, on
//                     http://127.0.0.1:5173, which `npm run tauri dev` opens in the app window.
//   npm run build     `vite build`: the page in `dist/`, which `tauri build` bundles into the
//                     app. The core's four library bundles into `dist/ose/`, the shell copied
//                     verbatim beside them.
//
//   dist/index.html  dist/main.js  dist/boot.js  ...          the shell, copied from shell/
//   dist/ose/core.js  editor.js  views.js  ui.js  chunks/  the four bundles the import map names
//   dist/ose/ui.css  editor.css  views.css                   the three stylesheets the shell links
//
// The bundles are libraries, not an app build: the entry file names are part of the contract
// (the import map in shell/index.html spells them literally), so nothing but the chunks is
// hashed. Who imports whom: `ose:core` is the base and bundles everything with state in it
// (the registries, the bridge, the router, the tabs, the key engine, the dialogs: one overlay
// stack in a running Ose, not two). `ose:ui` is a facade that names those again from
// `ose:core`; `ose:editor` imports `ose:core` and `ose:ui`; `ose:views` imports `ose:ui`
// and, lazily, `ose:editor`, and is handed `ose` by the shell. So every `ose:*` specifier is
// external in every bundle, and nothing is bundled twice. date-fns is bundled into views.js,
// tree-shaken to what the planner uses.
//
// The tests (vitest.config.js) stand alone and do not load this file.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig } from 'vite';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const posix = (p) => p.split('\\').join('/');

/** The four `ose:*` specifiers, as the import map in shell/index.html names them. */
const ALIAS = {
  'ose:core': here('src/core/core.ts'),
  'ose:ui': here('src/ui/index.ts'),
  'ose:editor': here('src/editor/lib.ts'),
  'ose:views': here('src/views/index.ts'),
};

// See src/editor/katex-absent.ts: Crepe's unused Latex feature would drag KaTeX in.
const KATEX = { katex: here('src/editor/katex-absent.ts') };

/** The build's library entries: a missing source fails the build. */
const ENTRIES = {
  core: here('src/core/core.ts'),
  ui: here('src/ui/index.ts'),
  editor: here('src/editor/lib.ts'),
  views: here('src/views/index.ts'),
  'ui.css': here('src/ui/ui.css'),
};

/** The folder of the bundles inside the output; the shell must not have one. */
const BUNDLES = 'ose';

const FLAGS = {
  __VUE_OPTIONS_API__: 'false',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
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

/* ------------------------------------------------------------------ the build */

/**
 * `shell/` into `outDir`, verbatim: nothing bundled, hashed or rewritten on the way. A shell
 * file that would shadow the bundles is refused.
 * @param {string} outDir
 */
export function copyShell(outDir) {
  const from = here('shell');
  for (const name of [BUNDLES]) {
    if (existsSync(path.join(from, name))) throw new Error(`shell/${name} would shadow ${name} in ${outDir}`);
  }
  cpSync(from, outDir, { recursive: true });
}

/** After the bundles: the shell beside them. */
function shellIntoTheBuild() {
  let outDir = here('dist');
  return {
    name: 'ose-shell-build',
    // The directory this build really writes (`--outDir` on the command line included).
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    closeBundle() { copyShell(outDir); },
  };
}

/* ------------------------------------------------------------------------- the dev server */

// The three core stylesheets, at the paths the shell's links name: `/ose/ui.css`,
// `/ose/editor.css` and `/ose/views.css` (shell/index.html). Vite's SPA fallback would answer
// the page for any unknown path, so the three are answered here as text/css: ui.css and
// views.css from their sources with their relative `@import`s inlined, editor.css as a list of
// `@import`s of every stylesheet the editor's modules import, in the order they run, each one
// through Vite's own CSS pipeline (`?direct`, which resolves bare `@import`s and answers the
// stylesheet itself). The editor's JS injects the same rules in dev anyway, so the link only has
// to be right, not first.
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
    await visit(here('src/editor/lib.ts'));
    return sheets.map((id) => `@import url("/@fs/${posix(id).replace(/^\/+/, '').split('?')[0]}?direct");`).join('\n');
  };
  const sheet = async (name) => {
    if (name === 'ui.css') return inlineImports(readFileSync(here('src/ui/ui.css'), 'utf8'), 'src/ui/');
    if (name === 'views.css') return inlineImports(readFileSync(here('src/views/views.css'), 'utf8'), 'src/views/');
    if (name === 'editor.css') return editorSheets();
    return null;
  };
  return {
    name: 'ose-core-stylesheets',
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

/* ---------------------------------------------------------------------------- the config */

export default defineConfig(({ command }) => {
  if (command === 'serve') {
    return {
      base: './',
      root: here('shell'),
      publicDir: false,
      resolve: { alias: { ...ALIAS, ...KATEX } },
      define: { ...FLAGS },
      plugins: [kernelStylesheets()],
      // The editor and the planner load by dynamic import, from outside the root: named here so
      // Vite's dependency scan finds Milkdown, CodeMirror and date-fns at startup, instead of on
      // the first page opened, where the late optimisation reloads the window under the user
      // (and under a no-loss scenario).
      optimizeDeps: {
        entries: ['index.html', '../src/editor/lib.ts', '../src/views/index.ts'],
      },
      server: {
        port: 5173,
        strictPort: true,
        host: '127.0.0.1',
        // The core sources the shell imports, which are outside the root by definition.
        fs: { allow: [here('.')] },
        watch: { ignored: ['**/node_modules/**', '**/dist/**', '**/work/**', '**/src-tauri/**'] },
      },
    };
  }

  // `vite build`.
  const s = stamp();
  return {
    base: './',
    root: here('.'),
    publicDir: false,
    define: {
      __OSE_VERSION__: JSON.stringify(s.version),
      __OSE_SHA__: JSON.stringify(s.sha),
      __OSE_SHORT__: JSON.stringify(s.short),
      __OSE_DATE__: JSON.stringify(s.date),
      ...FLAGS,
    },
    plugins: [shellIntoTheBuild()],
    resolve: { alias: KATEX },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      // One stylesheet per entry that has one, under its own name, instead of one merged file.
      cssCodeSplit: true,
      modulePreload: false,
      rollupOptions: {
        input: ENTRIES,
        // Library entries, not app entries: every export must survive even though nothing in
        // this build imports it. Without this the bundler shakes an entry down to what this
        // build itself asks for, while the other bundles import the rest at run time.
        preserveEntrySignatures: 'strict',
        // The import map resolves these in the browser; the bundler must leave them alone.
        external: (id) => id.startsWith('ose:'),
        output: {
          format: 'es',
          entryFileNames: `${BUNDLES}/[name].js`,
          chunkFileNames: `${BUNDLES}/chunks/[name]-[hash].js`,
          // `ui.css`, `editor.css` and `views.css` are named in the shell's links, so no hash
          // here either. Fonts and images, if a stylesheet ever pulls one in, go under assets/.
          assetFileNames: (info) => {
            const name = info.names ? info.names[0] : info.name;
            return /\.css$/.test(name || '') ? `${BUNDLES}/[name][extname]` : `${BUNDLES}/assets/[name]-[hash][extname]`;
          },
        },
      },
    },
  };
});
