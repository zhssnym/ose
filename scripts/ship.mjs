// Copies the built executable to the vault root as ose.exe. Run through `npm run ship`.
// Source: the Tauri release binary.
// Destination: the vault root from OSE_ROOT / ose.config.json / the parent folder (dev/root.mjs).
//
// The app is `ose` from 0.4.0 on. A vault that still holds the old `os.exe` keeps it — the
// update swap renames the file it found and never the app, so an old copy stays valid — but
// `ship` says it is there, because two executables in one vault is a thing to notice.
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, vaultRoot, rootSource } from '../dev/root.mjs';

const release = path.join(repoRoot, 'src-tauri', 'target', 'release');
const candidates = [
  path.join(release, 'ose.exe'),
  // A build from before the rename, so a half-updated working tree still ships something.
  path.join(release, 'os.exe'),
];
const src = candidates.find(p => fs.existsSync(p));
if (!src) {
  console.error('no ose.exe found. Looked in:');
  for (const p of candidates) console.error('  ' + p);
  console.error('run `npm run tauri:build` first.');
  process.exit(1);
}

const root = vaultRoot();
const dst = path.join(root, 'ose.exe');
try {
  fs.copyFileSync(src, dst);
} catch (e) {
  if (e.code === 'EBUSY' || e.code === 'EPERM') { console.error('ose.exe is running; close it and rerun.'); process.exit(1); }
  throw e;
}
const mb = (fs.statSync(dst).size / 1048576).toFixed(1);
console.log(`shipped ${dst} (${mb} MB) from ${src} [root from ${rootSource()}]`);

// A MinGW (local) build loads WebView2Loader.dll from beside the exe; the MSVC build from CI
// links it statically. Carry the DLL when it exists so a local ship runs too.
{
  const dll = path.join(path.dirname(src), 'WebView2Loader.dll');
  if (fs.existsSync(dll)) { fs.copyFileSync(dll, path.join(root, 'WebView2Loader.dll')); console.log('shipped WebView2Loader.dll (local MinGW build)'); }
}

// Nothing is deleted here: an `os.exe` in the vault may be the copy someone has a shortcut to.
{
  const old = path.join(root, 'os.exe');
  if (fs.existsSync(old)) {
    console.log(`note: ${old} is still there (the 0.3.x name). It keeps working and updates itself under its own name; delete it when nothing points at it.`);
  }
}
