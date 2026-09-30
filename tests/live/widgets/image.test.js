// @vitest-environment happy-dom
// Live's image widgets: what an image node says, where it is drawn (inline or as a block), the
// URL through `resolveAsset`, and the missing box (contract §3.2, §8.1).

import './dom-shim.js';
import { describe, expect, it } from 'vitest';
import { image, imageBlock, ImageWidget, readImage } from '../../../src/editor/live/widgets/image.ts';
import { ctxOf, decorations, nodesOf, stateOf } from './support.js';

describe('readImage', () => {
  it.each([
    ['![Wiring diagram|420](img/a.png)', { src: 'img/a.png', alt: 'Wiring diagram', width: '420' }],
    ['![Wiring](img/a.png "A title")', { src: 'img/a.png', alt: 'Wiring', width: '' }],
    ['![](<my file.png>)', { src: 'my file.png', alt: '', width: '' }],
    ['![[pic.png]]', { src: 'pic.png', alt: '', width: '' }],
    ['![[attachments/pic.jpg|200]]', { src: 'attachments/pic.jpg', alt: '', width: '200' }],
    ['![[pic.webp|A photo]]', { src: 'pic.webp', alt: 'A photo', width: '' }],
  ])('%s', (text, want) => {
    const state = stateOf(`x ${text} y`);
    const [node] = nodesOf(state, 'Image');
    expect(node).toBeDefined();
    expect(node && readImage(state, node)).toEqual(want);
  });

  it('a note embed and a reference image are not drawn', () => {
    for (const text of ['![[a note]]', '![alt][ref]\n\n[ref]: x.png']) {
      const state = stateOf(text);
      for (const node of nodesOf(state, 'Image')) expect(readImage(state, node)).toBeNull();
    }
  });
});

describe('where an image is drawn', () => {
  it('with text around it: inline, over the markup only', () => {
    const doc = 'See ![a](x.png) here';
    const state = stateOf(doc);
    const ctx = ctxOf(state);
    const inline = decorations(image, ctx);
    expect(inline.length).toBe(1);
    expect(doc.slice(inline[0].from, inline[0].to)).toBe('![a](x.png)');
    expect(inline[0].deco.spec.block).toBeFalsy();
    expect(decorations(imageBlock, ctx)).toEqual([]);
  });

  it('alone on its line: a block over the whole line', () => {
    const doc = 'Text\n\n  ![a](x.png)\n\nMore';
    const state = stateOf(doc);
    const ctx = ctxOf(state);
    expect(decorations(image, ctx)).toEqual([]);
    const block = decorations(imageBlock, ctx);
    expect(block.length).toBe(1);
    expect(block[0].from).toBe(state.doc.line(3).from);
    expect(block[0].to).toBe(state.doc.line(3).to);
    expect(block[0].deco.spec.block).toBe(true);
  });

  it('in a list item or a quote: inline', () => {
    for (const doc of ['- ![a](x.png)', '> ![a](x.png)']) {
      const ctx = ctxOf(stateOf(doc));
      expect(decorations(image, ctx).length).toBe(1);
      expect(decorations(imageBlock, ctx)).toEqual([]);
    }
  });

  it('the URL comes from resolveAsset with the src as written', () => {
    const asked = [];
    const ctx = ctxOf(stateOf('a ![](sub/x%20y.png) b'), { resolveAsset: (s) => { asked.push(s); return `u:${s}`; } });
    const [d] = decorations(image, ctx);
    expect(asked).toEqual(['sub/x%20y.png']);
    expect(d.deco.spec.widget.url).toBe('u:sub/x%20y.png');
  });
});

describe('the widget', () => {
  const view = /** @type {any} */ ({ requestMeasure() {} });

  it('draws the image with its alt text and width', () => {
    const dom = new ImageWidget('x.png', 'vault://x.png', 'Wiring', '420', false).toDOM(view);
    const img = dom.querySelector('img');
    expect(dom.className).toBe('cm-live-image');
    expect(img?.getAttribute('src')).toBe('vault://x.png');
    expect(img?.getAttribute('alt')).toBe('Wiring');
    expect(img?.getAttribute('width')).toBe('420');
  });

  it('null draws the missing box with the src', () => {
    const dom = new ImageWidget('gone.png', null, '', '', true).toDOM(view);
    expect(dom.className).toBe('cm-live-image cm-live-image-block');
    expect(dom.querySelector('img')).toBeNull();
    expect(dom.querySelector('.cm-live-image-missing')?.textContent).toBe('Missing imagegone.png');
  });

  it('a load error turns into the missing box', () => {
    const dom = new ImageWidget('bad.png', 'vault://bad.png', '', '', false).toDOM(view);
    dom.querySelector('img')?.dispatchEvent(new Event('error'));
    expect(dom.querySelector('img')).toBeNull();
    expect(dom.querySelector('.cm-live-image-missing code')?.textContent).toBe('bad.png');
  });

  it('a resolver that throws is a missing image, not a broken page', () => {
    const ctx = ctxOf(stateOf('a ![](x.png) b'), { resolveAsset: () => { throw new Error('no'); } });
    const [d] = decorations(image, ctx);
    expect(d.deco.spec.widget.url).toBeNull();
  });

  it('eq ignores where the image is', () => {
    const a = decorations(image, ctxOf(stateOf('a ![](x.png) b')))[0].deco.spec.widget;
    const b = decorations(image, ctxOf(stateOf('longer text ![](x.png) b')))[0].deco.spec.widget;
    expect(a.eq(b)).toBe(true);
  });
});
