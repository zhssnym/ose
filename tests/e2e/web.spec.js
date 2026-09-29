// Ose Web end to end (docs/HOST.md "Testing"): the built app, served by a plain static
// server (web-serve.mjs, what any static host does), in Chromium, over the origin's private file
// system as the vault. `?opfs=1` is the adapter's test hook: it opens
// `navigator.storage.getDirectory()` instead of asking for a folder with the picker, which a
// headless browser cannot answer. Everything else is the real thing: the web adapter, fs.js,
// the watcher (FileSystemObserver, or its polling), local.js over IndexedDB, and the service
// worker that makes the app work offline.
//
// Every scenario runs in a fresh browser profile (test.js: a fresh origin storage, an empty vault, no
// drafts, no worker) and checks the bytes in the vault, read back from OPFS, not only the screen.
//
// The build is the suite's own (prepare.mjs, env.js DIST), served here by a second server of
// this spec's, which counts what reaches it for the offline scenario.

import { expect, test } from './test.js';
import { DIST } from './env.js';
import { waitBooted, watchPage } from './helpers.js';
import { serveStatic } from './web-serve.mjs';

/** The pages the scenarios type into: LF endings, `-` bullets, one blank line between blocks. */
const page_ = (title, lines) => `# ${title}\n\n${lines.join('\n\n')}\n`;
const LONG = page_('Merge', ['Line one of the page.', 'Line two stays.', 'Line three stays.', 'Line four stays.',
  'Line five stays.', 'Line six stays.', 'Line seven stays.', 'Line eight stays.', 'Line nine at the end.']);
const FILES = {
  'notes/type.md': page_('Type', ['The first paragraph.', '- a bullet\n- another one']),
  'notes/merge.md': LONG,
  'notes/rename.md': page_('Rename', ['The first paragraph.']),
  'notes/trash.md': page_('Trash', ['Goes to the bin.']),
  'notes/tab-a.md': page_('Tab A', ['The first paragraph.']),
  'notes/tab-b.md': page_('Tab B', ['The second page.']),
  'notes/offline.md': page_('Offline', ['The first paragraph.']),
};

/** @type {Awaited<ReturnType<typeof serveStatic>>} */
let server;
let port = 0;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = await serveStatic(DIST, 0);
  port = Number(new URL(server.url).port);
});

test.afterAll(async () => {
  if (server) await server.close();
});

/** Write vault files straight into OPFS, as another program writes a folder on disk. */
async function opfsWrite(page, files) {
  await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for (const [rel, text] of Object.entries(files)) {
      const parts = rel.split('/');
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const h = await dir.getFileHandle(/** @type {string} */ (parts.at(-1)), { create: true });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
    }
  }, files);
}

/** A vault file's bytes from OPFS, or null when it is not there. @returns {Promise<Buffer | null>} */
async function opfsBytes(page, rel) {
  const arr = await page.evaluate(async (rel) => {
    try {
      const parts = rel.split('/');
      let dir = await navigator.storage.getDirectory();
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      const f = await (await dir.getFileHandle(/** @type {string} */ (parts.at(-1)))).getFile();
      return Array.from(new Uint8Array(await f.arrayBuffer()));
    } catch { return null; }
  }, rel);
  return arr ? Buffer.from(arr) : null;
}

/** A vault file's text (UTF-8), or null. */
const opfsText = async (page, rel) => {
  const b = await opfsBytes(page, rel);
  return b ? b.toString('utf8') : null;
};

