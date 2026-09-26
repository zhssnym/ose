// @vitest-environment happy-dom
// The Live view (src/editor/live/view.js) as page.js drives it: getText is the file's bytes,
// setText and replaceMinimal are not user edits, every command of LIVE_COMMANDS is a text edit
// of the markdown, and a read-only page takes none of them.
import { describe, it, expect, afterEach } from 'vitest';
import { createLiveView } from '../../../src/editor/live/view.js';
import { LIVE_COMMANDS } from '../../../src/editor/live/commands.js';

const views = [];
afterEach(() => { while (views.length) views.pop().destroy(); document.body.innerHTML = ''; });

function mount(text, o = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const log = { changes: 0, opened: [] };
  const lv = createLiveView({
    host, text, path: 'notes/a.md', widgets: [], paste: null,
    resolveAsset: () => null,
    onOpenLink: (href, x) => log.opened.push([href, x.newTab]),
    onChange: () => { log.changes++; },
    ...o,
  });
  views.push(lv);
  return { lv, log };
}

/** Select [from, to] of the document and run a command; the text CodeMirror holds after. */
function run(lv, id, from, to = from) {
  lv.setSelection({ from, to });
  const ok = lv.run(id);
  return { ok, doc: lv.viewText() };
}

describe('the buffer', () => {
  it('getText gives back BOM, CRLF and CR exactly, and after an edit keeps them', () => {
    const t = '﻿# T\r\n\r\nx\ry\r\n';
    const { lv, log } = mount(t);
    expect(lv.getText()).toBe(t);
    expect(lv.viewText()).toBe('# T\n\nx\ny\n');
    lv.view.dispatch({ changes: { from: 5, insert: 'X' }, userEvent: 'input.type' });
    expect(lv.getText()).toBe('﻿# T\r\n\r\nXx\ry\r\n');
    expect(log.changes).toBe(1);
  });

  it('setText is not an edit: no onChange, and dropping history leaves nothing to undo', () => {
    const { lv, log } = mount('');
    expect(lv.setText('a\r\nb', { history: 'drop' })).toBe(true);
    expect(log.changes).toBe(0);
    expect(lv.getText()).toBe('a\r\nb');
    expect(lv.setText('a\r\nb')).toBe(false);
  });

  it('replaceMinimal keeps the caret where the text did not change, and is an edit only when asked', () => {
    const { lv, log } = mount('one\ntwo\nthree\n');
    lv.setSelection({ from: 9 });                      // in "three"
    expect(lv.replaceMinimal('ONE\ntwo\nthree\n')).toBe(true);
    expect(lv.selection()).toEqual({ from: 9, to: 9 });
    expect(log.changes).toBe(0);
    lv.replaceMinimal('ONE\ntwo\nthree!\n', { edit: true });
    expect(log.changes).toBe(1);
    expect(lv.getText()).toBe('ONE\ntwo\nthree!\n');
  });

  it('a text from outside brings its own line endings', () => {
    const { lv } = mount('a\nb\n');
    lv.replaceMinimal('a\r\nb\r\n');
    expect(lv.getText()).toBe('a\r\nb\r\n');
  });

  it('opens with the caret after the frontmatter, and restores a snapshot', () => {
    const t = '---\na: 1\n---\nbody\n';
    const { lv } = mount(t);
    expect(lv.selection().from).toBe(t.indexOf('body'));
    const snap = lv.snapshot();
    expect(snap.mode).toBe('live');
    const { lv: again } = mount(t, { restore: { mode: 'live', from: 2, to: 5, scrollTop: 0 } });
    expect(again.selection()).toEqual({ from: 2, to: 5 });
  });

  it('goToLine is 1-based and clamps', () => {
    const { lv } = mount('a\nbb\nccc\n');
    expect(lv.goToLine(3, 2)).toBe(true);
    expect(lv.selection().from).toBe(6);
    expect(lv.goToLine(99)).toBe(true);
    expect(lv.goToLine(Number.NaN)).toBe(false);
  });
});

