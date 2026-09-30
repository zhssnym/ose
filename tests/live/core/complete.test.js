// @vitest-environment happy-dom
// `[[` completion in Live (complete.js), table cells drawn with Live's own inline rules
// (cellhtml.js), and the find panel revealing what it selects (reveal.js).
// The widgets' shim first: it closes the happy-dom gap that trips DOMPurify (dom-shim.js).
import '../widgets/dom-shim.js';
import { describe, it, expect, afterEach } from 'vitest';
import DOMPurify from 'dompurify';
import { currentCompletions, startCompletion, acceptCompletion } from '@codemirror/autocomplete';
import { openSearchPanel, searchPanelOpen } from '@codemirror/search';
import { createLiveView } from '../../../src/editor/live/view.ts';
import { wikiQueryAt, wikiOptions } from '../../../src/editor/live/complete.ts';
import { makeInlineHtml } from '../../../src/editor/live/cellhtml.ts';
import { liveState } from '../../../src/editor/live/state.ts';
import { revealedSpans } from '../../../src/editor/live/reveal.ts';

const views = [];
afterEach(() => { while (views.length) views.pop().destroy(); document.body.innerHTML = ''; });

function mount(text, o = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let changes = 0;
  const lv = createLiveView({
    host, text, path: 'notes/a.md', widgets: [], paste: null,
    resolveAsset: () => null, onOpenLink: () => {}, onChange: () => { changes++; },
    ...o,
  });
  views.push(lv);
  return { lv, changes: () => changes };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('the [[ query', () => {
  it('is what follows the last [[ on the line, up to the caret', () => {
    const s = liveState('See [[mathem');
    expect(wikiQueryAt(s, s.doc.length)).toEqual({ from: 6, query: 'mathem' });
  });
  it('is nothing after ]], a bar, a heading mark, or in code', () => {
    for (const t of ['See [[x]] y', 'See [[x|al', 'See [[x#h', 'plain', '```\n[[co']) {
      const s = liveState(t);
      expect(wikiQueryAt(s, s.doc.length)).toBe(null);
    }
  });
});

describe('the rows', () => {
  it('name each page, leave this page out, and give the path where two share a name', () => {
    const rows = wikiOptions(['notes/a.md', 'Maths.md', 'x/Todo.md', 'y/Todo.md', 'pic.png'], 'notes/a.md');
    expect(rows.map((r) => r.label).sort()).toEqual(['Maths', 'x/Todo', 'y/Todo']);
  });
});

describe('completion in the view', () => {
  it('[[ offers the pages, and accepting writes target]] as one Live edit', async () => {
    const { lv, changes } = mount('See ', { pages: () => Promise.resolve(['Mathematics.md', 'notes/a.md', 'z/Other.md']) });
    const view = lv.view;
    lv.setSelection({ from: 4 });
    view.dispatch({ changes: { from: 4, insert: '[[math' }, selection: { anchor: 10 }, userEvent: 'input.type' });
    startCompletion(view);
    for (let i = 0; i < 50 && !currentCompletions(view.state).length; i++) await tick();
    const rows = currentCompletions(view.state).map((c) => c.label);
    expect(rows).toContain('Mathematics');
    // acceptCompletion ignores a list younger than its interaction delay (75 ms).
    await new Promise((r) => setTimeout(r, 120));
    const before = changes();
    expect(acceptCompletion(view)).toBe(true);
    expect(lv.viewText()).toBe('See [[Mathematics]]');
    expect(lv.selection().from).toBe('See [[Mathematics]]'.length);
    expect(changes()).toBeGreaterThan(before);
  });

  it('without a page list there is no completion source', async () => {
    const { lv } = mount('See [[ma');
    const state = lv.view.state;
    // No autocompletion extension at all: nothing is offered, nothing throws.
    expect(currentCompletions(state)).toEqual([]);
  });
});

// happy-dom's parser trips DOMPurify unless dom-shim.js is loaded first (it is, above); the
// guard stays so a happy-dom upgrade that breaks the shim skips these instead of lying.
const purifyWorks = DOMPurify.sanitize('<b>x</b><script>y</script>') === '<b>x</b>';

describe.skipIf(!purifyWorks)('table cells', () => {
  const html = makeInlineHtml({
    resolveAsset: (src) => (src === 'pic.png' ? 'ose-vault://pic.png' : null),
    resolveWikilink: (t) => ({ path: `${t}.md`, exists: t === 'Note' }),
  });

  it('draw a wikilink as Live does: the alias or the target, missing ones marked', () => {
    const box = document.createElement('div');
    box.innerHTML = html('[[Note]] and [[Gone|shown]]');
    const links = box.querySelectorAll('.cm-live-wiki');
    expect(links.length).toBe(2);
    expect(links[0].textContent).toBe('Note');
    expect(links[0].classList.contains('cm-live-missing')).toBe(false);
    expect(links[1].textContent).toBe('shown');
    expect(links[1].classList.contains('cm-live-missing')).toBe(true);
    expect(box.textContent).not.toContain('[[');
  });

  it('render maths, not its dollars', () => {
    const box = document.createElement('div');
    box.innerHTML = html('$x^2$ costs 5 $');
    expect(box.querySelector('math')).not.toBe(null);
    expect(box.textContent).toContain('5 $');
  });

  it('resolve images through the vault, and draw the missing box when they cannot', () => {
    const box = document.createElement('div');
    box.innerHTML = html('![a](pic.png) ![b](nope.png) ![[pic.png|120]]');
    const imgs = box.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    expect(imgs[0].getAttribute('src')).toBe('ose-vault://pic.png');
    expect(imgs[1].getAttribute('width')).toBe('120');
    const missing = box.querySelector('.cm-live-image-missing');
    expect(missing && missing.textContent).toContain('nope.png');
  });

  it('never let script through', () => {
    const box = document.createElement('div');
    box.innerHTML = html('<img src=x onerror=alert(1)> <script>x</script>');
    expect(box.querySelector('script')).toBe(null);
    expect(box.innerHTML).not.toContain('onerror');
  });
});

describe('find reveals what it selects', () => {
  it('an open find panel reveals the selection even while the editor has no focus', () => {
    const { lv } = mount('# T\n\n[link](https://example.com)\n');
    const view = lv.view;
    openSearchPanel(view);
    expect(searchPanelOpen(view.state)).toBe(true);
    lv.setSelection({ from: 12, to: 23 });
    expect(view.hasFocus).toBe(false);
    const spans = revealedSpans(view.state);
    expect(spans.length).toBe(1);
    expect(spans[0].from).toBe(5);
  });

  it('closed and unfocused, nothing is revealed', () => {
    const { lv } = mount('# T\n\n[link](https://example.com)\n');
    lv.setSelection({ from: 12 });
    expect(revealedSpans(lv.view.state)).toEqual([]);
  });
});
