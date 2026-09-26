// The e2e server by hand (`.claude/launch.json` "ose-e2e", or `node tests/e2e/serve.mjs`): the
// same vault copy and environment as `npm run test:e2e` gives its web server, on 5190, so a
// failing scenario can be replayed in a browser. The copy is made fresh at every start and
// removed at the next one (prepare.mjs); stop the server with Ctrl+C.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { APPDATA, OUTSIDE, PORT, REPO, ROOT } from './env.js';

const env = {
  ...process.env,
  OSE_TEST_ROOT: ROOT,
  OSE_TEST_PORT: String(PORT),
  OSE_APPDATA: APPDATA,
  OSE_DEV_APPDATA: APPDATA,
  OSE_DEV_FAULTS: '1',
  OSE_E2E_OUTSIDE: OUTSIDE,
  OSE_E2E: '1',
};

const run = (script) => spawnSync(process.execPath, [path.join(REPO, ...script.split('/'))], { stdio: 'inherit', cwd: REPO, env }).status;

const prepared = run('tests/e2e/prepare.mjs');
if (prepared !== 0) process.exit(prepared ?? 1);
process.exit(run('dev/test-server.mjs') ?? 1);
