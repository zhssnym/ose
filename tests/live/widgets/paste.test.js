// @vitest-environment happy-dom
// Live's paste (M11): turndown in the vault's conventions for a fixed HTML set, inline images
// stored as attachments, files linked in one transaction, plain paste left to CodeMirror.

import './dom-shim.js';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, toast } from 'ose:ui';
import {
  fileFromDataUrl, htmlToMarkdown, linkFor, markdownFromHtml, paste, pendingPastes, storeFiles,
} from '../../../src/editor/live/widgets/paste.js';

// The page's clipboard and toast, watched: an orphaned attachment link uses both.
vi.mock('ose:ui', async (original) => ({
  ...(await original()),
  copyText: vi.fn(async () => true),
  toast: vi.fn(() => () => {}),
}));

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('turndown, in the vault conventions', () => {
  it.each([
    ['headings are atx', '<h1>Title</h1><h3>Sub</h3>', '# Title\n\nSub'.replace('Sub', '### Sub')],
    ['bullets are `- ` with one space', '<ul><li>one</li><li>two</li></ul>', '- one\n- two'],
    ['nested bullets indent by the marker', '<ul><li>one<ul><li>inner</li></ul></li></ul>', '- one\n  - inner'],
    ['ordered lists', '<ol start="3"><li>a</li><li>b</li></ol>', '3. a\n4. b'],
    ['emphasis is `_`, strong is `**`', '<p><em>soft</em> and <strong>loud</strong></p>', '_soft_ and **loud**'],
    ['strikethrough', '<p><del>gone</del></p>', '~~gone~~'],
    ['a `<br>` is a plain newline', '<p>one<br>two</p>', 'one\ntwo'],
    ['fenced code with its language', '<pre><code class="language-js">let a = 1;\n</code></pre>', '```js\nlet a = 1;\n```'],
    ['links', '<p><a href="https://example.com/a">a site</a></p>', '[a site](https://example.com/a)'],
    ['task lists', '<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>', '- [x] done\n- [ ] todo'],
  ])('%s', (_name, html, want) => {
    expect(htmlToMarkdown(html)).toBe(want);
  });

  it('tables', () => {
    const md = htmlToMarkdown('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
    const lines = md.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]?.replace(/\s+/g, ' ')).toBe('| A | B |');
    expect(lines[1]).toMatch(/^\|\s*-+\s*\|\s*-+\s*\|$/);
    expect(lines[2]?.replace(/\s+/g, ' ')).toBe('| 1 | 2 |');
  });

  it('script, style, handlers and frames never reach the markdown', () => {
    const md = htmlToMarkdown('<p onclick="x()">safe</p><script>alert(1)</script><style>p{}</style><iframe srcdoc="framed"></iframe>');
    expect(md).toBe('safe');
  });

  it('a web image keeps its address; an inline one is dropped by the pure function', () => {
    expect(htmlToMarkdown('<img src="https://e.x/a.png" alt="A">')).toBe('![A](https://e.x/a.png)');
    expect(htmlToMarkdown(`<p>x <img src="${PNG}" alt="shot"></p>`)).toBe('x shot');
  });
});

