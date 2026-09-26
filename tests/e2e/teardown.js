// Deletes the suite's temp folder (env.js BASE): the vault copy, the app-data folder and the
// files outside the vault.
//
// Playwright runs the global teardown before it stops the web server, and on Windows a folder
// the dev server's watcher holds cannot be removed while it runs. So the folder is removed now
// when it can be, and otherwise by a small detached process a few seconds later, once the
// server is gone. prepare.mjs removes a leftover at the next start either way.

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { BASE } from './env.js';

/** @returns {Promise<void>} */
export default async function teardown() {
  if (process.env.OSE_E2E_KEEP) { console.log(`[e2e] kept ${BASE} (OSE_E2E_KEEP)`); return; }
  try { rmSync(BASE, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch { /* held by the server */ }
  if (!existsSync(BASE)) return;
  const script = `setTimeout(() => { try { require('node:fs').rmSync(${JSON.stringify(BASE)}, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {} }, 4000);`;
  spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
