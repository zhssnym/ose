// What every no-loss scenario needs, over Ose Web: the vault (the origin's private file system,
// which the app opens through the `?opfs=1` test hook, src/web/adapter.js), the bytes in it, a
// fault switch on the writes, the drafts, the log, and a few moves in the page (boot, open a
// page, type at the end of a line, the active route and tabs).
//
// Every test runs in a fresh browser profile (test.js), so it starts at a first launch with an
// empty vault: `boot` seeds it with fixtures.js first. The vault is read and written from inside the
// page, the way another program writes a folder on disk, never through the app.
//
// The page is driven by keyboard and mouse like a person would; `window.__ose` (the kernel's
// debugging handle, kernel.js) is read to know where the app is, and used to open a route only
// where a person would have clicked something the scenario is not about.

import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { FILES } from './fixtures.js';

/** @typedef {import('@playwright/test').Page} Page */

/** The sessionStorage key the fault switch reads (see `installFaults`). */
const FAULT_KEY = 'ose.e2e.fault';

/**
 * The fault switch, installed in every document before the app's own scripts: a write to a
 * file whose name is armed fails in `createWritable` with the DOMException a full or locked
 * disk gives, which src/web/rules.js `fromDom` turns into the host error. It lives in
 * sessionStorage, so it holds across a reload of the tab, as a disk fault would.
 */
function installFaults(key) {
  const P = globalThis.FileSystemFileHandle && globalThis.FileSystemFileHandle.prototype;
  if (!P || P.__oseFaults) return;
  const original = P.createWritable;
  P.createWritable = function createWritable(...args) {
    let f = null;
    try { f = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { f = null; }
    if (f && f.name === this.name) return Promise.reject(new DOMException(f.message, f.dom));
    return original.apply(this, args);
  };
  P.__oseFaults = true;
}

/**
 * Arm the fault switch for one vault file, or clear it with null. `code` is the host error the
 * write must end in: `write_failed` (a full disk) or `io` (a file another program holds).
 * @param {Page} page
 * @param {{ path: string, code: 'write_failed' | 'io', message?: string } | null} spec
 */
export async function devFault(page, spec) {
  const value = spec
    ? JSON.stringify({
      name: spec.path.split('/').at(-1),
      dom: spec.code === 'write_failed' ? 'QuotaExceededError' : 'OperationError',
      message: spec.message || 'e2e fault',
    })
    : null;
  await page.evaluate(({ key, value }) => {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  }, { key: FAULT_KEY, value });
}

/**
 * One host command through the app's own bridge (`window.__bridge`, src/kernel/bridge/index.js).
 * @param {Page} page @param {string} cmd @param {...any} args
 * @returns {Promise<any>}
 */
export function bridge(page, cmd, ...args) {
  return page.evaluate(({ cmd, args }) => window.__bridge[cmd](...args), { cmd, args });
}

/** The paths that have a draft on this machine. @param {Page} page */
export async function draftPaths(page) {
  try {
    const list = await bridge(page, 'draftList');
    return (list || []).map((d) => d.path);
  } catch { return []; }
}

/** Write vault files straight into the vault, as another program would. @param {Page} page */
export async function writeFiles(page, files) {
  await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for (const [rel, bytes] of Object.entries(files)) {
      const parts = rel.split('/');
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const h = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await h.createWritable();
      await w.write(new Uint8Array(bytes));
      await w.close();
    }
  }, Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, [...Buffer.from(text, 'utf8')]])));
}

/** Write one vault file the way another program would. @param {Page} page */
export function writeDisk(page, rel, text) {
  return writeFiles(page, { [rel]: text });
}

/** A vault file's bytes and time, or null when it is not there. @param {Page} page */
async function readVault(page, rel) {
  const r = await page.evaluate(async (rel) => {
    try {
      const parts = rel.split('/');
      let dir = await navigator.storage.getDirectory();
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      const f = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
      return { bytes: Array.from(new Uint8Array(await f.arrayBuffer())), mtime: f.lastModified };
    } catch { return null; }
  }, rel);
  return r && { bytes: Buffer.from(r.bytes), mtime: r.mtime };
}

/** A vault file's bytes, or null. @param {Page} page @returns {Promise<Buffer | null>} */
export async function diskBytes(page, rel) {
  const r = await readVault(page, rel);
  return r ? r.bytes : null;
}

/** A vault file's text, or null when it is not there. @param {Page} page */
export async function disk(page, rel) {
  const b = await diskBytes(page, rel);
  return b ? b.toString('utf8') : null;
}

/**
 * Every file of the vault and its size, by vault path, but for `.ose` and `.git`.
 * @param {Page} page @returns {Promise<Map<string, number>>}
 */
export async function vaultFiles(page) {
  const list = await page.evaluate(async () => {
    const out = [];
    const walk = async (dir, at) => {
      for await (const [name, h] of dir.entries()) {
        if (name === '.ose' || name === '.git') continue;
        const rel = at ? `${at}/${name}` : name;
        if (h.kind === 'directory') await walk(h, rel);
        else out.push([rel, (await h.getFile()).size]);
      }
    };
    await walk(await navigator.storage.getDirectory(), '');
    return out;
  });
  return new Map(list);
}

/** What says a file was not written: its bytes' digest and its time. @param {Page} page */
export async function stamp(page, rel) {
  const r = await readVault(page, rel);
  if (!r) throw new Error(`${rel} is not in the vault`);
  return { sha: createHash('sha256').update(r.bytes).digest('hex'), mtime: r.mtime };
}

