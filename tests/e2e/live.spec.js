// Live, end to end (CONTRACT §8.2, L1 to L12): the CodeMirror live-preview mode driven through
// the real app in a browser, every scenario checked against the bytes on disk. What Live must
// never do is change a byte it was not told to: walking the caret through every construct
// writes nothing, one keystroke adds one character, a checkbox click changes one byte, and a
// CRLF file with a byte-order mark keeps both. And it keeps the guarantees of the other modes:
// drafts and recovery, switching modes with a dirty buffer, per-tab undo, the merge of a change
// made on disk, paste, the default mode setting and the Reading view.
//
// Every scenario types into a file of its own under `e2e/` (fixtures.js), in a fresh browser
// context: a first launch over a new vault (helpers.js boot), where markdown opens in Rich.
//
// Depends on: live-core (the view, tasks), live-widgets (tables, paste, reading), editor-page
// (the switch, the modes, the Read toggle), core (settings, tabs), src/host (the log in
// IndexedDB, the writes the fault switch fails).

import { expect, test } from './test.js';
import { FILES } from './fixtures.js';
import {
  boot, current, devFault, disk, diskBytes, draftPaths, editor, liveEditor, logText, openPage, setMode,
  stamp, tabState, typeAtEnd, vaultFiles, waitBooted, writeDisk,
} from './helpers.js';

/** `FILES[rel]` with `text` inserted after `line`. */
const typed = (rel, line, text) => FILES[rel].replace(line, line + text);

const pathOf = async (page) => (await current(page))?.path ?? null;

/** Open `rel` and put it in Live. */
async function openLive(page, rel, opts) {
  await openPage(page, rel, opts);
  await setMode(page, 'live');
}

/** The lines of the log that are a save of `rel` (src/host/fs.ts: `save ok`, `save conflict`, `save failed`). */
const saves = async (page, rel) => (await logText(page)).split('\n').filter((l) => /\bsave (ok|conflict|failed)\b/.test(l) && l.includes(rel));

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('L1. walking the caret through everything writes nothing', async ({ page }) => {
  const rel = 'e2e/live-walk.md';
  const before = await stamp(page, rel);
  const logged = (await saves(page, rel)).length;
  await openLive(page, rel);
  const ed = liveEditor(page);
  await ed.click();
  await page.keyboard.press('Control+Home');
  // Down through the frontmatter, the table, the maths block, the callout, the tasks and the
  // fence, then back up, then to the end: every construct is revealed and hidden again.
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowUp');
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+End');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft');
  // Past the autosave (600 ms) twice over.
  await page.waitForTimeout(2000);

  expect(await stamp(page, rel)).toEqual(before);
  expect((await saves(page, rel)).length).toBe(logged);
  expect(await draftPaths(page)).not.toContain(rel);
});

test('L2. one character typed in a heading adds exactly that byte', async ({ page }) => {
  const rel = 'e2e/live-heading.md';
  await openLive(page, rel);
  await typeAtEnd(page, 'Live heading', 'Z');
  await expect.poll(() => disk(page, rel)).toBe(typed(rel, '# Live heading', 'Z'));
  expect((await diskBytes(page, rel)).length).toBe(Buffer.byteLength(FILES[rel]) + 1);
});

test('L3. a checkbox click turns [ ] into [x], one byte', async ({ page }) => {
  const rel = 'e2e/live-task.md';
  await openLive(page, rel);
  // The caret elsewhere, so the task line is drawn with its checkbox.
  await typeAtEnd(page, 'Live task', '');
  const box = page.locator('.cm-live .cm-live-checkbox').first();
  await expect(box).toBeVisible();
  await box.click();
  const want = FILES[rel].replace('- [ ] the first task', '- [x] the first task');
  await expect.poll(() => disk(page, rel)).toBe(want);
  expect((await diskBytes(page, rel)).length).toBe(Buffer.byteLength(FILES[rel]));
});

test('L4. a CRLF file with a BOM keeps its CRLF and its BOM', async ({ page }) => {
  const rel = 'e2e/live-crlf.md';
  await openLive(page, rel);
  await typeAtEnd(page, 'The first line.', ' typed');
  const want = FILES[rel].replace('The first line.', 'The first line. typed');
  await expect.poll(() => disk(page, rel)).toBe(want);
  const bytes = await diskBytes(page, rel);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
});

test('L5. a failed save, then a reload: the text comes back, in Live', async ({ page }) => {
  const rel = 'e2e/live-fail.md';
  const want = typed(rel, 'The first paragraph.', ' typed-live-fail');
  await openLive(page, rel);
  await devFault(page, { cmd: 'saveFile', path: rel, code: 'write_failed', message: 'the disk is full (e2e)' });
  await typeAtEnd(page, 'The first paragraph.', ' typed-live-fail');
  await expect.poll(() => draftPaths(page)).toContain(rel);
  expect(await disk(page, rel)).toBe(FILES[rel]);
  // The session is written debounced (500 ms).
  await page.waitForTimeout(1200);
  await page.reload();
  await waitBooted(page);

  // The restored tab mounts the page with its draft, or the recovery sheet's row opens it.
  await expect.poll(async () => {
    if ((await pathOf(page)) === rel && (await editor(page).innerText().catch(() => '')).includes('typed-live-fail')) return 'back';
    const row = page.locator('.rec-row', { hasText: 'live-fail.md' }).first();
    if (await row.isVisible().catch(() => false)) await row.click().catch(() => {});
    return 'waiting';
  }, { timeout: 20_000, intervals: [250, 500, 1000] }).toBe('back');
  await expect(liveEditor(page)).toBeVisible();

  await devFault(page, null);
  await liveEditor(page).focus();
  await page.keyboard.press('Control+s');
  await expect.poll(() => disk(page, rel), { timeout: 15_000 }).toBe(want);
});