/** The names in a vault folder, or null when it is not there. */
async function opfsList(page, rel) {
  return page.evaluate(async (rel) => {
    try {
      let dir = await navigator.storage.getDirectory();
      for (const p of rel.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(p);
      const out = [];
      for await (const name of dir.keys()) out.push(name);
      return out.sort();
    } catch { return null; }
  }, rel);
}

/**
 * The app over a vault holding `files`: a page of the origin seeds OPFS first (the manifest, so
 * no app code runs), then the app loads with the test hook.
 */
async function boot(page, files = FILES) {
  watchPage(page);
  await page.goto(`${server.url}/manifest.webmanifest`);
  await opfsWrite(page, files);
  await page.goto(`${server.url}/index.html?opfs=1`);
  await waitBooted(page);
  expect(await page.evaluate(() => window.__bridge.kind)).toBe('web');
  await expect.poll(() => page.evaluate(async () => (await window.__bridge.rootInfo()).root)).toMatch(/^web:[0-9a-f]{16}$/);
}

const current = (page) => page.evaluate(() => window.__ose.route.current());
const routePath = async (page) => (await current(page))?.path ?? null;

function editor(page) {
  return page.locator('.ProseMirror[contenteditable="true"]:visible, .cm-content[contenteditable="true"]:visible').first();
}

async function openPage(page, rel, { tab = 'current' } = {}) {
  await page.evaluate(async ({ rel, tab }) => {
    const r = { type: 'page', path: rel };
    if (tab === 'new' && window.__ose.tabs) await window.__ose.tabs.open(r, { reuse: false });
    else await window.__ose.route.navigate(r);
  }, { rel, tab });
  await expect(editor(page)).toBeVisible();
  await expect.poll(() => routePath(page)).toBe(rel);
}

async function typeAtEnd(page, lineText, text) {
  await editor(page).getByText(lineText, { exact: false }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text, { delay: 15 });
}

function treeRow(page, rel) {
  return page.locator(`.sb-row[data-path="${rel}"]:not(.sb-pin)`).first();
}

/** Every ancestor of `rel` expanded in the tree, and its row on screen. */
async function revealInTree(page, rel) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    if (await treeRow(page, parts.slice(0, i + 1).join('/')).isVisible()) continue;
    const row = treeRow(page, parts.slice(0, i).join('/'));
    await expect(row).toBeVisible();
    const chev = row.locator('.sb-chev, .chev, [data-chevron]').first();
    if (await chev.count()) await chev.click();
    else { await row.focus(); await page.keyboard.press('ArrowRight'); }
  }
  await expect(treeRow(page, rel)).toBeVisible();
}

function tabState(page) {
  return page.evaluate(() => {
    const t = window.__ose.tabs;
    const key = (r) => (!r ? null : r.type === 'view' ? `view:${r.name}` : `${r.type}:${r.path}`);
    const active = t.active();
    return { tabs: t.list().map((x) => key(x.route)), active: active ? key(active.route) : null, activeId: active ? active.id : null };
  });
}

