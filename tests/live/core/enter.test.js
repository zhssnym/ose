// @vitest-environment happy-dom
// Enter in Live leaves a list or a quote the way CLAUDE.md says Enter twice does: one blank line
// between the block and the new line, so what is typed next is a paragraph of its own and not
// a lazy continuation that Reading and Rich would draw inside the last item.
import { describe, it, expect, afterEach } from 'vitest';
import { createLiveView } from '../../../src/editor/live/view.ts';
import { liveEnter } from '../../../src/editor/live/commands.ts';
import { Transaction } from '@codemirror/state';
import { undo } from '@codemirror/commands';

const views = [];
afterEach(() => { while (views.length) views.pop().destroy(); document.body.innerHTML = ''; });

function mount(text) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const lv = createLiveView({
    host, text, path: 'notes/a.md', widgets: [], paste: null,
    resolveAsset: () => null, onOpenLink: () => {}, onChange: () => {},
  });
  views.push(lv);
  lv.setSelection({ from: lv.viewText().length });
  return { lv };
}

/** Type `s` at the caret, as the keyboard does. */
function type(lv, s) {
  const at = lv.view.state.selection.main.head;
  lv.view.dispatch({ changes: { from: at, insert: s }, selection: { anchor: at + s.length }, userEvent: 'input.type' });
}

/** Press Enter as the keymap does: Live's command, else a plain line break. */
function enter(lv) {
  if (liveEnter(lv.view)) return;
  type(lv, '\n');
}

describe('Enter, Enter, text', () => {
  const cases = [
    ['- a\n- b', '- a\n- b\n\ntext'],
    ['1. one', '1. one\n\ntext'],
    ['- [ ] x', '- [ ] x\n\ntext'],
    ['> q', '> q\n\ntext'],
    ['> [!warning] Careful\n> body of warning', '> [!warning] Careful\n> body of warning\n\ntext'],
    ['* star', '* star\n\ntext'],
  ];
  for (const [start, want] of cases) {
    it(JSON.stringify(start), () => {
      const { lv } = mount(start);
      enter(lv);
      enter(lv);
      type(lv, 'text');
      expect(lv.viewText()).toBe(want);
    });
  }
});

describe('the first Enter continues the block', () => {
  it('a tight list stays tight', () => {
    const { lv } = mount('1. one');
    enter(lv);
    expect(lv.viewText()).toBe('1. one\n2. ');
    const t = mount('- a\n- b').lv;
    enter(t);
    expect(t.viewText()).toBe('- a\n- b\n- ');
  });

  it('a task goes on as a task', () => {
    const { lv } = mount('- [x] done');
    enter(lv);
    expect(lv.viewText()).toBe('- [x] done\n- [ ] ');
  });

  it('a quote goes on as a quote', () => {
    const { lv } = mount('> q');
    enter(lv);
    expect(lv.viewText()).toBe('> q\n> ');
  });
});

describe('nesting', () => {
  it('an empty nested item goes up one level, not out of the list', () => {
    const { lv } = mount('- a\n  - b');
    enter(lv);
    enter(lv);
    expect(lv.viewText()).toBe('- a\n  - b\n- ');
  });

  it('a list inside a quote is left for the quote, with a blank quote line', () => {
    const { lv } = mount('> - a');
    enter(lv);
    enter(lv);
    type(lv, 'x');
    expect(lv.viewText()).toBe('> - a\n>\n> x');
  });

  it('an empty inner quote line leaves the inner quote only', () => {
    const { lv } = mount('> > b');
    enter(lv);
    enter(lv);
    type(lv, 'x');
    expect(lv.viewText()).toBe('> > b\n>\n> x');
  });

  it('an empty `>` line in the middle of a quote stays a paragraph break', () => {
    const { lv } = mount('> a\n> \n> c');
    lv.setSelection({ from: 6 });
    enter(lv);
    expect(lv.viewText().startsWith('> a\n>')).toBe(true);
    expect(lv.viewText().endsWith('> c')).toBe(true);
  });

  it('an already blank line before the item is not doubled', () => {
    const { lv } = mount('- a\n\n- ');
    enter(lv);
    type(lv, 't');
    expect(lv.viewText()).toBe('- a\n\nt');
  });
});

describe('the edit', () => {
  it('is one transaction tagged input.live.newline, one undo', () => {
    const { lv } = mount('- a\n- ');
    const view = lv.view;
    const seen = [];
    const orig = view.dispatch.bind(view);
    view.dispatch = (...a) => {
      const tr = a[0] && a[0].startState ? a[0] : view.state.update(...a);
      seen.push(tr.annotation(Transaction.userEvent));
      return orig(tr);
    };
    expect(liveEnter(view)).toBe(true);
    view.dispatch = orig;
    expect(seen).toEqual(['input.live.newline']);
    expect(view.state.doc.toString()).toBe('- a\n\n');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n- ');
  });

  it('plain Enter outside lists and quotes is not Live\'s', () => {
    const { lv } = mount('para');
    expect(liveEnter(lv.view)).toBe(false);
  });
});
