// The editor's module-level entry points, over one `markdownPage` instance.
//
// `ose:editor` is `lib.js`: `markdownPage`, `codeEditor`, `render`, and nothing else. This file
// is what the round-three shell still calls — `initEditor`, `openPage`, `closePage`, `saveNow`,
// `scrollToLine`, `currentSelection`, `getOpenPath` — expressed as one page at a time, which is
// the stock rice's rule and never was the library's. When K2's rice mounts `markdownPage`
// itself (`setPageHost` in `cockpit/shell/main.js`), this file goes.

import { acquireCommands, markdownPage } from './page.js';

export { markdownPage } from './page.js';
export { codeEditor } from './code-editor.js';
export { render } from './render.js';

/** @type {null | ReturnType<typeof markdownPage>} */
let page = null;
/** The reference on the commands the rice holds: `page.new` works with no page open. */
let held = null;

export function getOpenPath() {
  return page ? page.path : null;
}

export async function initEditor() {
  if (held) return;
  held = acquireCommands();
}

/**
 * Mount the file at `path` into `el`. The same element with a new path re-opens in place; a
 * different element is a different column, so the page that was in the old one is closed.
 */
export async function openPage(el, path, opts = {}) {
  if (page && page.el === el) {
    await page.open(path, opts);
    return;
  }
  await closePage();
  page = markdownPage(el, path, opts);
  await page.ready;
}

export async function closePage() {
  const p = page;
  page = null;
  if (p) await p.close();
}

export function saveNow(opts = {}) {
  return page ? page.save(opts) : Promise.resolve(true);
}

export function scrollToLine(line, col) {
  return page ? page.goToLine(line, col) : false;
}

export function currentSelection() {
  return page ? page.selection() : null;
}