test('L6. Rich, Live, Source, Rich with a dirty buffer: nothing is lost', async ({ page }) => {
  const rel = 'e2e/live-switch.md';
  // No save lands between the switches: the buffer crosses them dirty.
  await devFault(page, { cmd: 'saveFile', path: rel, code: 'io', message: 'held (e2e)' });
  await openPage(page, rel);
  await typeAtEnd(page, 'Rich line.', ' r1');
  await setMode(page, 'live');
  await typeAtEnd(page, 'Live line.', ' l1');
  await setMode(page, 'source');
  await typeAtEnd(page, 'Source line.', ' s1');
  await setMode(page, 'rich');
  await expect(editor(page)).toContainText('Rich line. r1');
  await expect(editor(page)).toContainText('Live line. l1');
  await expect(editor(page)).toContainText('Source line. s1');
  expect(await disk(page, rel)).toBe(FILES[rel]);

  await devFault(page, null);
  await editor(page).focus();
  await page.keyboard.press('Control+s');
  const want = FILES[rel].replace('Rich line.', 'Rich line. r1').replace('Live line.', 'Live line. l1').replace('Source line.', 'Source line. s1');
  await expect.poll(() => disk(page, rel), { timeout: 15_000 }).toBe(want);
});

test('L7. two tabs in Live: each keeps its own undo history', async ({ page }) => {
  const a = 'e2e/live-tab-a.md';
  const b = 'e2e/live-tab-b.md';
  await openLive(page, a);
  const tabA = (await tabState(page)).activeId;
  await typeAtEnd(page, 'The first paragraph.', ' undo-a');
  await expect.poll(() => disk(page, a)).toBe(typed(a, 'The first paragraph.', ' undo-a'));

  await openPage(page, b, { tab: 'new' });
  await setMode(page, 'live');
  const tabB = (await tabState(page)).activeId;
  await typeAtEnd(page, 'The other page.', ' undo-b');
  await expect.poll(() => disk(page, b)).toBe(typed(b, 'The other page.', ' undo-b'));

  await page.evaluate((id) => window.__ose.tabs.activate(id), tabA);
  await expect.poll(() => pathOf(page)).toBe(a);
  await expect(liveEditor(page)).toContainText('undo-a');
  await liveEditor(page).focus();
  for (let i = 0; i < 8 && (await liveEditor(page).innerText()).includes('undo-a'); i++) await page.keyboard.press('Control+z');
  await expect(liveEditor(page)).not.toContainText('undo-a');
  await expect.poll(() => disk(page, a)).toBe(FILES[a]);

  // The other tab's history is its own: its text is still there, and its undo still works.
  await page.evaluate((id) => window.__ose.tabs.activate(id), tabB);
  await expect.poll(() => pathOf(page)).toBe(b);
  await expect(liveEditor(page)).toContainText('undo-b');
  await liveEditor(page).focus();
  for (let i = 0; i < 8 && (await liveEditor(page).innerText()).includes('undo-b'); i++) await page.keyboard.press('Control+z');
  await expect(liveEditor(page)).not.toContainText('undo-b');
  await expect.poll(() => disk(page, b)).toBe(FILES[b]);
});

test('L8. a change on disk to another line while dirty in Live: merged', async ({ page }) => {
  const rel = 'e2e/live-merge.md';
  const want = FILES[rel]
    .replace('Line one of the page.', 'Line one of the page. ours')
    .replace('Line nine at the end.', 'Line nine at the end. theirs');
  await openLive(page, rel);
  await typeAtEnd(page, 'Line one of the page.', ' ours');
  // Another program writes the last line before the autosave (600 ms) runs.
  await writeDisk(page, rel, FILES[rel].replace('Line nine at the end.', 'Line nine at the end. theirs'));

  await expect(page.locator('.ed-banner')).toContainText(/merged/i);
  await expect.poll(() => disk(page, rel), { timeout: 15_000 }).toBe(want);
  await expect(liveEditor(page)).toContainText('Line nine at the end. theirs');
  await expect(liveEditor(page)).toContainText('Line one of the page. ours');
});

