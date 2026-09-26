// What every no-loss scenario needs: the bridge (to reset the app between scenarios, arm a
// fault, list drafts), the bytes on disk, and a few moves in the page (boot, open a page, type
// at the end of a line, the active route and tabs).
//
// The page is driven by keyboard and mouse like a person would; `window.__ose` (the kernel's
// debugging handle, kernel.js) is read to know where the app is, and used to open a route only
// where a person would have clicked something the scenario is not about.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { APPDATA, OUTSIDE, ROOT } from './env.js';

/**
 * One bridge call from the test process, the way src/kernel/bridge/http.js makes it.
 * @param {import('@playwright/test').APIRequestContext} request
 * @param {string} cmd
 * @param {...any} args
 * @returns {Promise<{ ok: boolean, result?: any, error?: string }>}
 */
export async function call(request, cmd, ...args) {
  const res = await request.post(`/__bridge/${cmd}`, { data: { args } });
  return res.json();
}

/**
 * A bridge call that must succeed; its result.
 * @returns {Promise<any>}
 */
export async function bridge(request, cmd, ...args) {
  const r = await call(request, cmd, ...args);
  if (!r.ok) throw new Error(`${cmd}: ${r.error}`);
  return r.result;
}

/**
 * Arm the dev bridge's fault switch (docs/HOST.md "devFault"), or clear it with null.
 * @param {{ cmd: string, path?: string, code: string, message?: string, times?: number } | null} spec
 */
export async function devFault(request, spec) {
  const r = await call(request, 'devFault', spec);
  if (!r.ok && spec) throw new Error(`devFault is not available: ${r.error} (OSE_DEV_FAULTS=1, host role)`);
}

/** The paths that have a draft on this machine. */
export async function draftPaths(request) {
  const r = await call(request, 'draftList');
  return r.ok ? (r.result || []).map((d) => d.path) : [];
}

/**
 * Back to a first launch between scenarios: no fault armed, no draft, no session, no recent
 * files, no per-machine settings. The page of the scenario before is closed by then; the short
 * wait lets its `pagehide` flush land before it is overwritten.
 */
export async function resetApp(request) {
  await new Promise((r) => setTimeout(r, 250));
  await call(request, 'devFault', null);
  for (const p of await draftPaths(request)) await call(request, 'draftDrop', p);
  // `localSet` is wave 2 (CONTRACT §3.1); a bridge without it answers [unknown_command].
  await call(request, 'localSet', 'vault', { migrated: 1 });
  await call(request, 'localSet', 'app', {});
}

/** A vault file's text, or null when it is not there. Always the temp copy (env.js ROOT). */
export function disk(rel) {
  const file = path.join(ROOT, ...rel.split('/'));
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** Write a vault file the way another program would: straight to disk, not through the app. */
export function writeDisk(rel, text) {
  const file = path.join(ROOT, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

/** A vault file's bytes, or null. */
export function diskBytes(rel) {
  const file = path.join(ROOT, ...rel.split('/'));
  return existsSync(file) ? readFileSync(file) : null;
}

/** What says a file was not written: its bytes' digest and its mtime. */
export function stamp(rel, dir = ROOT) {
  const file = path.join(dir, ...rel.split('/'));
  return { sha: createHash('sha256').update(readFileSync(file)).digest('hex'), mtime: statSync(file).mtimeMs };
}

/** The absolute path of a file outside the vault (`<base>/outside/<rel>`). */
export const outsidePath = (rel) => path.join(OUTSIDE, ...rel.split('/'));

/** A file outside the vault as text, or null. */
export function outsideText(rel) {
  const file = outsidePath(rel);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** Write a file outside the vault the way another program would. */
export function writeOutside(rel, text) {
  writeFileSync(outsidePath(rel), text, 'utf8');
}

/** The dev bridge's log so far (`<appdata>/logs/ose.log`): every save it did is a line. */
export function logText() {
  const file = path.join(APPDATA, 'logs', 'ose.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/**
 * Put the page on screen in `mode` ('rich', 'live' or 'source') with the meta line's switch, as
 * a person would, and wait until it is.
 * @param {import('@playwright/test').Page} page
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

/** Load the app and wait until it has a route on screen (Home, or a restored session). */
export async function boot(page) {
  await page.goto('/index.html');
  await waitBooted(page);
}

/** Wait for the kernel and a route after a load or a reload. */
export async function waitBooted(page) {
  await page.waitForFunction(() => !!(window.__ose && window.__ose.route && window.__ose.route.current()), null, { timeout: 30_000 });
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
