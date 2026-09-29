// Temporary: which part of the app makes CI's Chromium drop the page a second after a vault
// opens. Each probe boots the built app over a small vault with one thing changed, waits, and
// says whether the page is still there. Removed once the cause is fixed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { URL_BASE } from './env.js';

const FILES = { 'notes/a.md': '# A\n\nSome text.\n' };

/** Seed the origin's private file system from a document that runs no app code. */
async function seed(page) {
  await page.goto(`${URL_BASE}/manifest.webmanifest`);
  await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for (const [rel, text] of Object.entries(files)) {
      const parts = rel.split('/');
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
  }, FILES);
}

/** Boot the app over the seeded vault, wait, and report what happened. */
async function run(page) {
  const log = [];
  page.on('close', () => log.push('page closed'));
  page.on('crash', () => log.push('page crashed'));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => log.push(`pageerror: ${e.message}`));
  const browser = page.context().browser();
  if (browser) browser.on('disconnected', () => log.push('browser disconnected'));
  await seed(page);
  await page.goto(`${URL_BASE}/index.html?opfs=1`);
  await page.waitForTimeout(6000).catch(() => {});
  const booted = await page.evaluate(() => !!(window.__ose && window.__ose.route && window.__ose.route.current()))
    .catch((e) => `evaluate failed: ${e.message.split('\n')[0]}`);
  const observer = await page.evaluate(() => typeof window.FileSystemObserver).catch(() => '?');
  return { booted, observer, log };
}

test('P0: as the suites boot', async ({ page }) => {
  const r = await run(page);
  expect(r.booted, JSON.stringify(r)).toBe(true);
});

test('P1: without FileSystemObserver', async ({ page }) => {
  await page.addInitScript(() => { delete window.FileSystemObserver; });
  const r = await run(page);
  expect(r.booted, JSON.stringify(r)).toBe(true);
});

test('P2: without the service worker', async ({ page }) => {
  await page.addInitScript(() => {
    if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('probe: no worker'));
  });
  const r = await run(page);
  expect(r.booted, JSON.stringify(r)).toBe(true);
});

test('P3: in a persistent profile, not a private one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ose-probe-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true,
    ...(process.env.OSE_E2E_CHROMIUM ? { executablePath: process.env.OSE_E2E_CHROMIUM } : {}),
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    const r = await run(page);
    expect(r.booted, JSON.stringify(r)).toBe(true);
  } finally {
    await ctx.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
