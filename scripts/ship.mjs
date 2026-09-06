// Copies the built exe to the vault root as os.exe. Run through `npm run ship`.
// Source: the Tauri release binary; falls back to the .NET host output while both hosts exist.
// Destination: the vault root from OSE_ROOT / ose.config.json / the parent folder (dev/root.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, vaultRoot, rootSource } from '../dev/root.mjs';

const candidates = [
  path.join(repoRoot, 'src-tauri', 'target', 'release', 'os.exe'),
  path.join(repoRoot, 'dist-host', 'os.exe'),
];
const src = candidates.find(p => fs.existsSync(p));
if (!src) {
  console.error('no os.exe found. Looked in:');
  for (const p of candidates) console.error('  ' + p);
  console.error('run `npm run tauri:build` (Tauri) or `npm run host:publish` (.NET host) first.');
  process.exit(1);
}

const dst = path.join(vaultRoot(), 'os.exe');
try {
  fs.copyFileSync(src, dst);
} catch (e) {
  if (e.code === 'EBUSY' || e.code === 'EPERM') { console.error('os.exe is running; close it and rerun.'); process.exit(1); }
  throw e;
}
const mb = (fs.statSync(dst).size / 1048576).toFixed(1);
console.log(`shipped ${dst} (${mb} MB) from ${src} [root from ${rootSource()}]`);
