// Files outside the vault, end to end (CONTRACT X7, §8.2, O1 to O3): a file anywhere on the
// machine opens in a tab marked "outside vault", is edited and saved in place with nothing in the
// vault written, follows a change made on disk like a vault file, and can be copied into the
// vault byte for byte.
//
// The files live in `<base>/outside/` (fixtures.js OUTSIDE_FILES), beside the temp vault; the dev
// bridge opens outside files only under that folder (`OSE_E2E_OUTSIDE`, playwright.config.js).
//
// Depends on: kernel (abs: routes, outsideOpen, the watch), shell (the address bar, the outside
// mark, Copy into the vault…), editor-page (outside pages), build-tests (the dev bridge).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ROOT } from './env.js';
import { OUTSIDE_FILES } from './fixtures.js';
import { boot, current, editor, outsidePath, outsideText, resetApp, typeAtEnd, writeOutside } from './helpers.js';

/** The `abs:` path of a file outside the vault, as the app spells it (CONTRACT §5.2). */
const absOf = (rel) => `abs:${outsidePath(rel).replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`)}`;

/** Every file of the vault with its size and mtime, `.ose` left out (the app's own state). */
function snapshot(dir = ROOT, out = {}) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.ose') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) snapshot(full, out);
    else if (e.isFile()) { const st = statSync(full); out[path.relative(ROOT, full).split(path.sep).join('/')] = `${st.size}:${st.mtimeMs}`; }
  }
  return out;
}

/** Open an absolute path from the address bar (Ctrl+L), as a person would. */
async function openFromAddress(page, native) {
  await page.keyboard.press('Control+l');
  const input = page.locator('.tb-addr-input:visible').first();
  await expect(input).toBeVisible();
  await input.fill(native);
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ page, request }) => {
  await resetApp(request);
  await boot(page);
});

test('O1. an absolute path from the address bar: a marked tab, saved in place, the vault untouched', async ({ page }) => {
  const rel = 'notes/outside.md';
  const vault = snapshot();
  await openFromAddress(page, outsidePath(rel));
  await expect.poll(async () => (await current(page))?.path).toBe(absOf(rel));
  await expect(editor(page)).toContainText('The outside line.');
  // The tab wears the mark (with one tab the strip itself is hidden, so it is checked in the DOM).
  await expect(page.locator('.tab.outside').first()).toBeAttached();
  await expect(page.locator('.tab.outside').first()).toHaveAttribute('aria-label', /outside vault/);

  await typeAtEnd(page, 'The outside line.', ' typed-outside');
  const want = OUTSIDE_FILES[rel].replace('The outside line.', 'The outside line. typed-outside');
  await expect.poll(() => outsideText(rel), { timeout: 15_000 }).toBe(want);
  await page.waitForTimeout(800);
  expect(snapshot()).toEqual(vault);
});

test('O2. an outside file changed on disk merges like a vault file', async ({ page }) => {
  const rel = 'notes/change.md';
  const theirs = OUTSIDE_FILES[rel].replace('Line nine at the end.', 'Line nine at the end. theirs');
  const want = theirs.replace('Line one of the page.', 'Line one of the page. ours');
  await openFromAddress(page, outsidePath(rel));
  await expect.poll(async () => (await current(page))?.path).toBe(absOf(rel));
  await typeAtEnd(page, 'Line one of the page.', ' ours');
  // Another program writes the last line before the autosave (600 ms) runs.
  writeOutside(rel, theirs);

  await expect(page.locator('.ed-banner')).toContainText(/merged/i, { timeout: 15_000 });
  await expect.poll(() => outsideText(rel), { timeout: 15_000 }).toBe(want);
  await expect(editor(page)).toContainText('Line nine at the end. theirs');

  // Clean now: the next change on disk is taken in place.
  await page.waitForTimeout(800);
  writeOutside(rel, want.replace('Line five stays.', 'Line five changed by another program.'));
  await expect(editor(page)).toContainText('Line five changed by another program.', { timeout: 15_000 });
});

test('O3. Copy into the vault: a byte-identical copy, create-only', async ({ page }) => {
  const rel = 'notes/copy-me.md';
  const original = readFileSync(outsidePath(rel));
  await openFromAddress(page, outsidePath(rel));
  await expect.poll(async () => (await current(page))?.path).toBe(absOf(rel));

  /** Run Copy into the vault… and choose the `e2e` folder in the picker. */
  const copyIn = async () => {
    // Not awaited: the command waits for the picker's answer.
    await page.evaluate(() => { void window.__ose.commands.run('file.copy-into-vault'); });
    const dialog = page.getByRole('dialog').last();
    await expect(dialog).toBeVisible();
    await page.keyboard.type('e2e', { delay: 20 });
    await page.keyboard.press('Enter');
  };

  await copyIn();
  const first = path.join(ROOT, 'e2e', 'copy-me.md');
  await expect.poll(() => { try { return readFileSync(first).equals(original); } catch { return false; } }, { timeout: 15_000 }).toBe(true);
  // The copy opens; the outside file is as it was.
  await expect.poll(async () => (await current(page))?.path).toBe('e2e/copy-me.md');
  expect(readFileSync(outsidePath(rel)).equals(original)).toBe(true);

  // Again: the first copy is never overwritten; the second lands under a free name.
  await page.evaluate((p) => window.__ose.route.navigate({ type: 'page', path: p }), absOf(rel));
  await expect.poll(async () => (await current(page))?.path).toBe(absOf(rel));
  const stampOf = () => { const st = statSync(first); return `${st.size}:${st.mtimeMs}`; };
  const firstStamp = stampOf();
  await copyIn();
  await expect.poll(() => readdirSync(path.join(ROOT, 'e2e')).filter((n) => n.startsWith('copy-me')).length, { timeout: 15_000 }).toBe(2);
  expect(stampOf()).toBe(firstStamp);
  expect(readFileSync(first).equals(original)).toBe(true);
  const second = readdirSync(path.join(ROOT, 'e2e')).find((n) => n.startsWith('copy-me') && n !== 'copy-me.md');
  expect(readFileSync(path.join(ROOT, 'e2e', second)).equals(original)).toBe(true);
});
