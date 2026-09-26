// The no-loss suite (CONTRACT §14, H11): the ways typed text has been lost or could be, each
// driven through the real app in a browser and each checked against the bytes on disk. 1 to 8
// are the contract's; 9 to 13 are the loss paths the wave-2 review found around them.
//
// Every scenario types into a file of its own under `<vault>/e2e/` (fixtures.js) in the temp
// copy the config's web server runs on. Before each one the app is put back to a first launch
// (helpers.js resetApp) and loaded.
//
// Depends on: host (devFault, localGet/localSet, the dev bridge), kernel (tabs, session),
// editor (instances, merge), shell-tree (the tree's F2 and Ctrl+Z), shell-places (tab marks),
// shell-surfaces (the recovery sheet), kernel (ose.fileops and its undo journal).

import { expect, test } from '@playwright/test';
import { FILES } from './fixtures.js';
import {
  boot, bridge, buffer, current, devFault, disk, draftPaths, editor, openPage, resetApp, revealInTree,
  tabState, treeRow, typeAtEnd, waitBooted, writeDisk,
} from './helpers.js';

/** `FILES[rel]` with `text` inserted after `line`: what the file must hold after the typing. */
const typed = (rel, line, text) => FILES[rel].replace(line, line + text);

const path = async (page) => (await current(page))?.path ?? null;

test.beforeEach(async ({ page, request }) => {
  await resetApp(request);
  await boot(page);
});

test('1. type, Ctrl+W, reopen: the file holds the typed text', async ({ page }) => {
  const rel = 'e2e/close.md';
  const want = typed(rel, 'The first paragraph.', ' typed-close');
  await openPage(page, rel);
  await typeAtEnd(page, 'The first paragraph.', ' typed-close');
  await page.keyboard.press('Control+w');

  await expect.poll(() => path(page)).not.toBe(rel);
  expect(disk(rel)).toBe(want);

  await openPage(page, rel);
  await expect(editor(page)).toContainText('The first paragraph. typed-close');
  expect(disk(rel)).toBe(want);
});

test('2. a failed write keeps the tab, then Ctrl+S saves and Ctrl+W closes', async ({ page, request }) => {
  const rel = 'e2e/fail.md';
  const want = typed(rel, 'The first paragraph.', ' typed-fail');
  await openPage(page, rel);
  await devFault(request, { cmd: 'saveFile', path: rel, code: 'write_failed', message: 'the disk is full (e2e)' });
  await typeAtEnd(page, 'The first paragraph.', ' typed-fail');
  await page.keyboard.press('Control+w');

  // The close is refused: the page stays, says why, and the tab carries the mark.
  await expect(page.locator('.ed-banner[role="alert"]')).toBeVisible();
  expect(await path(page)).toBe(rel);
  // shell/tabs.js: the tab of a page that is not saved is `.tab.err` with a `.tab-err` mark,
  // and its tooltip starts with the path. (With one tab the strip itself is hidden, so the
  // mark is checked in the DOM, not on screen.)
  await expect(page.locator(`.tab.err[title*="${rel}"] .tab-err`)).toBeAttached();
  await expect.poll(() => draftPaths(request)).toContain(rel);
  expect(disk(rel)).toBe(FILES[rel]);

  await devFault(request, null);
  await page.keyboard.press('Control+s');
  await expect.poll(() => disk(rel)).toBe(want);

  await page.keyboard.press('Control+w');
  await expect.poll(() => path(page)).not.toBe(rel);
  expect(disk(rel)).toBe(want);
});

test('3. an overlapping change, Resolve then Cancel, then a click away: refused, nothing lost', async ({ page, request }) => {
  const rel = 'e2e/conflict.md';
  const theirs = FILES[rel].replace('The shared line.', 'The shared line. theirs');
  await openPage(page, rel);
  await typeAtEnd(page, 'The shared line.', ' mine');
  // Another program writes the same line before the autosave (600 ms) runs.
  writeDisk(rel, theirs);

  const banner = page.locator('.ed-banner[role="alert"]');
  await expect(banner).toContainText(/overlap/i);
  await banner.getByRole('button', { name: /resolve/i }).click();
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(banner).toBeVisible();

  await revealInTree(page, 'e2e/other.md');
  await treeRow(page, 'e2e/other.md').click();
  await page.waitForTimeout(800);

  expect(await path(page)).toBe(rel);
  await expect(editor(page)).toContainText('The shared line. mine');
  expect(await draftPaths(request)).toContain(rel);
  // Nothing was written over the other program's text.
  expect(disk(rel)).toBe(theirs);
});

