// @vitest-environment happy-dom
//
// Body keys win (CONTRACT §4.9): a chord the editor body binds itself (Alt+Up moves the block)
// falls through to the editor while the caret is in a page, and the `keys.json` binding of the
// same chord (`folder.up`, "Go to parent folder") applies everywhere else: in the tree, in the
// folder view, on the page chrome.
//
// Depends on: core (src/core/keys.js, registry.js), shell-surfaces (shell/keys.json).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/bridge/index.js', () => import('./fake-bridge.js'));

const { bindKey, initKeys } = await import('../../src/core/keys.js');
const { commands } = await import('../../src/core/registry.js');

const ran = [];

beforeAll(() => {
  commands.register({ id: 'folder.up', title: 'Go to parent folder', run: () => { ran.push('folder.up'); } });
  bindKey('alt+arrowup', 'folder.up');
  initKeys();
});

/** Alt+Up pressed with `el` focused; answers whether the page kept the default (the editor's turn). */
function altUp(el) {
  el.focus();
  const e = new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', altKey: true, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return !e.defaultPrevented;
}

describe('body keys win', () => {
  it('Alt+Up inside the rich editor is the editor\'s, not folder.up', () => {
    document.body.innerHTML = '<div class="ProseMirror" contenteditable="true"><p tabindex="0">text</p></div>';
    ran.length = 0;
    expect(altUp(document.querySelector('.ProseMirror p'))).toBe(true);
    expect(ran).toEqual([]);
  });

  it('Alt+Up inside the Source editor is CodeMirror\'s', () => {
    document.body.innerHTML = '<div class="cm-editor"><div class="cm-content" contenteditable="true" tabindex="0">text</div></div>';
    ran.length = 0;
    expect(altUp(document.querySelector('.cm-content'))).toBe(true);
    expect(ran).toEqual([]);
  });

  it('Alt+Up anywhere else runs folder.up', () => {
    document.body.innerHTML = '<nav class="sidebar"><button class="row sb-row">a.md</button></nav>';
    ran.length = 0;
    expect(altUp(document.querySelector('.sb-row'))).toBe(false);
    expect(ran).toEqual(['folder.up']);
  });

  it('keys.json binds the chord to folder.up (CONTRACT §10)', () => {
    const keys = JSON.parse(readFileSync(path.join(process.env.OSE_REPO || process.cwd(), 'shell', 'keys.json'), 'utf8'));
    const map = keys.keys || keys;
    expect(map['alt+arrowup']).toBe('folder.up');
  });
});