describe('the commands', () => {
  it('declares every required id', () => {
    const required = ['format.bold', 'format.italic', 'format.strike', 'format.code', 'format.link',
      'block.paragraph', 'block.h1', 'block.h2', 'block.h3', 'block.h4', 'block.h5', 'block.h6',
      'block.bullet', 'block.numbered', 'block.task', 'block.quote', 'block.toggle-task', 'page.follow-link'];
    for (const id of required) expect(LIVE_COMMANDS).toContain(id);
  });

  it('wraps and unwraps inline marks', () => {
    const { lv } = mount('a word here');
    expect(run(lv, 'format.bold', 2, 6).doc).toBe('a **word** here');
    expect(lv.selection()).toEqual({ from: 4, to: 8 });
    expect(run(lv, 'format.bold', 4, 8).doc).toBe('a word here');
    expect(run(lv, 'format.italic', 2, 6).doc).toBe('a _word_ here');
    expect(run(lv, 'format.italic', 4, 5).doc).toBe('a word here');      // inside the mark
    expect(run(lv, 'format.strike', 2, 6).doc).toBe('a ~~word~~ here');
    lv.setText('a word here');
    expect(run(lv, 'format.code', 2, 6).doc).toBe('a `word` here');
    lv.setText('ab');
    expect(run(lv, 'format.bold', 1).doc).toBe('a****b');
    expect(lv.selection()).toEqual({ from: 3, to: 3 });
  });

  it('writes a link around the selection', () => {
    const { lv } = mount('see this');
    expect(run(lv, 'format.link', 4, 8).doc).toBe('see [this]()');
    expect(lv.selection().from).toBe(11);
    lv.setText('https://x.test');
    expect(run(lv, 'format.link', 0, 14).doc).toBe('[](https://x.test)');
    lv.setText('x');
    expect(run(lv, 'format.link', 1).doc).toBe('x[]()');
  });

  it('sets and toggles headings, and back to a paragraph', () => {
    const { lv } = mount('Title\n- item');
    expect(run(lv, 'block.h1', 0).doc).toBe('# Title\n- item');
    expect(run(lv, 'block.h3', 0).doc).toBe('### Title\n- item');
    expect(run(lv, 'block.h3', 0).doc).toBe('Title\n- item');
    expect(run(lv, 'block.h2', 7).doc).toBe('Title\n## item');
    expect(run(lv, 'block.paragraph', 7).doc).toBe('Title\nitem');
    for (const n of [4, 5, 6]) {
      lv.setText('x');
      expect(run(lv, `block.h${n}`, 0).doc).toBe(`${'#'.repeat(n)} x`);
    }
  });

  it('lists: bullets, numbers, tasks, over several lines, blank lines left alone', () => {
    const { lv } = mount('a\n\nb\nc');
    expect(run(lv, 'block.bullet', 0, 6).doc).toBe('- a\n\n- b\n- c');
    expect(run(lv, 'block.bullet', 0, 10).doc).toBe('a\n\nb\nc');
    expect(run(lv, 'block.numbered', 0, 6).doc).toBe('1. a\n\n2. b\n3. c');
    lv.setText('a');
    expect(run(lv, 'block.task', 0).doc).toBe('- [ ] a');
    expect(run(lv, 'block.task', 0).doc).toBe('a');
  });

  it('quotes toggle one level', () => {
    const { lv } = mount('a\nb');
    expect(run(lv, 'block.quote', 0, 3).doc).toBe('> a\n> b');
    expect(run(lv, 'block.quote', 0, 7).doc).toBe('a\nb');
  });

  it('toggle-task changes one character, and says no where there is no task', () => {
    const t = '- [ ] a\r\n- [x] b\r\nplain\r\n';
    const { lv, log } = mount(t);
    expect(run(lv, 'block.toggle-task', 2).ok).toBe(true);
    expect(run(lv, 'block.toggle-task', 10).ok).toBe(true);
    expect(lv.getText()).toBe('- [x] a\r\n- [ ] b\r\nplain\r\n');
    expect(run(lv, 'block.toggle-task', 17).ok).toBe(false);
    expect(log.changes).toBe(2);
  });

  it('the optional block commands', () => {
    const { lv } = mount('one\ntwo');
    expect(run(lv, 'block.move-down', 0).doc).toBe('two\none');
    expect(run(lv, 'block.move-up', 4).doc).toBe('one\ntwo');
    expect(run(lv, 'block.duplicate', 0).doc).toBe('one\none\ntwo');
    expect(run(lv, 'block.delete', 0).doc).toBe('one\ntwo');
    expect(run(lv, 'block.code', 0).doc).toBe('```\none\n```\ntwo');
  });

  it('every change a command makes is a Live edit', () => {
    const { lv } = mount('a');
    const events = [];
    const orig = lv.view.dispatch.bind(lv.view);
    lv.view.dispatch = (...trs) => {
      for (const t of trs) {
        const tr = t && t.changes && t.startState ? t : lv.view.state.update(t);
        if (tr.docChanged) events.push(tr.isUserEvent('input.live'));
      }
      return orig(...trs);
    };
    for (const id of ['format.bold', 'block.h1', 'block.bullet', 'block.quote', 'block.duplicate']) run(lv, id, 0, 1);
    expect(events.length).toBe(5);
    expect(events.every(Boolean)).toBe(true);
  });

  it('a read-only page takes no command, and says so', () => {
    const { lv } = mount('a', { readOnly: true });
    for (const id of LIVE_COMMANDS) if (id !== 'page.follow-link') expect(run(lv, id, 0, 1).ok).toBe(false);
    expect(lv.viewText()).toBe('a');
    lv.setReadOnly(false);
    expect(run(lv, 'block.h1', 0).ok).toBe(true);
  });
});

describe('links', () => {
  it('follows the link under the caret', () => {
    const { lv, log } = mount('see [x](https://x.test) and <https://y.test> and [[Page#Part|p]]');
    expect(run(lv, 'page.follow-link', 5).ok).toBe(true);
    lv.setSelection({ from: 30 });
    expect(lv.linkAtCaret()).toBe('https://y.test');
    lv.setSelection({ from: 52 });
    expect(lv.linkAtCaret()).toBe('Page.md#Part');
    lv.setSelection({ from: 0 });
    expect(lv.linkAtCaret()).toBe(null);
    expect(lv.run('page.follow-link')).toBe(false);
    expect(log.opened).toEqual([['https://x.test', false]]);
  });

  it('resolves a wikilink through the page when it can', () => {
    const { lv } = mount('[[Target]]', {
      resolveWikilink: () => ({ path: 'other/Target.md', exists: true }),
      linkTo: (p) => `../${p}`,
    });
    lv.setSelection({ from: 3 });
    expect(lv.linkAtCaret()).toBe('../other/Target.md');
  });
});
