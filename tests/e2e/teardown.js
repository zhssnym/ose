// Deletes the suite's temp folder (env.js BASE): the build it ran against. `OSE_E2E_KEEP=1`
// keeps it.

import { rmSync } from 'node:fs';
import { BASE } from './env.js';

/** @returns {Promise<void>} */
export default async function teardown() {
  if (process.env.OSE_E2E_KEEP) { console.log(`[e2e] kept ${BASE} (OSE_E2E_KEEP)`); return; }
  try { rmSync(BASE, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch { /* prepare.mjs removes it next time */ }
}