test('4. rename an open dirty page with F2, then Ctrl+Z in the tree renames it back', async ({ page }) => {
  const rel = 'e2e/rename.md';
  const moved = 'e2e/renamed.md';
  const want = typed(rel, 'The first paragraph.', ' typed-rename');
  await openPage(page, rel);
  await typeAtEnd(page, 'The first paragraph.', ' typed-rename');

  await revealInTree(page, rel);
  await treeRow(page, rel).focus();
  await page.keyboard.press('F2');
  const input = page.locator('[role="dialog"] input').last();
  await expect(input).toBeVisible();
  await input.fill('renamed.md');
  await page.keyboard.press('Enter');

  await expect.poll(() => disk(moved)).toBe(want);
  expect(disk(rel)).toBeNull();
  await expect.poll(() => path(page)).toBe(moved);

  await expect(treeRow(page, moved)).toBeVisible();
  await treeRow(page, moved).focus();
  await page.keyboard.press('Control+z');

  await expect.poll(() => disk(rel)).toBe(want);
  expect(disk(moved)).toBeNull();
  await expect.poll(() => path(page)).toBe(rel);
  await expect(editor(page)).toContainText('The first paragraph. typed-rename');
});

test('5. a reload while typing: the text is in the file, or the recovery sheet puts it there', async ({ page }) => {
  const rel = 'e2e/reload.md';
  const want = typed(rel, 'The first paragraph.', ' typed-reload');
  await openPage(page, rel);
  await typeAtEnd(page, 'The first paragraph.', ' typed-reload');
  await page.waitForTimeout(50);
  await page.reload();
  await waitBooted(page);

  // Either the save landed, or the draft comes back: by itself when the page reopens, or from
  // the recovery sheet, whose row opens the page and puts the draft back for the autosave.
  await expect.poll(async () => {
    if (disk(rel) === want) return 'saved';
    const row = page.locator('.rec-row', { hasText: 'reload.md' }).first();
    if (await row.isVisible().catch(() => false)) await row.click().catch(() => {});
    return disk(rel) === want ? 'saved' : 'waiting';
  }, { timeout: 20_000, intervals: [250, 500, 1000] }).toBe('saved');
});

test('6. a tab switch keeps the undo history (M24)', async ({ page }) => {
  const a = 'e2e/undo-a.md';
  await openPage(page, a);
  const tabA = (await tabState(page))?.activeId;
  expect(tabA, 'ose.tabs (CONTRACT §4.3)').toBeTruthy();
  await typeAtEnd(page, 'The first paragraph.', ' undo-me');
  await expect.poll(() => disk(a)).toBe(typed(a, 'The first paragraph.', ' undo-me'));

  await openPage(page, 'e2e/undo-b.md', { tab: 'new' });
  await page.evaluate((id) => window.__ose.tabs.activate(id), tabA);
  await expect.poll(() => path(page)).toBe(a);
  await expect(editor(page)).toContainText('undo-me');

  await editor(page).focus();
  for (let i = 0; i < 6 && (await buffer(page)).includes('undo-me'); i += 1) await page.keyboard.press('Control+z');
  await expect(editor(page)).not.toContainText('undo-me');
  await expect(editor(page)).toContainText('The first paragraph.');
  // And the undo is saved like any edit.
  await expect.poll(() => disk(a)).toBe(FILES[a]);
});

