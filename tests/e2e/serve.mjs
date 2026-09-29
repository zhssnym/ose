// The e2e server by hand (`node tests/e2e/serve.mjs`): the same build and the same static server
// as `npm run test:e2e` gives its web server, on 5190, so a failing scenario can be replayed in
// Chrome (open `/index.html?opfs=1` for the test vault). Stop it with Ctrl+C.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DIST, PORT, REPO } from './env.js';
import { serveStatic } from './web-serve.mjs';

const built = spawnSync(process.execPath, [path.join(REPO, 'tests', 'e2e', 'prepare.mjs')], { stdio: 'inherit', cwd: REPO }).status;
if (built !== 0) process.exit(built ?? 1);
const s = await serveStatic(DIST, PORT);
console.log(`Ose from ${DIST} on ${s.url}`);
