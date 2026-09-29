// The `test` every browser suite imports: Playwright's own, with `context` and `page` from a
// persistent browser profile in a fresh temp folder per test, instead of the private
// (incognito) context Playwright makes by default.
//
// Why: in Playwright 1.63's Chromium (headless shell 1243, Chrome 153) the whole browser exits
// about a second after Ose opens a vault inside a private context; in a persistent profile, the
// kind a person's Chrome is, it does not (the probe on CI, 2026-09-29). A fresh folder per test
// keeps each test's vault, IndexedDB and service worker its own, as a fresh context did.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as base, chromium } from '@playwright/test';

export { expect } from '@playwright/test';

export const test = base.extend({
  context: async ({ baseURL, viewport, headless, launchOptions }, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ose-e2e-profile-'));
    const context = await chromium.launchPersistentContext(dir, {
      ...launchOptions,
      headless,
      baseURL,
      viewport,
    });
    try {
      await use(context);
    } finally {
      await context.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] || (await context.newPage()));
  },
});
