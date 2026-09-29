// Ose Web (docs/WEB.md): the same app in Chrome over a folder on this machine, as an installable
// offline PWA. Two commands, one config:
//
//   npm run build:web   `vite build`: the kernel's four bundles exactly as vite.kernel.config.js
//                       makes them, with `__OSE_WEB__` true, into `dist-web/ose/`; the shell
//                       copied beside them (scripts/copy-shell.mjs); then the web's own files:
//                       `sw.js` (src/web/sw.js with the precache list and the build id written
//                       into it), `manifest.webmanifest` (web/), `icons/` (from src-tauri/icons)
//                       and a `<link rel="manifest">` added to `dist-web/index.html`. The
//                       shell's own index.html is not edited.
//   npm run dev:web     `vite`: the dev server of vite.config.js (the shell as plain files, the
//                       `ose:*` aliases, the kernel stylesheets) without the Node bridge, with
//                       `__OSE_WEB__` true, on http://localhost:5175, serving the worker (with
//                       no precache: dev stays on the network), the manifest and the icons.
//                       Chrome allows the File System Access API on localhost, so no certificate.
//
// Hosting `dist-web/` on any static HTTPS origin is the whole deployment (.github/workflows/
// pages.yml puts it on GitHub Pages). Every URL in it is relative, so it works under a subpath.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyShell } from './scripts/copy-shell.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const OUT = here('dist-web');
const PORT = Number(process.env.OSE_WEB_PORT || 5175);

/** The icons the manifest names, from the app's own icon set. */
const ICONS = [
  ['icons/icon-256.png', 'src-tauri/icons/128x128@2x.png'],
  ['icons/icon-512.png', 'src-tauri/icons/icon.png'],
];

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

/** `<link rel="manifest">` into the built page, once, before `</head>`. @param {string} html */
export function withManifestLink(html) {
  if (/rel="manifest"/.test(html)) return html;
  return html.replace('</head>', '<link rel="manifest" href="./manifest.webmanifest">\n</head>');
}

/** After the bundles: the shell, the manifest, the icons, the page's link, then the worker. */
function webIntoTheBuild() {
  let outDir = path.join(OUT, 'ose');
  return {
    name: 'ose-web-build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    closeBundle() {
      const top = path.dirname(outDir);
      copyShell(top);
      copyFileSync(here('web/manifest.webmanifest'), path.join(top, 'manifest.webmanifest'));
      for (const [to, from] of ICONS) {
        mkdirSync(path.dirname(path.join(top, to)), { recursive: true });
        copyFileSync(here(from), path.join(top, to));
      }
      const page = path.join(top, 'index.html');
      writeFileSync(page, withManifestLink(readFileSync(page, 'utf8')));
      const files = filesUnder(top).filter((f) => f !== 'sw.js');
      const { build, source } = workerSource(files, top);
      writeFileSync(path.join(top, 'sw.js'), source);
      console.log(`ose web: ${files.length} files precached, build ${build}, in ${top}`);
    },
  };
}

/** The dev server's answers for what the shell folder does not have. */
function webDevAssets() {
  const types = { '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
  const map = new Map([
    ['/sw.js', here('src/web/sw.js')],
    ['/manifest.webmanifest', here('web/manifest.webmanifest')],
    ...ICONS.map(([to, from]) => /** @type {[string, string]} */ ([`/${to}`, here(from)])),
  ]);
  return {
    name: 'ose-web-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const file = map.get(url);
        if (!file || !existsSync(file)) return next();
        res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        if (url === '/sw.js') res.setHeader('Service-Worker-Allowed', '/');
        res.end(readFileSync(file));
      });
    },
    transformIndexHtml(html) { return withManifestLink(html); },
  };
}

export default async (/** @type {{ command: string, mode: string }} */ env) => {
  if (env.command === 'serve') {
    // vite.config.js leaves the Node bridge out when this is set (its `tauri dev` switch): the
    // web build has no server behind it. Set only while that module is evaluated.
    const had = process.env.TAURI_ENV_PLATFORM;
    process.env.TAURI_ENV_PLATFORM = had || 'web';
    const dev = (await import('./vite.config.js')).default;
    if (had === undefined) delete process.env.TAURI_ENV_PLATFORM;
    return {
      ...dev,
      define: { ...(dev.define || {}), __OSE_WEB__: 'true' },
      plugins: [...(dev.plugins || []).filter((p) => p && p.name !== 'os-dev-bridge'), webDevAssets()],
      server: { ...(dev.server || {}), port: PORT, host: 'localhost', strictPort: true },
    };
  }
  const kernel = (await import('./vite.kernel.config.js')).default;
  const base = typeof kernel === 'function' ? await kernel(env) : kernel;
  return {
    ...base,
    define: { ...(base.define || {}), __OSE_WEB__: 'true' },
    plugins: [...(base.plugins || []).filter((p) => p && p.name !== 'ose-copy-shell'), webIntoTheBuild()],
    build: { ...base.build, outDir: 'dist-web/ose', emptyOutDir: true },
  };
};
