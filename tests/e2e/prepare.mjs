// Makes the vault the no-loss suite runs against, before the dev server starts
// (playwright.config.js `webServer.command`: this, then `node dev/test-server.mjs`).
//
//   <base>/vault     a copy of the throwaway vault (env.js SOURCE) without `.claude` and `.git`,
//                    plus the synthetic `e2e/` folder of fixtures.js
//   <base>/appdata   empty: drafts and the per-machine store of the dev bridge
//
// `.claude` holds credentials: the copy filter refuses it by name before anything reads it, so
// its contents are never listed, read or copied. A stale base from an earlier run (its server
// was killed before the teardown could delete it) is removed first.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APPDATA, BASE, OUTSIDE, ROOT, SOURCE } from './env.js';
import { FILES, OUTSIDE_FILES } from './fixtures.js';

/** Never a real vault: the source must be the repo's work/ copy or an explicit override. */
function copyVault() {
  if (!existsSync(SOURCE)) {
    console.log(`[e2e] no throwaway vault at ${SOURCE}; the vault is the synthetic e2e/ folder only`);
    return;
  }
  cpSync(SOURCE, ROOT, {
    recursive: true,
    // Symlinks and junctions are copied as links, never followed out of the vault.
    dereference: false,
    errorOnExist: false,
    filter: (src) => {
      const rel = path.relative(SOURCE, src);
      if (!rel) return true;
      const segs = rel.split(/[\\/]+/);
      if (segs[0].toLowerCase() === '.claude') return false;
      if (segs.some((s) => s.toLowerCase() === '.git')) return false;
      return true;
    },
  });
}

/** The fixtures, written byte for byte: UTF-8, with the endings and the mark each one spells. */
function writeFixtures() {
  for (const [dir, files] of [[ROOT, FILES], [OUTSIDE, OUTSIDE_FILES]]) {
    for (const [rel, text] of Object.entries(files)) {
      const file = path.join(dir, ...rel.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
    }
  }
}

rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(ROOT, { recursive: true });
mkdirSync(APPDATA, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
copyVault();
writeFixtures();
console.log(`[e2e] vault ready at ${ROOT}`);
