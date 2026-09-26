// Compare: two texts side by side, the lines that differ marked (C4, H10).
//
// What a recovered draft is shown with before the user decides whether to keep it, and what
// the Versions dialog uses to show a version against the page. Read-only on both sides: the
// question this answers is "what is different", and the answer is taken with the page's own
// commands (Restore, Discard, Keep mine), never by editing in here.
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
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.a
 * @param {string} o.b
 * @param {string} [o.aLabel]
 * @param {string} [o.bLabel]
 * @param {string} [o.note]   one line under the two texts
 * @returns {Promise<void>}
 */
export function compareTexts({ title = 'Compare', a = '', b = '', aLabel = '', bLabel = '', note = '' } = {}) {
  return new Promise((resolve) => {
    let merge = null;
    const ov = openOverlay({
      width: 'min(1100px, 94vw)', className: 'dlg-ov', title,
      onClose: () => { try { if (merge) merge.destroy(); } catch { /* already gone */ } resolve(); },
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
    close.textContent = 'Close';
    close.addEventListener('click', () => ov.close());
    foot.append(noteEl, close);

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
    close.focus();
  });
}
