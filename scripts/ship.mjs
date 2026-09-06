// Copies the published exe to the vault root as os.exe. Run through `npm run ship`.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const app = path.resolve(here, '..');
const src = path.join(app, 'dist-host', 'os.exe');
const dst = path.join(app, '..', 'os.exe');
if (!fs.existsSync(src)) { console.error('missing ' + src + ' (run npm run host:publish first)'); process.exit(1); }
try {
  fs.copyFileSync(src, dst);
} catch (e) {
  if (e.code === 'EBUSY' || e.code === 'EPERM') { console.error('os.exe is running; close it and rerun.'); process.exit(1); }
  throw e;
}
const mb = (fs.statSync(dst).size / 1048576).toFixed(1);
console.log(`shipped ${dst} (${mb} MB)`);