test('7. session restore: the same tabs and the same active route after a reload', async ({ page }) => {
  await openPage(page, 'e2e/session-a.md');
  const tabA = (await tabState(page))?.activeId;
  expect(tabA, 'ose.tabs (CONTRACT §4.3)').toBeTruthy();
  await openPage(page, 'e2e/session-b.md', { tab: 'new' });
  await page.evaluate(() => window.__ose.tabs.open({ type: 'folder', path: 'e2e' }, { reuse: false }));
  await page.evaluate((id) => window.__ose.tabs.activate(id), tabA);
  await expect.poll(() => path(page)).toBe('e2e/session-a.md');

  const before = await tabState(page);
  // The session is written debounced (500 ms) and flushed on pagehide.
  await page.waitForTimeout(1200);
  await page.reload();
  await waitBooted(page);

  await expect.poll(async () => {
    const s = await tabState(page);
    return s && { tabs: s.tabs, active: s.active };
  }).toEqual({ tabs: before.tabs, active: before.active });
  expect(before.tabs).toEqual(['page:e2e/session-a.md', 'page:e2e/session-b.md', 'folder:e2e']);
  expect(await path(page)).toBe('e2e/session-a.md');
  await expect(editor(page)).toContainText('The first paragraph.');
});

test('8. a change on disk that does not overlap merges by itself (H7)', async ({ page }) => {
  const rel = 'e2e/merge.md';
  const want = FILES[rel]
    .replace('Line one of the page.', 'Line one of the page. ours')
    .replace('Line nine at the end.', 'Line nine at the end. theirs');
  await openPage(page, rel);
  await typeAtEnd(page, 'Line one of the page.', ' ours');
  writeDisk(rel, FILES[rel].replace('Line nine at the end.', 'Line nine at the end. theirs'));

  await expect(page.locator('.ed-banner')).toContainText(/merged/i);
  await expect.poll(() => disk(rel), { timeout: 15_000 }).toBe(want);
  await expect(editor(page)).toContainText('Line nine at the end. theirs');
  await expect(editor(page)).toContainText('Line one of the page. ours');
});

test('9. Ctrl+Z after a change on disk was taken in place does not undo the other program', async ({ page }) => {
  const rel = 'e2e/merge-undo.md';
  const ours = FILES[rel].replace('Line one of the page.', 'Line one of the page. ours');
  await openPage(page, rel);
  await typeAtEnd(page, 'Line one of the page.', ' ours');
  await expect.poll(() => disk(rel), { timeout: 15_000 }).toBe(ours);
  await page.waitForTimeout(800);

  // The page is clean by now, so the other program's change is taken in place.
  const theirs = ours.replace('Line nine at the end.', 'Line nine at the end. theirs-by-agent');
  writeDisk(rel, theirs);
  await expect(editor(page)).toContainText('theirs-by-agent', { timeout: 15_000 });
  await page.waitForTimeout(500);

  await editor(page).getByText('Line one of the page.', { exact: false }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+z');
  // Past the autosave (600 ms) and its write.
  await page.waitForTimeout(2500);

  await expect(editor(page)).toContainText('Line nine at the end. theirs-by-agent');
  expect(disk(rel)).toContain('Line nine at the end. theirs-by-agent');
});

test('10. a restored tab with a draft, Discard in the recovery sheet, then leave: the draft is not written', async ({ page, request }) => {
  const rel = 'e2e/discard.md';
  await openPage(page, rel);
  // The session is written debounced (500 ms).
  await page.waitForTimeout(1200);
  const f = await bridge(request, 'readFile', rel);
  const text = FILES[rel].replace('The first paragraph.', 'The first paragraph. discard-me');
  await bridge(request, 'draftWrite', rel, { path: rel, text, baselineHash: f.hash, mode: 'rich', exact: true, rev: 5 });
  await page.reload();
  await waitBooted(page);

  // The restored tab mounts the page with its draft, and the sheet lists the same draft.
  await expect.poll(() => path(page)).toBe(rel);
  await expect(editor(page)).toContainText('discard-me');
  const row = page.locator('.rec-row', { hasText: 'discard.md' }).first();
  await expect(row).toBeVisible();
  await row.focus();
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect.poll(() => draftPaths(request)).not.toContain(rel);

  await page.evaluate(() => window.__ose.route.navigate({ type: 'page', path: 'e2e/other.md' }));
  await page.waitForTimeout(1500);
  expect(disk(rel)).toBe(FILES[rel]);
  expect(await draftPaths(request)).not.toContain(rel);
});

/** Open `a` in one tab and `b` in a second, then come back to the first; both tab ids. */
async function twoTabs(page, a, b) {
  await openPage(page, a);
  const first = (await tabState(page)).activeId;
  await openPage(page, b, { tab: 'new' });
  const second = (await tabState(page)).activeId;
  await page.evaluate((id) => window.__ose.tabs.activate(id), first);
  await expect.poll(() => path(page)).toBe(a);
  return { first, second };
}

/** Start a navigate away from the page on screen and switch tabs before it settles. */
function navigateThenSwitch(page, to, tab) {
  return page.evaluate(async ({ to, tab }) => {
    const nav = window.__ose.route.navigate({ type: 'page', path: to });
    const act = window.__ose.tabs.activate(tab);
    return { nav: await nav, act: await act };
  }, { to, tab });
}

/** The id of a tab of the strip that holds `rel`, or null. */
function tabHolding(page, rel) {
  return page.evaluate((rel) => {
    const t = window.__ose.tabs.list().find((x) => x.route && x.route.path === rel);
    return t ? t.id : null;
  }, rel);
}

test('11. a navigate overtaken by a tab switch: the page is saved, and editable when it comes back', async ({ page }) => {
  const rel = 'e2e/race.md';
  const want = typed(rel, 'The first paragraph.', ' race-text');
  const { second } = await twoTabs(page, rel, 'e2e/undo-b.md');
  await typeAtEnd(page, 'The first paragraph.', ' race-text');
  await navigateThenSwitch(page, 'e2e/other.md', second);

  await expect.poll(() => disk(rel), { timeout: 15_000 }).toBe(want);
  await page.evaluate((rel) => window.__ose.route.navigate({ type: 'page', path: rel }), rel);
  await expect.poll(() => path(page)).toBe(rel);
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    return { editable: pm && pm.getAttribute('contenteditable'), frozen: !!document.querySelector('.ed-frozen') };
  });
  expect(state).toEqual({ editable: 'true', frozen: false });
  await expect(editor(page)).toContainText('The first paragraph. race-text');
});

