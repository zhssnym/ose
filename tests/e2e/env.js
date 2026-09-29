// Where the browser suites run: one port and one temp folder holding the build, the same for
// the config, the server it starts, the teardown and the specs. Derived from two environment
// variables, so the runner process and the workers it forks agree without passing anything:
//
//   OSE_E2E_PORT   the static server's port (default 5190; the suite may use 5190 to 5199)
//   OSE_E2E_BASE   the temp folder (default <os tmp>/ose-e2e-<port>)
//
// The build is `<base>/dist` (prepare.mjs), served as plain files (web-serve.mjs). The vault is
// not here at all: each test gets a fresh browser context, whose private file system is the
// vault (helpers.js boot). Nothing here ever names a real vault.

import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PORT = Number(process.env.OSE_E2E_PORT || 5190);
export const BASE = path.resolve(process.env.OSE_E2E_BASE || path.join(tmpdir(), `ose-e2e-${PORT}`));
export const DIST = path.join(BASE, 'dist');
export const URL_BASE = `http://127.0.0.1:${PORT}`;
