// Copies `shell/` into `dist/`, beside the kernel bundles in `dist/ose/`: the standard layout
// (CONTRACT X4). Tauri embeds everything under `frontendDist` (`../dist`) and serves it from its
// own asset protocol, so `dist/index.html` is the page the window opens, and a shell file is
// `dist/<file>`. Nothing is bundled, hashed or rewritten on the way: what is in `shell/` is what
// the window gets. The import map and the stylesheet links are literal in `shell/index.html`, and
// Tauri hashes the import map into the CSP at build time.
//
// Run by the kernel build (vite.kernel.config.js, closeBundle) and by hand, after a change to the
// shell alone:
//
//   node scripts/copy-shell.mjs            # into dist/
//   node scripts/copy-shell.mjs <outDir>
//
// Everything in the output folder except `ose/` is removed first, so a file deleted from shell/
// does not live on inside the executable. The bundles are the build's; this never touches them.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The folder the bundles live in, inside the output: never removed, never overwritten. */
const BUNDLES = 'ose';

/**
 * `shell/` into `outDir`, verbatim, leaving `outDir/ose/` alone. Answers the number of files.
 * A `shell/ose` entry would shadow the bundles, so it is refused.
 * @param {string} [outDir]
 * @returns {number}
 */
export function copyShell(outDir = path.join(repoRoot, 'dist')) {
  const from = path.join(repoRoot, 'shell');
  if (!existsSync(from)) throw new Error(`no shell folder at ${from}`);
  if (existsSync(path.join(from, BUNDLES))) throw new Error(`shell/${BUNDLES} would shadow the kernel bundles in ${outDir}/${BUNDLES}`);

  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    if (name === BUNDLES) continue;
    rmSync(path.join(outDir, name), { recursive: true, force: true });
  }
  cpSync(from, outDir, { recursive: true });

  const files = count(from);
  console.log(`copied ${files.n} shell files (${(files.bytes / 1024).toFixed(0)} KB) into ${outDir}`);
  return files.n;
}

/** Files and bytes under `dir`. */
function count(dir) {
  let n = 0;
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      const inner = count(full);
      n += inner.n;
      bytes += inner.bytes;
    } else {
      n += 1;
      bytes += st.size;
    }
  }
  return { n, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  copyShell(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
}