/** The log so far (IndexedDB `ose-web`, store `log`, src/web/local.js): every save is a line. */
export function logText(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open('ose-web');
    open.onerror = () => resolve('');
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('log')) { db.close(); resolve(''); return; }
      const req = db.transaction('log', 'readonly').objectStore('log').getAll();
      req.onsuccess = () => { db.close(); resolve(req.result.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')); };
      req.onerror = () => { db.close(); resolve(''); };
    };
  }));
}

/**
 * Put the page on screen in `mode` ('rich', 'live' or 'source') with the meta line's switch, as
 * a person would, and wait until it is.
 * @param {Page} page
 * @param {'rich'|'live'|'source'} mode
 */
export async function setMode(page, mode) {
  const btn = page.locator(`.ed-mode-btn[data-mode="${mode}"]:visible`).first();
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  if (mode === 'live') await expect(liveEditor(page)).toBeVisible();
}

/** The Live editor's content on screen. */
export function liveEditor(page) {
  return page.locator('.cm-live .cm-content:visible').first();
}

/**
 * A first launch over a vault holding `files`: a document of the origin seeds the vault first
 * (the manifest, so no app code runs), then the app loads with the test hook. A reload keeps
 * the hook, since it keeps the query.
 * @param {Page} page
 */
export async function boot(page, files = FILES) {
  watchPage(page);
  await page.addInitScript(installFaults, FAULT_KEY);
  await page.goto('/manifest.webmanifest');
  await writeFiles(page, files);
  await page.goto('/index.html?opfs=1');
  await waitBooted(page);
}

/**
 * What the page said while it booted: its console errors and warnings, uncaught errors, and
 * whether it crashed or closed. Kept per page, so a boot that fails says why instead of only
 * "the page was closed".
 * @param {Page} page
 */
export function watchPage(page) {
  const p = /** @type {any} */ (page);
  if (p.__oseLog) return p.__oseLog;
  /** @type {string[]} */
  const log = [];
  p.__oseLog = log;
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => log.push(`pageerror: ${e && e.stack ? e.stack : e}`));
  page.on('crash', () => log.push('the page crashed'));
  page.on('close', () => log.push('the page closed'));
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) log.push(`navigated to ${f.url()}`); });
  return log;
}

/** Wait for the kernel and a route after a load or a reload. */
export async function waitBooted(page) {
  const log = watchPage(page);
  try {
    await page.waitForFunction(() => !!(window.__ose && window.__ose.route && window.__ose.route.current()), null, { timeout: 30_000 });
  } catch (e) {
    throw new Error(`the app did not boot: ${e && e.message ? e.message : e}\n--- what the page said ---\n${log.slice(-40).join('\n') || '(nothing)'}`);
  }
}

/** The route on screen. */
export function current(page) {
  return page.evaluate(() => window.__ose.route.current());
}

/** The route keys of the tab strip and the active one (CONTRACT §4.3). */
export function tabState(page) {
  return page.evaluate(() => {
    const t = window.__ose.tabs;
    if (!t) return null;
    const key = (r) => (!r ? null : r.type === 'view' ? `view:${r.name}` : `${r.type}:${r.path}`);
    const active = t.active();
    return { tabs: t.list().map((x) => key(x.route)), active: active ? key(active.route) : null, ids: t.list().map((x) => x.id), activeId: active ? active.id : null };
  });
}

/** The editable surface of the page on screen: Rich (ProseMirror) or Source (CodeMirror). */
export function editor(page) {
  return page.locator('.ProseMirror[contenteditable="true"]:visible, .cm-content[contenteditable="true"]:visible').first();
}

/**
 * Open a page as a person would from quick open, in the current tab or a new one, and wait
 * for its editor.
 * @param {{ tab?: 'current'|'new' }} [opts]
 */
export async function openPage(page, rel, { tab = 'current' } = {}) {
  await page.evaluate(async ({ rel, tab }) => {
    const r = { type: 'page', path: rel };
    if (tab === 'new' && window.__ose.tabs) await window.__ose.tabs.open(r, { reuse: false });
    else await window.__ose.route.navigate(r);
  }, { rel, tab });
  await expect(editor(page)).toBeVisible();
  await expect.poll(async () => (await current(page))?.path).toBe(rel);
}

/** Click at the end of the line holding `lineText` and type `text` there. */
export async function typeAtEnd(page, lineText, text) {
  const ed = editor(page);
  await ed.getByText(lineText, { exact: false }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text, { delay: 15 });
}

/** The text of the editor on screen. */
export async function buffer(page) {
  return editor(page).innerText();
}

/** A tree row by vault path (shell/sidebar.js keeps `.sb-row[data-path]`). */
export function treeRow(page, rel) {
  return page.locator(`.sb-row[data-path="${rel}"]:not(.sb-pin)`).first();
}

/** Make a folder's rows visible in the tree: every ancestor expanded. */
export async function revealInTree(page, rel) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/');
    if (await treeRow(page, parts.slice(0, i + 1).join('/')).isVisible()) continue;
    const row = treeRow(page, dir);
    await expect(row).toBeVisible();
    // The chevron expands; the row itself opens the folder view (CONTRACT §7.1).
    const chev = row.locator('.sb-chev, .chev, [data-chevron]').first();
    if (await chev.count()) await chev.click();
    else { await row.focus(); await page.keyboard.press('ArrowRight'); }
  }
  await expect(treeRow(page, rel)).toBeVisible();
}
