// Bringing a document position onto the screen: the find bar, the outline picker and "open at
// a line" all end here. ProseMirror's own scrollIntoView puts the selection just inside the
// edge of the scroll box, which is right while typing and wrong for a jump — the target lands
// under the sticky find bar or on the last visible line. A jump puts it a third of the way
// down (or near the top, for a heading) and leaves the box alone when it is already in view.

import { TextSelection } from '@milkdown/kit/prose/state';

/** The nearest ancestor that scrolls vertically, or null. */
export function scrollerOf(el) {
  let n = el;
  while (n && n !== document.body) {
    const s = getComputedStyle(n).overflowY;
    if (s === 'auto' || s === 'scroll') return n;
    n = n.parentElement;
  }
  return null;
}

/**
 * Viewport rectangle of `pos`: the caret box when ProseMirror can give one, else the box of
 * the top-level block holding it — a CodeMirror block has no ProseMirror DOM inside, so a
 * position in one has no coordinates of its own.
 */
function rectAt(view, pos) {
  try {
    const c = view.coordsAtPos(pos);
    if (c && (c.bottom > c.top || c.left || c.top)) return c;
  } catch { /* fall through to the block */ }
  try {
    const $pos = view.state.doc.resolve(pos);
    const dom = view.nodeDOM($pos.depth ? $pos.before(1) : pos);
    if (dom && typeof dom.getBoundingClientRect === 'function') return dom.getBoundingClientRect();
  } catch { /* nothing to show */ }
  return null;
}

/**
 * Scroll so `pos` is on screen. `block: 'center'` (default) puts it a third of the way down
 * the visible column, `'start'` near the top. Nothing moves when it is already comfortably
 * visible, unless `always`. The sticky find bar, when open, counts as not-visible space.
 */
export function revealPos(view, pos, { block = 'center', always = false } = {}) {
  const scroller = scrollerOf(view.dom);
  const r = rectAt(view, pos);
  if (!scroller || !r) return;
  const box = scroller.getBoundingClientRect();
  const bar = view.dom.closest('.ed')?.querySelector('.ed-find');
  const top = box.top + (bar ? bar.getBoundingClientRect().height : 0);
  const room = box.bottom - top;
  const margin = Math.min(48, room / 8);
  const visible = r.top >= top + margin && r.bottom <= box.bottom - margin;
  if (visible && !always) return;
  const target = block === 'start' ? top + margin : top + room / 3;
  scroller.scrollTop += r.top - target;
}

/**
 * A caret at `pos` (clamped, and moved to the nearest text position), revealed, and the
 * editor focused when asked. The selection is always empty: a range would bring up Crepe's
 * formatting toolbar, which no jump wants.
 */
export function caretAt(view, pos, opts = {}) {
  const doc = view.state.doc;
  const p = Math.max(0, Math.min(Number(pos) || 0, doc.content.size));
  const sel = TextSelection.near(doc.resolve(p), 1);
  view.dispatch(view.state.tr.setSelection(sel));
  revealPos(view, sel.from, opts);
  if (opts.focus) view.focus();
}
