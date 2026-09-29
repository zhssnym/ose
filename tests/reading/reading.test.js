// @vitest-environment happy-dom
// The Reading view (contract §4.4, §8.1): sanitised, `breaks: true`, `data-line` on every
// top-level block, the frontmatter as properties, images through resolveAsset, links handed to
// the page, and nothing that edits.

import '../live/widgets/dom-shim.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createReadingView, frontmatter, normalise, properties } from '../../src/editor/reading/index.ts';

/** @type {Array<{ destroy(): void }>} */
const open = [];
afterEach(() => { while (open.length) open.pop()?.destroy(); });

function view(text, over = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const links = [];
  const v = createReadingView({
    host,
    text,
    path: 'notes/page.md',
    resolveAsset: (src) => (src.includes('gone') ? null : `vault://${src}`),
    onOpenLink: (href, o) => links.push([href, o.newTab]),
    ...over,
  });
  open.push(v);
  return { v, el: v.el, links, host };
}

const lines = (el) => [...el.children].map((c) => [c.tagName.toLowerCase(), c.getAttribute('data-line')]);

describe('sanitising', () => {
  it('script, event handlers and frames are stripped', () => {
    const { el } = view('<script>alert(1)</script>\n\n<img src="x.png" onerror="alert(2)">\n\n<iframe srcdoc="x"></iframe>\n\ntext <b onclick="x()">bold</b>\n');
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('iframe')).toBeNull();
    expect(el.innerHTML).not.toMatch(/onerror|onclick|alert/);
    expect(el.querySelector('b')?.textContent).toBe('bold');
  });

  it('a javascript: link is not kept', () => {
    const { el } = view('[x](javascript:alert(1))\n');
    expect(el.innerHTML).not.toContain('javascript:');
  });
});

