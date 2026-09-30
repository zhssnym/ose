// What Live draws (src/editor/live/inline.ts, blocks.js, reveal.js), read off
// `liveDecorations` with no view: which markup is hidden off the caret, which is shown on it,
// which classes and widgets a construct gets. Drawing never changes the document.
import { describe, it, expect } from 'vitest';
import { liveState, liveDecorations } from '../../../src/editor/live/state.ts';
import { revealedSpans, revealer } from '../../../src/editor/live/reveal.ts';
import { buildInline } from '../../../src/editor/live/inline.ts';
import { frontmatterKeys } from '../../../src/editor/live/blocks.ts';
import { collect } from '../../../src/editor/live/registry.ts';

/** Every decoration as [from, to, what]: a class, a widget's name, or `hide`. */
function list(set, doc) {
  const out = [];
  set.between(0, doc.length, (from, to, v) => {
    const w = v.spec.widget;
    out.push([from, to, w ? w.constructor.name : v.spec.class || 'hide']);
  });
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function draw(text, o = {}) {
  const state = liveState(text);
  const d = liveDecorations(state, o);
  const doc = state.doc;
  return { state, doc, inline: list(d.inline, doc), block: list(d.block, doc) };
}

/** The raw text of every hidden range. */
const hidden = (r) => r.inline.filter((d) => d[2] === 'hide').map((d) => r.doc.sliceString(d[0], d[1]));
const widgets = (r) => r.inline.filter((d) => /Widget$/.test(d[2]));

describe('the reveal rule', () => {
  it('reveals nothing when unfocused', () => {
    const s = liveState('a\nb', { selection: { from: 0 } });
    expect(revealedSpans(s, { focused: false })).toEqual([]);
  });

  it('widens each range to its lines and tests overlap', () => {
    const s = liveState('aa\nbb\ncc\ndd');
    const r = revealer(revealedSpans(s, { focused: true, selection: { from: 4, to: 4 } }));
    expect(r(3, 5)).toBe(true);        // line 2
    expect(r(0, 2)).toBe(false);       // line 1
    expect(r(0, 3)).toBe(true);        // lines 1-2 touch line 2
    expect(r(6, 8)).toBe(false);       // line 3
  });

  it('a multi-line selection reveals every line it touches', () => {
    const s = liveState('aa\nbb\ncc\ndd');
    const r = revealer(revealedSpans(s, { focused: true, selection: { from: 1, to: 7 } }));
    expect([r(0, 0), r(3, 3), r(6, 6), r(9, 9)]).toEqual([true, true, true, false]);
  });

  it('reads the state\'s own focus and selection by default', () => {
    const s = liveState('aa\nbb', { focused: true, selection: { from: 4 } });
    const r = revealer(revealedSpans(s));
    expect([r(0, 1), r(3, 4)]).toEqual([false, true]);
  });
});

describe('headings', () => {
  it('hides `# ` off the caret and styles the line; the first H1 is the title', () => {
    const r = draw('# Title\n\n## Sub\n');
    expect(hidden(r)).toEqual(['# ', '## ']);
    const classes = r.inline.map((d) => d[2]);
    expect(classes).toContain('cm-live-h1 cm-live-title');
    expect(classes).toContain('cm-live-h2');
  });

  it('shows the markup, dimmed, on the caret line', () => {
    const r = draw('# Title\n\n## Sub\n', { focused: true, selection: { from: 12 } });
    expect(hidden(r)).toEqual(['# ']);
    expect(r.inline.some((d) => d[2] === 'cm-live-mark' && r.doc.sliceString(d[0], d[1]) === '## ')).toBe(true);
  });

  it('an empty heading keeps its `#`', () => {
    expect(hidden(draw('#\n'))).toEqual([]);
  });

  it('a closing sequence is hidden too', () => {
    expect(hidden(draw('## Sub ##\n'))).toEqual(['## ', ' ##']);
  });

  it('only the first H1 is the title', () => {
    const r = draw('# One\n\n# Two\n');
    expect(r.inline.filter((d) => d[2] === 'cm-live-h1 cm-live-title').length).toBe(1);
    expect(r.inline.filter((d) => d[2] === 'cm-live-h1').length).toBe(1);
  });
});

describe('emphasis and code', () => {
  it('hides every marker and styles the content', () => {
    const r = draw('_i_ *j* **b** __c__ ~~s~~ `x`\n');
    expect(hidden(r)).toEqual(['_', '_', '*', '*', '**', '**', '__', '__', '~~', '~~', '`', '`']);
    const classes = r.inline.map((d) => d[2]);
    for (const c of ['cm-live-em', 'cm-live-strong', 'cm-live-strike', 'cm-live-code']) expect(classes).toContain(c);
  });

  it('an escape hides its backslash off the caret', () => {
    expect(hidden(draw('\\*not\\*\n'))).toEqual(['\\', '\\']);
  });
});

describe('links', () => {
  it('shows only the text of an inline link, with the href', () => {
    const t = 'see [the text](https://x.test "T") here\n';
    expect(hidden(draw(t))).toEqual(['[', '](https://x.test "T")']);
    const state = liveState(t);
    let found = null;
    liveDecorations(state).inline.between(0, state.doc.length, (f, to, v) => {
      if (v.spec.attributes) found = [state.doc.sliceString(f, to), v.spec.attributes['data-href'], v.spec.class];
    });
    expect(found).toEqual(['the text', 'https://x.test', 'cm-live-link cm-live-follow']);
  });

  it('on the caret line a link does not follow on a plain click', () => {
    const state = liveState('[a](b)\n');
    let cls = null;
    liveDecorations(state, { focused: true, selection: { from: 1 } }).inline.between(0, 5, (_f, _to, v) => { if (v.spec.attributes) cls = v.spec.class; });
    expect(cls).toBe('cm-live-link');
  });

  it('styles autolinks and bare URLs', () => {
    const r = draw('<https://a.test> and https://b.test\n');
    expect(hidden(r)).toEqual(['<', '>']);
    expect(r.inline.filter((d) => /cm-live-link/.test(d[2])).length).toBe(2);
  });

  it('a reference link is left as written', () => {
    expect(hidden(draw('[a][ref]\n\n[ref]: https://x.test\n'))).toEqual([]);
  });
});

describe('wikilinks', () => {
  it('shows the alias, else the target', () => {
    expect(hidden(draw('[[Page|alias]] and [[Other#Part]]\n'))).toEqual(['[[Page|', ']]', '[[', ']]']);
  });

  it('marks a missing target through resolveWikilink', () => {
    const state = liveState('[[Here]] [[Gone]]\n');
    const set = buildInline(state, [{ from: 0, to: state.doc.length }], {
      collected: collect([]), revealed: () => false, path: 'a.md', resolveAsset: () => null,
      resolveWikilink: (t) => ({ path: t === 'Here' ? 'Here.md' : null, exists: t === 'Here' }),
      openLink: () => {}, inlineHtml: (s) => s, toggleTask: () => false, openFrontmatter: () => {},
    });
    const marks = [];
    set.between(0, state.doc.length, (_f, _to, v) => { if (v.spec.attributes) marks.push([v.spec.attributes['data-wiki'], v.spec.class]); });
    expect(marks).toEqual([
      ['Here', 'cm-live-link cm-live-wiki cm-live-follow'],
      ['Gone', 'cm-live-link cm-live-wiki cm-live-missing cm-live-follow'],
    ]);
  });

  it('is not a wikilink across a line or when empty', () => {
    expect(hidden(draw('[[a\nb]] [[]]\n'))).toEqual([]);
  });

  it('an embed is an Image node, left raw when no widget draws it', () => {
    expect(hidden(draw('![[pic.png|300]]\n'))).toEqual([]);
  });
});

describe('lists and tasks', () => {
  it('bullets become widgets, numbers stay, tasks become checkboxes', () => {
    const r = draw('- a\n  - b\n1. c\n\n- [ ] d\n- [x] e\n');
    expect(widgets(r).map((d) => [r.doc.sliceString(d[0], d[1]), d[2]])).toEqual([
      ['-', 'BulletWidget'], ['-', 'BulletWidget'], ['- [ ]', 'CheckboxWidget'], ['- [x]', 'CheckboxWidget'],
    ]);
    expect(r.inline.some((d) => d[2] === 'cm-live-listmark')).toBe(true);
    expect(r.inline.some((d) => d[2] === 'cm-live-task cm-live-done')).toBe(true);
  });

  it('an ordered task keeps its number and gets a checkbox', () => {
    const r = draw('1. [ ] a\n');
    expect(widgets(r).map((d) => r.doc.sliceString(d[0], d[1]))).toEqual(['[ ]']);
  });

  it('the caret line shows the list markup raw', () => {
    expect(widgets(draw('- [ ] a\n', { focused: true, selection: { from: 7 } }))).toEqual([]);
  });
});

describe('quotes and callouts', () => {
  it('hides `> ` and gives the lines a bar; `>>` is a frame', () => {
    const r = draw('> one\n> two\n\n>> framed\n');
    expect(hidden(r)).toEqual(['> ', '> ', '>', '> ']);
    const lines = r.inline.filter((d) => /cm-live-(quote|frame)/.test(d[2])).map((d) => d[2]);
    expect(lines).toEqual(['cm-live-quote', 'cm-live-quote', 'cm-live-frame cm-live-frame-first cm-live-frame-last']);
  });

  it('a callout gets a header widget and its type; unknown types are notes', () => {
    const r = draw('> [!tip]- Title\n> body\n\n> [!odd] X\n> y\n');
    expect(r.inline.filter((d) => d[2] === 'CalloutHeadWidget').length).toBe(2);
    const cls = r.inline.map((d) => d[2]).filter((c) => /^cm-live-callout /.test(c));
    expect(cls[0]).toBe('cm-live-callout cm-live-callout-tip cm-live-callout-first');
    expect(cls.some((c) => /callout-note/.test(c))).toBe(true);
  });

  it('a callout is revealed whole when one of its lines is', () => {
    const t = '> [!note] T\n> body\n';
    const r = draw(t, { focused: true, selection: { from: t.indexOf('body') } });
    expect(r.inline.filter((d) => d[2] === 'CalloutHeadWidget')).toEqual([]);
    expect(hidden(r)).toEqual([]);
  });
});

describe('rules, HTML, code', () => {
  it('a rule becomes a widget', () => {
    expect(draw('a\n\n---\n\nb\n').inline.filter((d) => d[2] === 'RuleWidget').length).toBe(1);
  });

  it('HTML and comments are dimmed and never replaced', () => {
    const r = draw('<b>x</b> <!-- c -->\n\n<div>\nblock\n</div>\n');
    expect(r.inline.filter((d) => d[2] === 'cm-live-html').length).toBeGreaterThanOrEqual(3);
    expect(hidden(r)).toEqual([]);
  });

  it('a fenced block with no widget is monospace, and nothing inside it is drawn', () => {
    const r = draw('```\n# not a heading\n- [ ] not a task\n```\n');
    expect(r.inline.filter((d) => d[2] === 'cm-live-fence').length).toBe(4);
    expect(hidden(r)).toEqual([]);
    expect(widgets(r)).toEqual([]);
  });
});

describe('frontmatter', () => {
  const t = '---\ntitle: T\ntags: [a]\ndate: x\nmore: y\n---\n# Body\n';

  it('folds into one block widget off the caret, and is not a rule or a heading', () => {
    const r = draw(t);
    expect(r.block).toEqual([[0, t.indexOf('\n# Body'), 'PropertiesWidget']]);
    expect(r.inline.some((d) => d[2] === 'cm-live-h2' || d[2] === 'RuleWidget')).toBe(false);
  });

  it('shows raw when the caret is inside', () => {
    const r = draw(t, { focused: true, selection: { from: 6 } });
    expect(r.block).toEqual([]);
    expect(r.inline.filter((d) => d[2] === 'cm-live-fm').length).toBe(6);
  });

  it('accepts `...` as the closing line, and nothing that is not at the very start', () => {
    expect(draw('---\na: 1\n...\nx\n').block.length).toBe(1);
    expect(draw('\n---\na: 1\n---\n').block.length).toBe(0);
    expect(draw('---\na: 1\n').block.length).toBe(0);
  });

  it('lists the top-level keys', () => {
    expect(frontmatterKeys('---\ntitle: T\n  nested: n\ntags:\n  - a\n"quoted": no\n---')).toEqual(['title', 'tags']);
  });
});

describe('widgets through the registry', () => {
  it('a widget that throws leaves its node raw and the rest drawn', () => {
    const bad = { id: 'bad', kind: 'inline', nodes: ['Emphasis'], decorate() { throw new Error('boom'); } };
    const state = liveState('_a_ **b**\n');
    const d = liveDecorations(state, { widgets: [bad] });
    const r = { doc: state.doc, inline: list(d.inline, state.doc) };
    expect(hidden(r)).toEqual(['**', '**']);
  });

  it('what CodeMirror would refuse is refused here: the node stays raw', async () => {
    const { Decoration } = await import('@codemirror/view');
    const crossing = { id: 'crossing', kind: 'inline', nodes: ['Paragraph'], decorate(_ctx, node, out) { out.add(node.from, node.to, Decoration.replace({})); } };
    const halfBlock = { id: 'half', kind: 'block', nodes: ['Table'], decorate(_ctx, node, out) { out.add(node.from + 1, node.to, Decoration.replace({ block: true })); } };
    const state = liveState('one\ntwo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    const d = liveDecorations(state, { widgets: [crossing, halfBlock] });
    expect(list(d.inline, state.doc).filter((x) => x[2] === 'hide')).toEqual([]);
    expect(list(d.block, state.doc)).toEqual([]);
  });

  it('decorate is called only off the caret, for the nodes named', () => {
    const seen = [];
    const spy = { id: 'spy', kind: 'block', nodes: ['Table'], decorate(ctx, node) { seen.push([node.name, ctx.revealed(node.from, node.to)]); } };
    const t = 'x\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    const state = liveState(t);
    liveDecorations(state, { widgets: [spy] });
    liveDecorations(state, { widgets: [spy], focused: true, selection: { from: t.indexOf('| 1') } });
    expect(seen).toEqual([['Table', false]]);
  });
});

describe('purity', () => {
  it('never changes the document, whatever the selection', () => {
    const t = '---\na: 1\n---\n# H\n\n- [ ] t\n> [!note] c\n> d\n\n| a | b |\n|---|---|\n| 1 | 2 |\n[[w]] **b** [l](u)\n';
    const state = liveState(t);
    const before = state.doc;
    for (let i = 0; i <= state.doc.length; i += 3) {
      liveDecorations(state, { focused: true, selection: { from: i, to: Math.min(state.doc.length, i + 7) } });
    }
    expect(state.doc).toBe(before);
    expect(state.doc.toString()).toBe(liveState(t).doc.toString());
  });
});
