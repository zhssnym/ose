// The one Vite config of Ose Web (docs/WEB.md): the app in Chrome over a folder on this machine,
// an installable offline PWA. The browser is the only host; src/web/adapter.js answers every
// host command over the File System Access API.
//
//   npm run dev       `vite`: the shell served as plain files from `shell/`, the four `ose:*`
//                     specifiers aliased to their sources, the kernel stylesheets, the service
//                     worker (with no precache: dev stays on the network), the manifest and the
//                     icons, on http://localhost:5173. Chrome allows the File System Access API
//                     on localhost, so no certificate. `vite --port <n>` picks another port.
//   npm run build     `vite build`: the deployable site in `dist/`. The kernel's four library
//                     bundles into `dist/ose/`, the shell copied verbatim beside them, the web's
//                     public files (`web/`: the manifest and the icons), a `<link rel="manifest">`
//                     and the Content-Security-Policy `<meta>` added to `dist/index.html` (the
//                     shell's own index.html is not edited), and last `dist/sw.js`, src/web/sw.js
//                     with the precache list and the build id written into it.
//   npm run preview   `vite preview`: `dist/` as a static host serves it.
//
// Hosting `dist/` on any static HTTPS origin is the whole deployment (Vercel builds and serves
// it, vercel.json). Every URL in it is relative, so it works under a subpath too.
//
//   dist/index.html  dist/main.js  dist/boot.js  ...          the shell, copied from shell/
//   dist/ose/kernel.js  editor.js  planner.js  ui.js  chunks/  the four bundles the import map names
//   dist/ose/ui.css  editor.css  planner.css                   the three stylesheets the shell links
//   dist/manifest.webmanifest  dist/icons/  dist/sw.js          the PWA
//
// The bundles are libraries, not an app build: the entry file names are part of the contract
// (the import map in shell/index.html spells them literally), so nothing but the chunks is
// hashed. Who imports whom: `ose:kernel` is the base and bundles everything with state in it
// (the registries, the bridge, the router, the tabs, the key engine, the dialogs: one overlay
// stack in a running Ose, not two). `ose:ui` is a facade that names those again from
// `ose:kernel`; `ose:editor` imports `ose:kernel` and `ose:ui`; `ose:planner` imports `ose:ui`
// and, lazily, `ose:editor`, and is handed `ose` by the shell. So every `ose:*` specifier is
// external in every bundle, and nothing is bundled twice. date-fns is bundled into planner.js,
// tree-shaken to what the planner uses.
//
// The tests (vitest.config.js) stand alone and do not load this file, except for the pure
// helpers exported below (tests/web/adapter.test.js).

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig } from 'vite';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const posix = (p) => p.split('\\').join('/');

/** The four `ose:*` specifiers, as the import map in shell/index.html names them. */
const ALIAS = {
  'ose:kernel': here('src/kernel/kernel.js'),
  'ose:ui': here('src/kernel/ui.js'),
  'ose:editor': here('src/editor/lib.js'),
  'ose:planner': here('src/planner/index.js'),
};

// See src/editor/katex-absent.js: Crepe's unused Latex feature would drag KaTeX in.
const KATEX = { katex: here('src/editor/katex-absent.js') };

/** The build's library entries: a missing source fails the build. */
const ENTRIES = {
  kernel: here('src/kernel/kernel.js'),
  ui: here('src/kernel/ui.js'),
  editor: here('src/editor/lib.js'),
  planner: here('src/planner/index.js'),
  'ui.css': here('src/kernel/ui.css'),
};

/** The folder of the bundles inside the output; the shell must not have one. */
const BUNDLES = 'ose';

/** The web's public files (the manifest, the icons): served in dev, copied into the build. */
const PUBLIC = here('web');

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

/* ------------------------------------------------------------------ the web build's helpers */

/** The marker line in src/web/sw.js the build fills in. */
const MARKER = /\/\* @ose-manifest \*\/ const MANIFEST = null;/;

