// Where the no-loss suite runs (CONTRACT §14): one port, one temp folder holding the vault copy
// and the app-data folder, the same for the config, the server it starts, the teardown and the
// specs. Everything is derived from two environment variables, so the runner process and the
// workers it forks agree without passing anything around:
//
//   OSE_E2E_PORT   the dev server's port (default 5190; the suite may use 5190 to 5199)
//   OSE_E2E_BASE   the temp folder (default <os tmp>/ose-e2e-<port>)
//
// The vault is `<base>/vault`, a copy of work/vault without `.claude` and `.git` plus the
// synthetic `e2e/` folder (serve.mjs). Drafts and the per-machine store are `<base>/appdata`.
// Nothing here ever names a real vault.

import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PORT = Number(process.env.OSE_E2E_PORT || 5190);
export const BASE = path.resolve(process.env.OSE_E2E_BASE || path.join(tmpdir(), `ose-e2e-${PORT}`));
export const ROOT = path.join(BASE, 'vault');
export const APPDATA = path.join(BASE, 'appdata');
export const PIDS = path.join(BASE, 'server.pids.json');
export const URL_BASE = `http://127.0.0.1:${PORT}`;

/**
 * The throwaway vault the copy is made from: `OSE_E2E_SOURCE`, else `work/vault` when this
 * clone has one. CI has no `work/` (it is gitignored), so there the vault is only the
 * synthetic `e2e/` folder, which is all the scenarios touch.
 */
export const SOURCE = process.env.OSE_E2E_SOURCE || path.join(REPO, 'work', 'vault');