test('12. the same race with a failing save: the unsaved page keeps its tab and its draft', async ({ page, request }) => {
  const rel = 'e2e/race-fail.md';
  const want = typed(rel, 'The first paragraph.', ' orphan-text');
  const { second } = await twoTabs(page, rel, 'e2e/undo-b.md');
  await devFault(request, { cmd: 'saveFile', path: rel, code: 'io', message: 'locked (e2e)' });
  await typeAtEnd(page, 'The first paragraph.', ' orphan-text');
  const r = await navigateThenSwitch(page, 'e2e/other.md', second);
  await page.waitForTimeout(800);

  // The leave is refused, so the tab that held the page still holds it.
  expect(r.nav).toBe(false);
  const tab = await tabHolding(page, rel);
  expect(tab, `a tab still holds ${rel}`).toBeTruthy();
  await expect.poll(() => draftPaths(request)).toContain(rel);
  expect(disk(rel)).toBe(FILES[rel]);

  // From that tab the text reaches the disk once the disk takes it.
  await devFault(request, null);
  await page.evaluate((id) => window.__ose.tabs.activate(id), tab);
  await expect.poll(() => path(page)).toBe(rel);
  await expect(editor(page)).toContainText('The first paragraph. orphan-text');
  await editor(page).focus();
  await page.keyboard.press('Control+s');
  await expect.poll(() => disk(rel), { timeout: 15_000 }).toBe(want);
});

test('13. undo refuses an edited new page, and the next undo does not trash its folder with it', async ({ page }) => {
  const rel = 'e2e/undo-folder/new.md';
  await page.evaluate(async () => {
    await window.__ose.fileops.mkdir('e2e', 'undo-folder');
    await window.__ose.fileops.create('e2e/undo-folder', 'new.md');
  });
  await openPage(page, rel);
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' my notes', { delay: 15 });
  await expect.poll(() => disk(rel), { timeout: 10_000 }).toContain('my notes');
  await page.evaluate(() => window.__ose.route.navigate({ type: 'page', path: 'e2e/other.md' }));

  const undo = () => page.evaluate(async () => (await window.__ose.fileops.journal.undo()).ok);
  // Created new.md: refused, the page changed since.
  expect(await undo()).toBe(false);
  // Created folder undo-folder: refused or not, the page stays where it is.
  await undo();

  expect(disk(rel)).toContain('my notes');
});