describe('attachments', () => {
  /** A fake page: stores under `att/`, refuses a name with "refuse" in it. */
  const page = () => {
    const saved = [];
    return {
      saved,
      ctx: {
        path: 'notes/page.md',
        saveAttachment: async (file) => {
          if (file.name.includes('refuse')) return null;
          saved.push(file);
          return `notes/att/${file.name}`;
        },
        linkTo: (p) => p.replace(/^notes\//, ''),
      },
    };
  };

  it('fileFromDataUrl: images only', () => {
    const f = fileFromDataUrl(PNG, 2);
    expect(f?.name).toBe('pasted-image-2.png');
    expect(f?.type).toBe('image/png');
    expect(f?.size).toBe(8);
    expect(fileFromDataUrl('data:text/plain,hello')).toBeNull();
    expect(fileFromDataUrl('https://e.x/a.png')).toBeNull();
  });

  it('linkFor: an image is `![](href)`, anything else `[name](href)`', () => {
    expect(linkFor(new File(['x'], 'a.png', { type: 'image/png' }), 'att/a.png')).toBe('![](att/a.png)');
    expect(linkFor(new File(['x'], 'report [v2].pdf', { type: 'application/pdf' }), 'att/r.pdf')).toBe('[report \\[v2\\].pdf](att/r.pdf)');
    expect(linkFor(new File(['x'], 'a.pdf'), 'att/my file.pdf')).toBe('[a.pdf](<att/my file.pdf>)');
  });

  it('storeFiles stores each file and links it; a refused one inserts nothing', async () => {
    const { ctx, saved } = page();
    const files = [
      new File(['1'], 'shot.png', { type: 'image/png' }),
      new File(['2'], 'refuse.txt', { type: 'text/plain' }),
      new File(['3'], 'notes.pdf', { type: 'application/pdf' }),
    ];
    expect(await storeFiles(files, ctx)).toBe('![](att/shot.png)\n[notes.pdf](att/notes.pdf)');
    expect(saved.map((f) => f.name)).toEqual(['shot.png', 'notes.pdf']);
  });

  it('markdownFromHtml stores an inline image and links it where it stood', async () => {
    const { ctx, saved } = page();
    const md = await markdownFromHtml(`<p>Look: <img src="${PNG}" alt="shot"> there</p>`, ctx);
    expect(md).toBe('Look: ![shot](att/pasted-image-1.png) there');
    expect(saved.length).toBe(1);
  });
});

describe('the extension in a view', () => {
  /** @type {EditorView | null} */
  let view = null;
  afterEach(() => { view?.destroy(); view = null; });

  const make = (doc, ctx) => {
    const parent = document.createElement('div');
    document.body.append(parent);
    view = new EditorView({ state: EditorState.create({ doc, extensions: [paste(ctx)] }), parent });
    view.focus = () => {};
    return view;
  };

  /** A paste event carrying `types` (a map of type to data) and `files`. */
  const pasteEvent = (types, files = []) => {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', {
      value: { getData: (t) => types[t] || '', files, items: [], types: Object.keys(types) },
    });
    return e;
  };

  const ctx = {
    path: 'p.md',
    saveAttachment: async (file) => `att/${file.name}`,
    linkTo: (p) => p,
  };

  it('HTML is pasted as markdown, in one user transaction', () => {
    const v = make('ab', ctx);
    v.dispatch({ selection: { anchor: 1 } });
    const events = [];
    const orig = v.dispatch.bind(v);
    v.dispatch = (...a) => { events.push(a[0].userEvent); return orig(...a); };
    const e = pasteEvent({ 'text/html': '<p><strong>x</strong></p>', 'text/plain': 'x' });
    v.contentDOM.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(v.state.doc.toString()).toBe('a**x**b');
    expect(events).toEqual(['input.paste']);
  });

  it('plain text is left to CodeMirror', () => {
    const v = make('ab', ctx);
    const e = pasteEvent({ 'text/plain': 'x' });
    v.contentDOM.dispatchEvent(e);
    expect(v.state.doc.toString()).not.toBe('a**x**b');
    // Our handler did not take it; CodeMirror's own handler may have.
    expect(v.state.doc.toString()).not.toContain('*');
  });

  it('Ctrl+Shift+V makes the next paste plain', () => {
    const v = make('ab', ctx);
    v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true }));
    v.contentDOM.dispatchEvent(pasteEvent({ 'text/html': '<p><strong>x</strong></p>', 'text/plain': 'x' }));
    expect(v.state.doc.toString()).not.toContain('**');
  });

  it('files are stored and linked at the caret, after a wait mapped through typing', async () => {
    let release = () => {};
    const gate = new Promise((r) => { release = r; });
    const slow = { ...ctx, saveAttachment: async (file) => { await gate; return `att/${file.name}`; } };
    const v = make('hello world', slow);
    v.dispatch({ selection: { anchor: 6 } });
    v.contentDOM.dispatchEvent(pasteEvent({}, [new File(['x'], 'a.png', { type: 'image/png' })]));
    // The user types in front of the paste point while the attachment is being written.
    v.dispatch({ changes: { from: 0, insert: '>> ' }, userEvent: 'input.type' });
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe('>> hello ![](att/a.png)world');
  });

  it('an HTML clipboard that is only an image takes the file', async () => {
    const v = make('', ctx);
    v.contentDOM.dispatchEvent(pasteEvent({ 'text/html': '<img src="https://e.x/a.png">' }, [new File(['x'], 'image.png', { type: 'image/png' })]));
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe('![](att/image.png)');
  });

  it('an attachment that arrives while the view is read-only waits, and lands once it is editable', async () => {
    let release = () => {};
    const gate = new Promise((r) => { release = r; });
    const slow = { ...ctx, saveAttachment: async (file) => { await gate; return `att/${file.name}`; } };
    const lock = new Compartment();
    const parent = document.createElement('div');
    document.body.append(parent);
    view = new EditorView({ state: EditorState.create({ doc: 'ab', selection: { anchor: 1 }, extensions: [paste(slow), lock.of([])] }), parent });
    const v = view;
    v.contentDOM.dispatchEvent(pasteEvent({}, [new File(['x'], 'a.png', { type: 'image/png' })]));
    // A freeze (a mode switch, a save) makes the view read-only while the file is written.
    v.dispatch({ effects: lock.reconfigure(EditorState.readOnly.of(true)) });
    let settled = false;
    const wait = pendingPastes(v).then(() => { settled = true; });
    release();
    await wait;
    expect(settled).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe('ab');
    v.dispatch({ effects: lock.reconfigure([]) });
    await new Promise((r) => setTimeout(r, 0));
    expect(v.state.doc.toString()).toBe('a![](att/a.png)b');
  });

  it('a view that goes away first: the link goes on the clipboard and the page says so', async () => {
    vi.mocked(copyText).mockClear();
    vi.mocked(toast).mockClear();
    let release = () => {};
    const gate = new Promise((r) => { release = r; });
    const slow = { ...ctx, saveAttachment: async (file) => { await gate; return `att/${file.name}`; } };
    const v = make('ab', slow);
    v.contentDOM.dispatchEvent(pasteEvent({}, [new File(['x'], 'a.png', { type: 'image/png' })]));
    v.destroy();
    view = null;
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(copyText)).toHaveBeenCalledWith('![](att/a.png)');
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1);
  });

  it('read-only: nothing is pasted by us', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    view = new EditorView({ state: EditorState.create({ doc: 'ab', extensions: [paste(ctx), EditorState.readOnly.of(true)] }), parent });
    view.contentDOM.dispatchEvent(pasteEvent({ 'text/html': '<p><b>x</b></p>' }));
    expect(view.state.doc.toString()).toBe('ab');
  });
});