test('1. a first visit shows the chooser; Choose folder… opens the vault, and it stays open on reload', async ({ page }) => {
  // The picker answers the origin's private folder: the one thing a headless browser cannot
  // click through. Everything after it (pickVault, the adopt, the reload into the vault) is real.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: async () => navigator.storage.getDirectory(), configurable: true });
  });
  await page.goto(`${server.url}/manifest.webmanifest`);
  await opfsWrite(page, { 'first.md': '# First\n\nHello.\n' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${server.url}/index.html`);
  const choose = page.getByRole('button', { name: /Choose folder/ });
  await expect(choose).toBeVisible({ timeout: 30_000 });
  // No vault is not an error: no toast about a state file that cannot exist yet.
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  await choose.click();
  await waitBooted(page);
  await expect(treeRow(page, 'first.md')).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await waitBooted(page);
  await expect(treeRow(page, 'first.md')).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('2. open, type, save: the bytes in the vault are exactly the typed file', async ({ page }) => {
  const rel = 'notes/type.md';
  await boot(page);
  await openPage(page, rel);
  await typeAtEnd(page, 'The first paragraph.', ' typed-web');
  const want = Buffer.from(FILES[rel].replace('The first paragraph.', 'The first paragraph. typed-web'), 'utf8');
  await expect.poll(async () => (await opfsBytes(page, rel))?.toString('hex'), { timeout: 15_000 }).toBe(want.toString('hex'));
  // Ctrl+S on a saved page writes nothing new, and the rest of the file is untouched.
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(800);
  expect((await opfsBytes(page, rel))?.equals(want)).toBe(true);
  // The replaced bytes kept as a version, where the desktop keeps them: `.ose/history/<path>/`.
  const versions = await page.evaluate((p) => window.__bridge.call('versionList', p), rel);
  expect(versions.length).toBeGreaterThan(0);
  const kept = (await opfsList(page, `.ose/history/${rel}`)) || [];
  expect(kept.length).toBe(versions.length);
  expect(await page.evaluate(({ p, id }) => window.__bridge.call('versionRead', p, id), { p: rel, id: versions.at(-1).id })).toBe(FILES[rel]);
  // The watcher runs on the platform's observer here, not the polling fallback.
  expect(await page.evaluate(() => typeof FileSystemObserver)).toBe('function');
});

test('3. a page with a BOM and CRLF endings keeps both when typed into', async ({ page }) => {
  const rel = 'notes/crlf.md';
  const text = '\uFEFF# Crlf\r\n\r\nThe first paragraph.\r\n\r\n- one\r\n- two\r\n';
  await boot(page, { ...FILES, [rel]: text });
  await openPage(page, rel);
  await typeAtEnd(page, 'The first paragraph.', ' typed-crlf');
  const want = Buffer.from(text.replace('The first paragraph.', 'The first paragraph. typed-crlf'), 'utf8');
  expect(want.subarray(0, 3).toString('hex')).toBe('efbbbf');
  await expect.poll(async () => (await opfsBytes(page, rel))?.toString('hex'), { timeout: 15_000 }).toBe(want.toString('hex'));
});

test('4. a change made outside the app merges into the open page', async ({ page }) => {
  const rel = 'notes/merge.md';
  const want = LONG.replace('Line one of the page.', 'Line one of the page. ours')
    .replace('Line nine at the end.', 'Line nine at the end. theirs');
  await boot(page);
  await openPage(page, rel);
  await typeAtEnd(page, 'Line one of the page.', ' ours');
  await opfsWrite(page, { [rel]: LONG.replace('Line nine at the end.', 'Line nine at the end. theirs') });

  await expect(editor(page)).toContainText('Line nine at the end. theirs', { timeout: 15_000 });
  await expect(editor(page)).toContainText('Line one of the page. ours');
  await expect.poll(() => opfsText(page, rel), { timeout: 15_000 }).toBe(want);
});

test('5. a change made outside a clean page is taken in place, and Ctrl+Z does not undo it', async ({ page }) => {
  const rel = 'notes/merge.md';
  const ours = LONG.replace('Line one of the page.', 'Line one of the page. ours');
  await boot(page);
  await openPage(page, rel);
  await typeAtEnd(page, 'Line one of the page.', ' ours');
  await expect.poll(() => opfsText(page, rel), { timeout: 15_000 }).toBe(ours);
  await page.waitForTimeout(800);

  const theirs = ours.replace('Line nine at the end.', 'Line nine at the end. theirs-by-agent');
  await opfsWrite(page, { [rel]: theirs });
  await expect(editor(page)).toContainText('theirs-by-agent', { timeout: 15_000 });
  await page.waitForTimeout(500);

  await editor(page).getByText('Line one of the page.', { exact: false }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(2500);
  await expect(editor(page)).toContainText('Line nine at the end. theirs-by-agent');
  expect(await opfsText(page, rel)).toContain('Line nine at the end. theirs-by-agent');
});

test('6. without FileSystemObserver, the polling watcher brings the change in', async ({ page }) => {
  await page.addInitScript(() => { delete window.FileSystemObserver; });
  const rel = 'notes/merge.md';
  await boot(page);
  expect(await page.evaluate(() => typeof window.FileSystemObserver)).toBe('undefined');
  await openPage(page, rel);
  await opfsWrite(page, { [rel]: LONG.replace('Line nine at the end.', 'Line nine at the end. polled') });
  await expect(editor(page)).toContainText('Line nine at the end. polled', { timeout: 15_000 });
  await opfsWrite(page, { 'notes/new-from-outside.md': '# New\n' });
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.sb-row[data-path]')].map((n) => n.getAttribute('data-path'))), { timeout: 15_000 })
    .toContain('notes/new-from-outside.md');
});

test('7. rename an open page with F2: the file moves and the page follows', async ({ page }) => {
  const rel = 'notes/rename.md';
  const moved = 'notes/renamed.md';
  const want = FILES[rel].replace('The first paragraph.', 'The first paragraph. typed-rename');
  await boot(page);
  await openPage(page, rel);
  await typeAtEnd(page, 'The first paragraph.', ' typed-rename');

  await revealInTree(page, rel);
  await treeRow(page, rel).focus();
  await page.keyboard.press('F2');
  const input = page.locator('[role="dialog"] input').last();
  await expect(input).toBeVisible();
  await input.fill('renamed.md');
  await page.keyboard.press('Enter');

  await expect.poll(() => opfsText(page, moved), { timeout: 15_000 }).toBe(want);
  expect(await opfsBytes(page, rel)).toBeNull();
  await expect.poll(() => routePath(page)).toBe(moved);
  await expect(treeRow(page, moved)).toBeVisible();
});

test('8. Delete in the tree moves the file to the vault bin, with its sidecar', async ({ page }) => {
  const rel = 'notes/trash.md';
  await boot(page);
  await revealInTree(page, rel);
  await treeRow(page, rel).focus();
  await page.keyboard.press('Delete');

  await expect.poll(() => opfsBytes(page, rel), { timeout: 15_000 }).toBeNull();
  await expect(page.getByText(/\.trash in this vault/).first()).toBeVisible();
  const bin = (await opfsList(page, '.trash')) || [];
  const entry = bin.find((n) => n.endsWith('-trash.md'));
  expect(entry, `bin: ${bin.join(', ')}`).toBeTruthy();
  expect(await opfsText(page, `.trash/${entry}`)).toBe(FILES[rel]);
  const info = JSON.parse((await opfsText(page, `.trash/.info/${entry}.json`)) || 'null');
  expect(info).toMatchObject({ v: 1, original: rel, kind: 'file' });
  await expect(treeRow(page, rel)).toHaveCount(0);
  // The bin itself is not a row of the tree (a dot folder, behind Show hidden).
  await expect(treeRow(page, '.trash')).toHaveCount(0);
});

test('8b. the tree by keyboard: a range selection, type-ahead, the context menu, Enter opens', async ({ page }) => {
  const at = (rel) => treeRow(page, rel);
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-path') ?? null);
  await boot(page);
  await revealInTree(page, 'notes/tab-a.md');

  // Shift+Down grows the selection from the focused row to the next one (C17).
  await at('notes/tab-a.md').focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(at('notes/tab-a.md')).toHaveAttribute('aria-selected', 'true');
  await expect(at('notes/tab-b.md')).toHaveAttribute('aria-selected', 'true');
  await expect(at('notes/merge.md')).toHaveAttribute('aria-selected', 'false');

  // A plain arrow goes back to one row, and a letter finds the next row that starts with it.
  await page.keyboard.press('ArrowUp');
  await expect(at('notes/tab-b.md')).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('o');
  await expect.poll(focused).toBe('notes/offline.md');

  // Shift+F10 is the context menu of the focused row; Escape closes it and gives the row back.
  await page.keyboard.press('Shift+F10');
  await expect(page.locator('[role="menu"]').last()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await expect.poll(focused).toBe('notes/offline.md');

  // Enter opens the file.
  await page.keyboard.press('Enter');
  await expect.poll(() => routePath(page)).toBe('notes/offline.md');
});

test('9. a reload restores the tabs and the active page', async ({ page }) => {
  await boot(page);
  await openPage(page, 'notes/tab-a.md');
  const tabA = (await tabState(page)).activeId;
  await openPage(page, 'notes/tab-b.md', { tab: 'new' });
  await page.evaluate(() => window.__ose.tabs.open({ type: 'folder', path: 'notes' }, { reuse: false }));
  await page.evaluate((id) => window.__ose.tabs.activate(id), tabA);
  await expect.poll(() => routePath(page)).toBe('notes/tab-a.md');
  const before = await tabState(page);
  expect(before.tabs).toEqual(['page:notes/tab-a.md', 'page:notes/tab-b.md', 'folder:notes']);

  await page.waitForTimeout(1200);
  await page.reload();
  await waitBooted(page);
  await expect.poll(async () => {
    const s = await tabState(page);
    return { tabs: s.tabs, active: s.active };
  }, { timeout: 15_000 }).toEqual({ tabs: before.tabs, active: before.active });
  await expect(editor(page)).toContainText('The first paragraph.');
});

test('10. vault media: the worker serves a vault file at its assetUrl, with ranges', async ({ page }) => {
  await boot(page, { ...FILES, 'media/pic.png': 'not really a png, but its bytes', '.ose/state.json': '{}\n' });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);
  const r = await page.evaluate(async () => {
    const url = window.__bridge.assetUrl('media/pic.png');
    const whole = await fetch(url);
    const part = await fetch(url, { headers: { Range: 'bytes=4-9' } });
    const hidden = await fetch(window.__bridge.assetUrl('.ose/state.json'));
    return { url, status: whole.status, type: whole.headers.get('content-type'), text: await whole.text(),
      partStatus: part.status, part: await part.text(), hidden: hidden.status };
  });
  expect(r.url).toMatch(/\/vault\/[0-9a-f]{16}\/media\/pic\.png$/);
  expect(r).toMatchObject({ status: 200, type: 'image/png', text: 'not really a png, but its bytes', partStatus: 206, part: 'really' });
  // The hide rule holds at the worker too: `.ose` is never served.
  expect(r.hidden).toBe(404);
});

test('10b. vault html and svg are sandboxed: opened in a tab, their script never runs with the app\'s origin', async ({ page, context }) => {
  await boot(page, { ...FILES, 'media/evil.html': '<title>page</title><script>document.title = "ran"</script>', 'media/evil.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>document.title = "ran"</script></svg>' });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);
  const r = await page.evaluate(async () => {
    const out = {};
    for (const n of ['media/evil.html', 'media/evil.svg']) {
      const res = await fetch(window.__bridge.assetUrl(n));
      out[n] = { csp: res.headers.get('content-security-policy'), nosniff: res.headers.get('x-content-type-options'), url: res.url };
    }
    return out;
  });
  expect(r['media/evil.html']).toMatchObject({ csp: 'sandbox', nosniff: 'nosniff' });
  expect(r['media/evil.svg']).toMatchObject({ csp: 'sandbox', nosniff: 'nosniff' });
  const tab = await context.newPage();
  await tab.goto(r['media/evil.html'].url);
  expect(await tab.evaluate(() => self.origin)).toBe('null');
  expect(await tab.title()).toBe('page');
  await tab.close();
});

test('11. offline: after the first visit the app loads from the service worker alone', async ({ page, context }) => {
  const rel = 'notes/offline.md';
  await boot(page);
  // The worker has taken the page and cached the build.
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => page.evaluate(async () => {
    const keys = await caches.keys();
    let n = 0;
    for (const k of keys) n += (await (await caches.open(k)).keys()).length;
    return n;
  }), { timeout: 30_000 }).toBeGreaterThan(100);

  // No network at all: the browser offline, and the server gone too.
  await context.setOffline(true);
  await server.close();
  try {
    const seen = server.requests.length;
    await page.reload();
    await waitBooted(page);
    expect(server.requests.length).toBe(seen);
    await openPage(page, rel);
    await typeAtEnd(page, 'The first paragraph.', ' typed-offline');
    await expect.poll(() => opfsText(page, rel), { timeout: 15_000 })
      .toBe(FILES[rel].replace('The first paragraph.', 'The first paragraph. typed-offline'));
  } finally {
    await context.setOffline(false);
    server = await serveStatic(DIST, port);
  }
});
