// @vitest-environment happy-dom
// Inline html drawn as what it says (src/editor/plugins.ts `htmlTagsPlugin`): a decoration, so
// the document, and the file, keep every tag.

import { describe, expect, it } from 'vitest';
import { EditorState } from '@milkdown/kit/prose/state';
import { EditorView } from '@milkdown/kit/prose/view';

const { makeEngine } = await import('../../src/editor/engine.ts');
const { htmlTagsPlugin } = await import('../../src/editor/plugins.ts');

const engine = await makeEngine();

/** The page's DOM for `md`, with the plugin on. */
function draw(md) {
  const place = document.createElement('div');
  const view = new EditorView(place, { state: EditorState.create({ doc: engine.parse(md), plugins: [htmlTagsPlugin()] }) });
  const dom = view.dom;
  view.destroy();
  return dom;
}

describe('inline html', () => {
  it('a pair of tags draws its element around the text, and the tags step aside', () => {
    const dom = draw('x<sup>2</sup> H<sub>2</sub>O, <u>under</u>, <mark>hi</mark>, <kbd>Ctrl</kbd>\n');
    expect(dom.querySelector('sup.os-html-run')?.textContent).toBe('2');
    expect(dom.querySelector('sub.os-html-run')?.textContent).toBe('2');
    expect(dom.querySelector('u.os-html-run')?.textContent).toBe('under');
    expect(dom.querySelector('mark.os-html-run')?.textContent).toBe('hi');
    expect(dom.querySelector('kbd.os-html-run')?.textContent).toBe('Ctrl');
    expect(dom.querySelectorAll('[data-type="html"].os-html-tag').length).toBe(10);
  });

  it('a span keeps a colour and nothing else', () => {
    const dom = draw('a <span style="color:red; background:url(http://x)">red</span> b\n');
    const span = dom.querySelector('span.os-html-run');
    expect(span?.getAttribute('style')).toMatch(/^color: red;?$/);
  });

  it('a tag with no partner, and a comment, stay in sight', () => {
    const dom = draw('a stray </div> and <!-- note --> and <u>open\n');
    expect(dom.querySelectorAll('[data-type="html"].os-html-tag').length).toBe(0);
    expect(dom.querySelector('.os-html-run')).toBeNull();
  });

  it('a <br> in a table cell is a line break, not text', () => {
    const dom = draw('| a |\n|---|\n| one<br>two |\n');
    expect(dom.textContent).not.toContain('<br>');
    expect(dom.querySelector('td br')).not.toBeNull();
  });
});
