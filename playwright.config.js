// `npm run test:e2e`: the no-loss suite (CONTRACT §14, H11), the Live scenarios and the files
// outside the vault (wave 3, §8.2), Playwright against the browser dev server. Headless Chromium drives the real shell, kernel and editor over the Node host
// (dev/bridge-plugin.mjs), and every scenario checks the bytes on disk, not only the screen.
//
// The server runs on a temp copy of the throwaway vault, never a real one (tests/e2e/env.js,
// prepare.mjs), with its own app-data folder and the dev bridge's fault switch on
// (`OSE_DEV_FAULTS=1`, docs/HOST.md "devFault"). One worker: the scenarios share that vault and
// that server, and each types into a file of its own.
//
// Browsers are not a dependency of the repo: `npx playwright install chromium` once per machine
// (and in CI before the step).

import { defineConfig, devices } from '@playwright/test';
import { APPDATA, BASE, OUTSIDE, PORT, ROOT, URL_BASE } from './tests/e2e/env.js';

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
  globalSetup: './tests/e2e/setup.js',
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
    command: 'node tests/e2e/prepare.mjs && node dev/test-server.mjs',
    url: `${URL_BASE}/index.html`,
    reuseExistingServer: false,
    timeout: 120_000,
    // The dev server's log (every save, every bridge failure) with OSE_E2E_VERBOSE=1.
    stdout: process.env.OSE_E2E_VERBOSE ? 'pipe' : 'ignore',
    stderr: 'pipe',
    env: {
      OSE_TEST_ROOT: ROOT,
      OSE_TEST_PORT: String(PORT),
      OSE_APPDATA: APPDATA,
      // The name the dev bridge read before wave 2; harmless once it reads OSE_APPDATA.
      OSE_DEV_APPDATA: APPDATA,
      OSE_DEV_FAULTS: '1',
      // Where files outside the vault may be opened from (outside.spec.js, dev/bridge-plugin.mjs).
      OSE_E2E_OUTSIDE: OUTSIDE,
      // No hot reload under a scenario (vite.config.js).
      OSE_E2E: '1',
    },
  },
});
