// @vitest-environment happy-dom
//
// The two serialiser-side findings that need a DOM: H4, find and replace keeping the marks of
// what it replaces (src/editor/find.js, a real ProseMirror view under happy-dom), and M6's other
// half, the app's own renderer reading a single newline the way the editor writes a hard break
// (src/editor/render.js, `breaks: true`).
//
// Depends on: serializer (find.js H4, render.js M6).

import { EditorState } from '@milkdown/kit/prose/state';
import { EditorView } from '@milkdown/kit/prose/view';
import { describe, expect, it } from 'vitest';
import { pipeline } from '../support/pipeline.js';

/** A live view over `md`, with the find plugin, and the find bar mounted beside it. */
async function withFind(md) {
  const P = await pipeline();
  const { findPlugin } = await import('../../src/editor/plugins.js');
  const { createFind } = await import('../../src/editor/find.js');
  const doc = P.engine.parse(md);
  const root = document.createElement('div');
  const mount = document.createElement('div');
  root.appendChild(mount);
  document.body.appendChild(root);
  const view = new EditorView(mount, { state: EditorState.create({ doc, plugins: [findPlugin()] }) });
  const find = createFind(root, () => view);
  return { P, view, find, root };
}

/** Run a replacement through the bar the way a user does: query, replacement, the button. */
function replace({ find, root }, query, text, label) {
  find.open({ query, replace: true });
  const field = root.querySelector('input[aria-label="Replace with"]');
  field.value = text;
  const button = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  button.click();
}

/** Every text run of the document with the names of its marks. */
function runs(doc) {
  const out = [];
  doc.descendants((n) => { if (n.isText) out.push([n.text, n.marks.map((m) => m.type.name).sort().join('+')]); return true; });
  return out;
}

describe('H4: find and replace keeps the marks of what it replaces', () => {
  it('Replace all inside bold text', async () => {
    const h = await withFind('A **bold word** and a [link text](https://x.org) here.\n');
    replace(h, 'word', 'phrase', 'Replace all');
    expect(runs(h.view.state.doc)).toContainEqual(['bold phrase', 'strong']);
    h.view.destroy();
  });

  it('Replace inside a link', async () => {
    const h = await withFind('A **bold word** and a [link text](https://x.org) here.\n');
    replace(h, 'link', 'anchor', 'Replace');
    expect(runs(h.view.state.doc)).toContainEqual(['anchor text', 'link']);
    h.view.destroy();
  });

  it('Replace all inside italic text, twice in one paragraph', async () => {
    const h = await withFind('_one cat_ and _two cat_\n');
    replace(h, 'cat', 'dog', 'Replace all');
    const italic = runs(h.view.state.doc).filter(([, m]) => m === 'emphasis').map(([t]) => t);
    expect(italic).toEqual(['one dog', 'two dog']);
    h.view.destroy();
  });
});

describe('M6: the renderer reads a single newline as a line break', () => {
  it('render() of two lines gives a <br>', async () => {
    const { render } = await import('../../src/editor/render.js');
    const out = await render('line one\nline two');
    const html = typeof out === 'string' ? out : out && (out.html ?? out.outerHTML ?? out.innerHTML ?? String(out));
    expect(html).toMatch(/line one<br\s*\/?>\s*line two/);
  });
});
