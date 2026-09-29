// `npm run test:e2e`: the browser suites. The no-loss suite (CONTRACT §14, H11), the Live
// scenarios and Ose Web's own (web.spec.js), Playwright against the built app served as plain
// files, as any static host serves it. Headless Chromium drives the real shell, core, editor
// and web adapter, and every scenario checks the bytes in the vault, not only the screen.
//
// The build is made fresh into a temp folder (tests/e2e/prepare.mjs, env.js), never the
// repository's `dist/`. The vault is the browser's private file system for the origin, opened
// through the `?opfs=1` test hook (src/host/adapter.js): every test has a fresh persistent
// profile (tests/e2e/test.js), so a fresh, empty vault that helpers.js boot seeds. One
// worker: the scenarios share the server.
//
// Browsers are not a dependency of the repo: `npx playwright install chromium` once per machine
// (and in CI before the step).

import { defineConfig, devices } from '@playwright/test';
import { BASE, DIST, PORT, URL_BASE } from './tests/e2e/env.js';

// The workers are forked from this process and inherit its environment, so they resolve the
// same base even when it came from the default.
process.env.OSE_E2E_PORT = String(PORT);
process.env.OSE_E2E_BASE = BASE;

const CI = !!process.env.CI;

// A Chromium of another Playwright release, where the one this release expects is not
// installed (`OSE_E2E_CHROMIUM=/path/to/chrome`); unset, Playwright's own.
const LAUNCH = process.env.OSE_E2E_CHROMIUM ? { executablePath: process.env.OSE_E2E_CHROMIUM } : {};

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // One folder per port, so two runs on one machine (OSE_E2E_PORT) never delete each other's
  // traces and screenshots.
  outputDir: `test-results/e2e-${PORT}`,
  globalTeardown: './tests/e2e/teardown.js',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: URL_BASE,
    viewport: { width: 1280, height: 820 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: LAUNCH,
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: `node tests/e2e/prepare.mjs && node tests/e2e/web-serve.mjs "${DIST}" ${PORT}`,
    url: `${URL_BASE}/index.html`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: process.env.OSE_E2E_VERBOSE ? 'pipe' : 'ignore',
    stderr: 'pipe',
  },
});
