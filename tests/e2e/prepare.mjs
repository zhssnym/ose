// Builds the app the browser suites run against, before the static server starts
// (playwright.config.js `webServer.command`: this, then web-serve.mjs): `vite build` into
// `<base>/dist` (env.js), never the repository's own `dist/`, so a suite never runs a stale
// build. A stale base from an earlier run is removed first.

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { BASE, DIST, REPO } from './env.js';

rmSync(BASE, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', DIST, '--logLevel', 'error'], {
  cwd: REPO,
  stdio: ['ignore', 'inherit', 'inherit'],
});
