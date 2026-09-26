// Compare: two texts side by side, the lines that differ marked (C4, H10, H7).
//
// What a recovered draft is shown with before the user decides whether to keep it, what the
// Versions dialog uses to show a version against the page, and the resolve view of a change
// made on disk that overlaps the buffer (wave 2, H7). Read-only on both sides: the question
// this answers is "what is different", and the answer is taken with the page's own commands,
// or with the buttons a caller hands in (`actions`), never by editing in here.
//
// The view is `@codemirror/merge`'s MergeView, in the app's overlay. Its own stylesheet colours
// the changes with literals; source.css paints them again from the tokens.

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MergeView } from '@codemirror/merge';
import { openOverlay } from './deps.js';

/** One side: the text, read-only, wrapped, in the source view's face. */
const side = (doc) => ({
  doc: String(doc ?? ''),
  extensions: [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    EditorView.theme({
      '&': { color: 'var(--fg)', backgroundColor: 'transparent', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-ui)' },
      '.cm-content': { caretColor: 'var(--fg)' },
      '&.cm-focused': { outline: 'none' },
    }),
  ],
});

/**
 * Open the comparison and resolve when it is closed. `a` is the left side and `b` the right;
 * each label says what that side is ("on disk", "recovered 14:02").
 *
 * With `actions`, the foot carries one button per action and a Cancel: the promise resolves to
 * the `value` of the button pressed, or null on Cancel, Esc or a click outside. The action
 * marked `kind: 'primary'` takes the focus, so Enter is the default. Without `actions` there is
 * one Close button and the promise resolves to undefined, as it always has.
 *
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.a
 * @param {string} o.b
 * @param {string} [o.aLabel]
 * @param {string} [o.bLabel]
 * @param {string} [o.note]   one line under the two texts
 * @param {Array<{label: string, value: string, kind?: 'primary'|'danger'}>} [o.actions]
 * @returns {Promise<void|string|null>}
 */
export function compareTexts({ title = 'Compare', a = '', b = '', aLabel = '', bLabel = '', note = '', actions = null } = {}) {
  const asking = Array.isArray(actions) && actions.length > 0;
  return new Promise((resolve) => {
    let merge = null;
    let answer = asking ? null : undefined;
    const ov = openOverlay({
      width: 'min(1100px, 94vw)', className: 'dlg-ov', title,
      onClose: () => { try { if (merge) merge.destroy(); } catch { /* already gone */ } resolve(answer); },
    });
    const box = ov.box;
    box.classList.add('dlg', 'ed-compare');

    const head = document.createElement('div');
    head.className = 'dlg-head label';
    head.textContent = title;

    const body = document.createElement('div');
    body.className = 'dlg-body ed-compare-body';
    const labels = document.createElement('div');
    labels.className = 'ed-compare-labels';
    for (const text of [aLabel, bLabel]) {
      const l = document.createElement('span');
      l.className = 'hint';
      l.textContent = text;
      labels.append(l);
    }
    const pane = document.createElement('div');
    pane.className = 'ed-compare-pane';
    body.append(labels, pane);

    const foot = document.createElement('div');
    foot.className = 'dlg-foot';
    const noteEl = document.createElement('span');
    noteEl.className = 'grow hint';
    noteEl.textContent = note || (a === b ? 'the two texts are the same' : '');
    const close = document.createElement('button');
    close.className = 'btn';
    close.type = 'button';
    close.textContent = asking ? 'Cancel' : 'Close';
    close.addEventListener('click', () => ov.close());
    foot.append(noteEl, close);
    let first = close;
    if (asking) {
      for (const act of actions) {
        const btn = document.createElement('button');
        btn.className = 'btn' + (act.kind ? ' ' + act.kind : '');
        btn.type = 'button';
        btn.textContent = act.label;
        btn.addEventListener('click', () => { answer = act.value; ov.close(); });
        foot.append(btn);
        if (act.kind === 'primary') first = btn;
      }
    }

    box.append(head, body, foot);
    merge = new MergeView({
      a: side(a),
      b: side(b),
      parent: pane,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    // Straight away, not on a frame: a hidden window fires none (see versions.js).
    first.focus();
  });
}