describe('markdown', () => {
  it('breaks: true, a single newline is a line break', () => {
    const { el } = view('one\ntwo\n');
    expect(el.querySelector('p')?.innerHTML).toBe('one<br>two');
  });

  it('every top-level block carries its first file line, 1-based', () => {
    const text = '# Title\n\nA paragraph\nover two lines\n\n- a\n- b\n\n```js\nx\n```\n\n> quote\n';
    const { el } = view(text);
    expect(lines(el)).toEqual([['h1', '1'], ['p', '3'], ['ul', '6'], ['pre', '9'], ['blockquote', '13']]);
  });

  it('lines count the same across CRLF, CR and a byte-order mark', () => {
    const { el } = view('﻿# A\r\n\r\nb\r\rc\n');
    expect(lines(el)).toEqual([['h1', '1'], ['p', '3'], ['p', '5']]);
  });

  it('a run of blank lines is kept as space, with its line', () => {
    const { el } = view('a\n\n\n\nb\n');
    expect(lines(el)).toEqual([['p', '1'], ['p', '3'], ['p', '4'], ['p', '5']]);
    expect(el.querySelectorAll('p.md-space').length).toBe(2);
  });

  it('frontmatter is a properties block on line 1, and the body lines follow it', () => {
    const { el } = view('---\ntitle: A note\ntags:\n  - one\n  - two\n---\n# Heading\n');
    const props = el.querySelector('.ose-reading-props');
    expect(props?.getAttribute('data-line')).toBe('1');
    expect([...el.querySelectorAll('.ose-reading-props dt')].map((d) => d.textContent)).toEqual(['title', 'tags']);
    expect([...el.querySelectorAll('.ose-reading-props dd')].map((d) => d.textContent)).toEqual(['A note', '- one - two']);
    expect(el.querySelector('h1')?.getAttribute('data-line')).toBe('7');
  });

  it('maths is drawn with the pandoc rule', () => {
    const { el } = view('$x^2$ and 5 $ puis 10 $\n');
    expect(el.querySelectorAll('math').length).toBe(1);
    expect(el.textContent).toContain('5 $ puis 10 $');
  });

  it('a display formula keeps its line', () => {
    const { el } = view('a\n\n$$\nx^2\n$$\n\nb\n');
    expect(lines(el)).toEqual([['p', '1'], ['div', '3'], ['p', '7']]);
    // Painted, not the placeholder any more (happy-dom cannot lay out Temml's display wrap, so
    // what it paints may be the error box; the browser draws the formula).
    const painted = el.querySelector('div.ose-math-display');
    expect(painted?.hasAttribute('data-math')).toBe(false);
    expect(painted?.getAttribute('data-line')).toBe('3');
  });

  it('task boxes are disabled', () => {
    const { el } = view('- [ ] a\n- [x] b\n');
    const boxes = [...el.querySelectorAll('input')];
    expect(boxes.length).toBe(2);
    for (const b of boxes) expect(b.hasAttribute('disabled')).toBe(true);
  });

  it('images go through resolveAsset, with the width of `alt|420`; a missing one says so', () => {
    const { el } = view('![Wiring|420](img/a.png)\n\n![](gone.png)\n\n![[pic.png|200]]\n');
    const imgs = [...el.querySelectorAll('img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['vault://img/a.png', 'vault://pic.png']);
    expect(imgs[0]?.getAttribute('alt')).toBe('Wiring');
    expect(imgs[0]?.getAttribute('width')).toBe('420');
    expect(imgs[1]?.getAttribute('width')).toBe('200');
    expect(el.querySelector('.ose-reading-missing code')?.textContent).toBe('gone.png');
    // Alone in its paragraph an image is a figure; beside text it is not.
    expect(imgs[0]?.classList.contains('ose-reading-figure')).toBe(true);
    const inline = view('text ![](a.png) more\n').el.querySelector('img');
    expect(inline?.classList.contains('ose-reading-figure')).toBe(false);
  });
});

describe('links', () => {
  it('a click hands the href to the page; the web view never navigates', () => {
    const { el, links } = view('[a](other.md) and [b](https://example.com)\n');
    const [a, b] = [...el.querySelectorAll('a')];
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    a?.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    b?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(links).toEqual([['other.md', false], ['https://example.com', true]]);
  });

  it('wikilinks: alias, heading, missing, through resolveWikilink', () => {
    const { el, links } = view('[[Other|shown]] [[Gone]] [[Other#Part]]\n', {
      resolveWikilink: (t) => (t === 'Other' ? { path: 'notes/sub/Other.md', exists: true } : { path: null, exists: false }),
    });
    const as = [...el.querySelectorAll('a.ose-wikilink')];
    expect(as.map((a) => a.textContent)).toEqual(['shown', 'Gone', 'Other › Part']);
    expect(as[1]?.classList.contains('is-missing')).toBe(true);
    expect(as[0]?.classList.contains('is-missing')).toBe(false);
    for (const a of as) a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(links.map((l) => l[0])).toEqual(['sub/Other.md', 'Gone.md', 'sub/Other.md#Part']);
  });
});

describe('Live and Reading agree', () => {
  it('the first H1 is the title, drawn as Rich and Live draw it', () => {
    const { el } = view('Intro\n\n# Title\n\n# Second\n');
    const h1s = [...el.querySelectorAll('h1')];
    expect(h1s.map((h) => h.classList.contains('ose-reading-title'))).toEqual([true, false]);
  });

  it('wikilinks follow Live\'s grammar (live/syntax.js)', () => {
    const { el } = view('[[#Part]] [[a [b c]] [[a [b] c]] [[x|]] [[ ]] [[]] [[a\nb]]\n');
    const as = [...el.querySelectorAll('a.ose-wikilink')];
    // `[[#Part]]` is a link to a heading of this page; a lone `[` is allowed inside and a lone
    // `]` is not; an empty alias shows the target; `[[]]` and a link over a line break are not
    // links, and a blank one shows what is written.
    expect(as.map((a) => a.textContent)).toEqual(['Part', 'a [b c', 'x', '[[ ]]']);
    expect(as[0]?.getAttribute('href')).toBe('#Part');
    expect(el.textContent).toContain('[[]]');
  });

  it('an embed is an image by readEmbed\'s rule; a note embed is a link', () => {
    const { el } = view('![[pic.png|200]] ![[pic.png|a caption]] ![[Other note]]\n');
    const imgs = [...el.querySelectorAll('img')];
    expect(imgs.map((i) => [i.getAttribute('width'), i.getAttribute('alt')])).toEqual([['200', ''], [null, 'a caption']]);
    expect(el.querySelector('a.ose-embed')?.textContent).toBe('Other note');
  });

  it('frontmatter is found by Live\'s rule', () => {
    expect(frontmatter('---\na: 1\nb: 2\n---\nx')).toEqual({ body: 'a: 1\nb: 2', lines: 4 });
    expect(frontmatter('---\n---\nx')).toEqual({ body: '', lines: 2 });
    expect(frontmatter('--- \na: 1\n...  \n')).toEqual({ body: 'a: 1', lines: 3 });
  });
});

describe('the view', () => {
  it('is read-only and focusable, and holds nothing editable', () => {
    const { el } = view('# A\n\ntext\n');
    expect(el.getAttribute('contenteditable')).toBeNull();
    expect(el.querySelector('[contenteditable]')).toBeNull();
    expect(el.tabIndex).toBe(0);
    expect(el.classList.contains('md-render')).toBe(true);
  });

  it('setText re-renders; destroy removes the element', () => {
    const { v, el, host } = view('one\n');
    v.setText('# two\n');
    expect(el.querySelector('h1')?.textContent).toBe('two');
    v.destroy();
    expect(host.contains(el)).toBe(false);
  });

  it('goToLine picks the block holding the line; topLine answers a block line', () => {
    const { v } = view('# A\n\nb\n\nc\n');
    expect(v.goToLine(4)).toBe(true);
    expect([1, 3, 5]).toContain(v.topLine());
  });
});

describe('helpers', () => {
  it('normalise', () => {
    expect(normalise('﻿a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('frontmatter needs a closing line', () => {
    expect(frontmatter('---\na: 1\n...\nx')).toEqual({ body: 'a: 1', lines: 3 });
    expect(frontmatter('---\na: 1\n')).toBeNull();
    expect(frontmatter('text\n---\n')).toBeNull();
  });

  it('properties are top-level keys', () => {
    expect(properties('a: 1\nb:\n  - x\n# comment\nc: three words')).toEqual([['a', '1'], ['b', '- x # comment'], ['c', 'three words']]);
  });
});