test('L9. paste HTML: markdown; paste an image: an attachment and its link', async ({ page }) => {
  const rel = 'e2e/live-paste.md';
  await openLive(page, rel);
  await typeAtEnd(page, 'Paste below.', '');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<h2>Pasted title</h2><ul><li>first</li><li>second</li></ul><p><em>soft</em> and <strong>bold</strong></p>');
    dt.setData('text/plain', 'Pasted title first second soft and bold');
    document.querySelector('.cm-live .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => disk(page, rel), { timeout: 15_000 }).toContain('## Pasted title');
  const text = await disk(page, rel);
  expect(text).toContain('- first');
  expect(text).toContain('- second');
  expect(text).toContain('_soft_');
  expect(text).toContain('**bold**');
  expect(text).toContain('Paste below.');
  expect(text).toContain('The end.');

  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89];
  const before = await vaultFiles(page);
  await page.evaluate((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' }));
    document.querySelector('.cm-live .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG);
  let created = null;
  await expect.poll(async () => {
    const now = await vaultFiles(page);
    created = [...now.keys()].find((k) => !before.has(k) && k.toLowerCase().endsWith('.png')) || null;
    return created;
  }, { timeout: 15_000 }).not.toBeNull();
  expect([...(await diskBytes(page, created))]).toEqual(PNG);
  const name = created.split('/').pop();
  await expect.poll(() => disk(page, rel), { timeout: 15_000 }).toMatch(new RegExp(`!\\[[^\\]]*\\]\\([^)]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '(?: |%20)')}\\)`));
});

test('L10. a table is drawn off the caret and raw on it, with no write', async ({ page }) => {
  const rel = 'e2e/live-table.md';
  const before = await stamp(page, rel);
  await openLive(page, rel);
  await typeAtEnd(page, 'Before the table.', '');
  const drawn = page.locator('.cm-live .cm-live-table');
  const raw = page.locator('.cm-live .cm-line', { hasText: '| a | b |' });
  await expect(drawn.first()).toBeVisible();
  await expect(drawn.first()).toContainText('a');

  // A click on a cell puts the caret in its source: the pipes come back.
  await drawn.first().getByText('2', { exact: true }).click();
  await expect(raw.first()).toBeVisible();
  await expect(drawn).toHaveCount(0);
  // Away from it, it is drawn again.
  await page.keyboard.press('Control+End');
  await expect(drawn.first()).toBeVisible();

  // The keyboard reaches it too: up from the line below lands in the table's source.
  await typeAtEnd(page, 'After the table.', '');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(raw.first()).toBeVisible();
  await expect(drawn).toHaveCount(0);
  // And down from the line above.
  await typeAtEnd(page, 'Before the table.', '');
  await expect(drawn.first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(raw.first()).toBeVisible();

  await page.waitForTimeout(1500);
  expect(await stamp(page, rel)).toEqual(before);
});

test('L11. editorMode = live: a new file opens in Live, a remembered one keeps its mode', async ({ page }) => {
  // Remembered: left in Source before the default changes.
  await openPage(page, 'e2e/live-remembered.md');
  await setMode(page, 'source');
  await openPage(page, 'e2e/other.md');

  await page.evaluate(() => window.__ose.settings.set({ editorMode: 'live' }));
  await openPage(page, 'e2e/live-default.md');
  await expect(liveEditor(page)).toBeVisible();
  await expect(page.locator('.ed-mode-btn[data-mode="live"]:visible').first()).toHaveAttribute('aria-pressed', 'true');

  await openPage(page, 'e2e/live-remembered.md');
  await expect(page.locator('.ed-mode-btn[data-mode="source"]:visible').first()).toHaveAttribute('aria-pressed', 'true');
  await expect(liveEditor(page)).toHaveCount(0);
  expect(await disk(page, 'e2e/live-default.md')).toBe(FILES['e2e/live-default.md']);
  expect(await disk(page, 'e2e/live-remembered.md')).toBe(FILES['e2e/live-remembered.md']);
});

test('L12. the Reading view: the render matches, links follow, and the dirty buffer stays', async ({ page }) => {
  const rel = 'e2e/live-read.md';
  await openLive(page, rel);
  await devFault(page, { cmd: 'saveFile', path: rel, code: 'io', message: 'held (e2e)' });
  await typeAtEnd(page, 'The typed line.', ' dirty-read');

  const read = page.locator('.ed-read-btn:visible').first();
  await read.click();
  const view = page.locator('.ose-reading:visible').first();
  await expect(view).toBeVisible();
  await expect(view.locator('h1')).toHaveText('Live read');
  await expect(view).toContainText('The typed line. dirty-read');
  await expect(view.locator('a', { hasText: 'link to other' })).toBeVisible();

  // Back to the editor: the mode it came from, with the text still unsaved.
  await read.click();
  await expect(page.locator('.ose-reading:visible')).toHaveCount(0);
  await expect(liveEditor(page)).toContainText('The typed line. dirty-read');
  expect(await disk(page, rel)).toBe(FILES[rel]);

  await devFault(page, null);
  await liveEditor(page).focus();
  await page.keyboard.press('Control+s');
  await expect.poll(() => disk(page, rel), { timeout: 15_000 }).toBe(typed(rel, 'The typed line.', ' dirty-read'));

  // A link in the Reading view follows.
  await read.click();
  await page.locator('.ose-reading:visible a', { hasText: 'link to other' }).first().click();
  await expect.poll(() => pathOf(page)).toBe('e2e/other.md');
});