/** Every file under `dir`, relative, with forward slashes. @param {string} dir @returns {string[]} */
function filesUnder(dir, at = '') {
  const out = [];
  for (const name of readdirSync(path.join(dir, at)).sort()) {
    const rel = at ? `${at}/${name}` : name;
    if (statSync(path.join(dir, rel)).isDirectory()) out.push(...filesUnder(dir, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * The worker with its precache list and build id: the id is a hash of every file it caches, so
 * any change to the app is a new cache, and an unchanged build keeps the one it has.
 * @param {string[]} files @param {string} outDir
 */
export function workerSource(files, outDir) {
  const h = createHash('sha256');
  for (const f of files) { h.update(f); h.update('\0'); h.update(readFileSync(path.join(outDir, f))); }
  const build = h.digest('hex').slice(0, 16);
  const src = readFileSync(here('src/web/sw.js'), 'utf8');
  if (!MARKER.test(src)) throw new Error('src/web/sw.js has lost its `/* @ose-manifest */` line');
  return { build, source: src.replace(MARKER, `const MANIFEST = ${JSON.stringify({ build, files })};`) };
}

/** `<link rel="manifest">` into the page, once, before `</head>`. @param {string} html */
export function withManifestLink(html) {
  if (/rel="manifest"/.test(html)) return html;
  return html.replace('</head>', '<link rel="manifest" href="./manifest.webmanifest">\n</head>');
}

/**
 * The page's policy, as a `<meta>` (a static host sends no header). `vault/` is on this origin,
 * so `'self'` holds it; the one inline script, the import map, is allowed by its hash. No host
 * but this one is named anywhere: the page reaches no network of its own.
 * @param {string[]} inlineHashes `'sha256-…'` of every inline script
 */
export function webCsp(inlineHashes) {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineHashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** The policy into the built page, first thing in `<head>` after the charset, so it covers the
 *  import map; once. @param {string} html */
export function withCsp(html) {
  if (/http-equiv="Content-Security-Policy"/i.test(html)) return html;
  const hashes = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    hashes.push(`'sha256-${createHash('sha256').update(m[1] || '').digest('base64')}'`);
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${webCsp(hashes)}">`;
  const charset = /<meta charset="[^"]*">\n?/i.exec(html);
  if (charset) return html.replace(charset[0], `${charset[0].replace(/\n?$/, '\n')}${meta}\n`);
  return html.replace('<head>', `<head>\n${meta}`);
}

/**
 * `shell/` into `outDir`, verbatim: nothing bundled, hashed or rewritten on the way. A shell
 * file that would shadow the bundles, the worker or a public file is refused.
 * @param {string} outDir
 */
export function copyShell(outDir) {
  const from = here('shell');
  const reserved = [BUNDLES, 'sw.js', ...readdirSync(PUBLIC)];
  for (const name of reserved) {
    if (existsSync(path.join(from, name))) throw new Error(`shell/${name} would shadow ${name} in ${outDir}`);
  }
  cpSync(from, outDir, { recursive: true });
}

/** After the bundles: the shell, the page's manifest link and policy, then the worker. */
function webIntoTheBuild() {
  let outDir = here('dist');
  return {
    name: 'ose-web-build',
    // The directory this build really writes (`--outDir` on the command line included), so a
    // check build somewhere else never rewrites the real output.
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    closeBundle() {
      copyShell(outDir);
      const page = path.join(outDir, 'index.html');
      writeFileSync(page, withCsp(withManifestLink(readFileSync(page, 'utf8'))));
      const files = filesUnder(outDir).filter((f) => f !== 'sw.js');
      const { build, source } = workerSource(files, outDir);
      writeFileSync(path.join(outDir, 'sw.js'), source);
      console.log(`ose web: ${files.length} files precached, build ${build}, in ${outDir}`);
    },
  };
}

/* ------------------------------------------------------------------------- the dev server */

// The three kernel stylesheets, at the paths the shell's links name: `/ose/ui.css`,
// `/ose/editor.css` and `/ose/planner.css` (shell/index.html). Vite's SPA fallback would answer
// the page for any unknown path, so the three are answered here as text/css: ui.css and
// planner.css from their sources with their relative `@import`s inlined, editor.css as a list of
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
 * fallback would answer the shell's index.html. So it is served here, from its source file,
 * with its absolute `/src/...` URLs rewritten to the `/@fs/` paths Vite serves anything outside
 * the root under. A `.css` asked for by its own path is a JS module to Vite; `?direct` asks for
 * the stylesheet itself, which is what a `<link>` needs.
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

/** The worker in dev, as its source (no precache), and the manifest link into the page. */
function webDevAssets() {
  return {
    name: 'ose-web-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (url !== '/sw.js') return next();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Service-Worker-Allowed', '/');
        res.end(readFileSync(here('src/web/sw.js')));
      });
    },
    transformIndexHtml(html) { return withManifestLink(html); },
  };
}

/* ---------------------------------------------------------------------------- the config */

export default defineConfig(({ command, isPreview }) => {
  if (command === 'serve' && !isPreview) {
    return {
      base: './',
      root: here('shell'),
      publicDir: PUBLIC,
      resolve: { alias: { ...ALIAS, ...KATEX } },
      define: { ...FLAGS },
      plugins: [kernelStylesheets(), repoPages(), webDevAssets()],
      // The editor and the planner load by dynamic import, from outside the root: named here so
      // Vite's dependency scan finds Milkdown, CodeMirror and date-fns at startup, instead of on
      // the first page opened, where the late optimisation reloads the window under the user
      // (and under a no-loss scenario).
      optimizeDeps: {
        entries: ['index.html', '../src/editor/lib.js', '../src/planner/index.js'],
      },
      server: {
        port: 5173,
        strictPort: true,
        host: 'localhost',
        // An end-to-end scenario (OSE_E2E=1) drives pages that must not be reloaded under it
        // because someone saved a source file meanwhile.
        ...(process.env.OSE_E2E ? { hmr: false } : {}),
        // The kernel sources the shell imports, which are outside the root by definition.
        fs: { allow: [here('.')] },
        watch: { ignored: ['**/node_modules/**', '**/dist/**', '**/work/**', '**/test-results/**', '**/.trash/**'] },
      },
    };
  }

  // `vite build`, and `vite preview`, which serves what the build wrote (`build.outDir`).
  const s = stamp();
  return {
    // Relative: the page must not care which origin, or which subpath, serves it.
    base: './',
    root: here('.'),
    publicDir: PUBLIC,
    define: {
      __OSE_VERSION__: JSON.stringify(s.version),
      __OSE_SHA__: JSON.stringify(s.sha),
      __OSE_SHORT__: JSON.stringify(s.short),
      __OSE_DATE__: JSON.stringify(s.date),
      ...FLAGS,
    },
    plugins: [webIntoTheBuild()],
    resolve: { alias: KATEX },
    preview: { port: 4173, strictPort: true, host: 'localhost' },
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
          // `ui.css`, `editor.css` and `planner.css` are named in the shell's links, so no hash
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
