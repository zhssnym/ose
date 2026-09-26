// Task checkboxes and list bullets: the two widgets that stand in for list markup.
//
// The checkbox is the one widget in Live that changes the document, and it changes exactly one
// character: a click is `toggleTaskAt` (state.js), one transaction, user event
// `input.live.task`, `[ ]` to `[x]` or back. Everything else a widget does only draws or sets
// the selection.

import { WidgetType } from '@codemirror/view';
import { taskMarkerOnLine, toggleTaskAt } from './state.js';

/**
 * Toggle the task on the line where `dom` (a checkbox widget) sits. Answers true when a
 * change was dispatched. Nothing happens on a read-only page (a frozen or lossy one).
 * @param {import('@codemirror/view').EditorView} view
 * @param {HTMLElement} dom
 */
export function toggleFromWidget(view, dom) {
  if (view.state.readOnly) return false;
  let pos;
  try { pos = view.posAtDOM(dom); } catch { return false; }
  const marker = taskMarkerOnLine(view.state, pos);
  if (!marker) return false;
  const spec = toggleTaskAt(view.state, marker.from);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

/** `- [ ]` and `- [x]` off the caret's line: a square, checked or not. */
export class CheckboxWidget extends WidgetType {
  /** @param {boolean} done */
  constructor(done) { super(); this.done = done; }

  /** @param {CheckboxWidget} other */
  eq(other) { return other.done === this.done; }

  /** @param {import('@codemirror/view').EditorView} view */
  toDOM(view) {
    const box = document.createElement('span');
    box.className = `cm-live-checkbox${this.done ? ' cm-live-checked' : ''}`;
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', this.done ? 'true' : 'false');
    box.setAttribute('aria-label', this.done ? 'Done task' : 'Open task');
    // mousedown, not click: by the click the caret would already be on this line, which
    // reveals the raw `[ ]` and takes the widget away under the pointer.
    box.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      toggleFromWidget(view, box);
    });
    return box;
  }

  /** The widget answers its own mouse events; CodeMirror leaves them alone. */
  ignoreEvent() { return true; }
}

/** A `-`, `*` or `+` bullet off the caret's line. `level` is 1 for a top-level list. */
export class BulletWidget extends WidgetType {
  /** @param {number} level */
  constructor(level) { super(); this.level = level; }

  /** @param {BulletWidget} other */
  eq(other) { return other.level === this.level; }

  toDOM() {
    const dot = document.createElement('span');
    dot.className = 'cm-live-bullet';
    dot.dataset.level = String(((this.level - 1) % 3) + 1);
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }

  ignoreEvent() { return false; }
}
