// Runs once the dev server answers: one page load that boots the app to the end and opens a
// page, so the editor's modules are transformed and any late dependency optimisation (and the
// reload it may ask for) happens here and never in the middle of a scenario.

import { chromium } from '@playwright/test';
import { URL_BASE } from './env.js';

/** @returns {Promise<void>} */
export default async function setup() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${URL_BASE}/index.html`);
    await page.waitForFunction(() => !!(window.__ose && window.__ose.route && window.__ose.route.current()), null, { timeout: 90_000 });
    await page.evaluate(() => window.__ose.route.navigate({ type: 'page', path: 'e2e/other.md' }));
    await page.locator('.ProseMirror, .cm-content').first().waitFor({ timeout: 90_000 });
    // A reload asked for by the optimiser lands within a moment.
    await page.waitForTimeout(2500);
    await page.waitForFunction(() => !!(window.__ose && window.__ose.route && window.__ose.route.current()), null, { timeout: 90_000 });
  } finally {
    await browser.close();
  }
}
