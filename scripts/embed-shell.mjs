// Copies `shell/` into the kernel build so the interface travels inside the executable.
//
// Tauri embeds everything under `frontendDist` (dist-kernel/, tauri.conf.json), so the shell
// lands at `dist-kernel/shell/` and the `app` origin serves it from there. Nothing is bundled,
// hashed or rewritten on the way: what is in `shell/` is what the window gets, which is what
// makes `--shell <dir>` and the embedded copy the same thing.
//
// Run by the kernel build (vite.kernel.config.js, closeBundle) and by hand:
//
//   node scripts/embed-shell.mjs            # into dist-kernel/
//   node scripts/embed-shell.mjs <outDir>
//
// It also writes the blank `dist-kernel/index.html`. That is the page the window opens on for
// the few milliseconds before the host sends it to the shell: no text, no script, only the
// background colour, so the first frame is never an empty white rectangle or a 404.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The background of the dark theme, the one tauri.conf.json paints the native window with. */
const FIRST_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Ose</title>
<style>html,body{margin:0;height:100%;background:#1A1917}</style>
`;

export function embedShell(outDir = path.join(repoRoot, 'dist-kernel')) {
  const from = path.join(repoRoot, 'shell');
  if (!existsSync(from)) throw new Error(`no shell folder at ${from}`);
  const to = path.join(outDir, 'shell');

  mkdirSync(outDir, { recursive: true });
  // Removed first, so a file deleted from shell/ does not live on inside the executable.
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  writeFileSync(path.join(outDir, 'index.html'), FIRST_PAGE, 'utf8');

  const files = count(to);
  console.log(`embedded ${files.n} shell files (${(files.bytes / 1024).toFixed(0)} KB) into ${to}`);
  return files.n;
}

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
  embedShell(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
}
