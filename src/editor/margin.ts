// The margin: a drag that starts in the empty space around the text selects the text beside it,
// line by line, the way the margin of a word processor does.
//
// A press in the space that holds no text (the side air of the column, the gap between two
// blocks, the room around the body) and a drag of more than a few pixels selects whole lines:
// from the line the press was beside to the line the pointer is beside now, in either
// direction. It is an ordinary text selection, the same one a drag inside the text gives, so
// everything that acts on a selection acts on it. This used to draw a rubber band and select
// whole blocks, Notion's gesture; a page is a document, and its margin behaves like one.
//
// A press inside text is ProseMirror's, as is a press inside a node view that handles its own
// mouse (a table cell, a code block's CodeMirror): only a press whose target is the editor's
// root or one of the elements around it starts here. Such a press is taken from the browser at
// once; a press that turns out to be a click (under `THRESHOLD` pixels) then does what the
// browser would have done: a caret at the point between blocks, the focus given up in the air.
// The page's own blank-click rule (page/dom.ts, the caret at the end) still runs as before.
//
// Nothing here edits the document: the only transactions are selection ones.

import { TextSelection } from '@milkdown/kit/prose/state';
import { BLOCK_KEY } from './blocks.ts';
import { scrollerOf } from './reveal.ts';

/** Pixels the pointer moves before a press in the air becomes a drag. */
const THRESHOLD = 4;
/** How near the scroller's top or bottom edge the pointer starts the page scrolling. */
const EDGE = 40;
/** The fastest auto-scroll, in pixels a frame, reached at the edge itself and beyond it. */
const SPEED = 24;

type MarginOpts = {
  /** The page column (`.page-col.ed`). */
  col: HTMLElement,
  /** The editor view, or null while there is none (Source, a page being torn down). */
  view: () => any,
  /** Whether this page is the one on screen and taking input. */
  active: () => boolean,
};

/** Wire the margin for one page. Answers the function that unwires it. */
export function attachMargin({ col, view: viewOf, active }: MarginOpts) {
  let drag: any = null;

  /** Whether a press on `target` is a press in the air around this page's blocks. */
  function inAir(view, target, e) {
    if (!(target instanceof HTMLElement)) return false;
    const root = view.dom as HTMLElement;
    // The root itself (between blocks) or an element that holds it (the body, the column, the
    // router's element, the scroller): never the title, the banner or anything in a block.
    if (target !== root && !target.contains(root)) return false;
    const scroller = scrollerOf(col);
    if (scroller ? !scroller.contains(target) : !col.contains(target)) return false;
    // The scrollbar of whatever was pressed is not air.
    if (e.offsetX >= target.clientWidth || e.offsetY >= target.clientHeight) return false;
    return true;
  }

  function onDown(e: MouseEvent) {
    if (drag || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!active()) return;
    const view = viewOf();
    if (!view || !(view.dom as HTMLElement).isConnected || !view.dom.getClientRects().length) return;
    if (!inAir(view, e.target, e)) return;
    // Taken from the browser now: the selection of this drag is made here.
    e.preventDefault();
    const scroller = scrollerOf(col);
    drag = {
      view, scroller, target: e.target,
      x0: e.clientX, y0: e.clientY,
      x: e.clientX, y: e.clientY,
      on: false, frame: 0,
      // The line the press was beside, as document positions: its first and its last. Read now,
      // while it is on screen; the page may scroll it away before the drag ends.
      lineStart: posBeside(view, e.clientY, 'start'), lineEnd: posBeside(view, e.clientY, 'end'),
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('blur', cancel);
  }

  function onMove(e: MouseEvent) {
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.on) {
      if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) < THRESHOLD) return;
      drag.on = true;
      drag.view.focus();
      drag.frame = requestAnimationFrame(tick);
    }
    e.preventDefault();
    update();
  }

  function onUp(e: MouseEvent) {
    if (!drag) return;
    const d = drag;
    if (d.on) {
      update();
      // The click that follows the release belongs to the drag, not to whatever is under it.
      const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    } else {
      click(d, e);
    }
    stop();
  }

  /** A press that never became a drag: what the browser would have done with it. */
  function click(d, e: MouseEvent) {
    const view = d.view;
    if (d.target === view.dom) {
      // Between two blocks: a caret at the nearest text position, as a click there gives.
      const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (hit) {
        const sel = TextSelection.near(view.state.doc.resolve(hit.pos));
        view.dispatch(view.state.tr.setSelection(sel));
      }
      view.focus();
      return;
    }
    // The page's own blank-click rule (page/dom.ts) has already put the caret at the end for a
    // press on the column, the element around it or the body.
    const t = d.target as HTMLElement;
    if (t === col || t === col.parentElement || (t.classList.contains('ed-body') && col.contains(t))) return;
    // The rest of the air: the focus goes where a press there sends it.
    const own = t.closest('[tabindex]');
    if (own instanceof HTMLElement && own.tabIndex >= 0) { own.focus({ preventScroll: true }); return; }
    const a = document.activeElement;
    if (a instanceof HTMLElement && col.contains(a)) a.blur();
  }

  function cancel() { stop(); }

  function stop() {
    if (!drag) return;
    cancelAnimationFrame(drag.frame);
    drag = null;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('blur', cancel);
  }

  /** The page scrolls by itself while the pointer is held near or past its top or bottom. */
  function tick() {
    if (!drag || !drag.on) return;
    const s = drag.scroller;
    const box = s ? s.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    let step = 0;
    if (drag.y < box.top + EDGE) step = -Math.min(SPEED, Math.ceil((box.top + EDGE - drag.y) / 2));
    else if (drag.y > box.bottom - EDGE) step = Math.min(SPEED, Math.ceil((drag.y - box.bottom + EDGE) / 2));
    if (step) {
      const before = scrollTopOf(s);
      if (s) s.scrollTop += step; else window.scrollBy(0, step);
      if (scrollTopOf(s) !== before) update();
    }
    drag.frame = requestAnimationFrame(tick);
  }

  /** Select from the line the press was beside to the line the pointer is beside now. */
  function update() {
    const d = drag;
    if (!d || !d.on) return;
    const view = viewOf();
    if (!view || view !== d.view) { stop(); return; }
    if (d.lineStart === null || d.lineEnd === null) return;
    const up = posBeside(view, d.y, 'start');
    if (up === null) return;
    // Above the press: from the end of its line back to the start of this one. Otherwise from
    // the start of its line to the end of this one.
    const back = up < d.lineStart;
    const anchor = back ? d.lineEnd : d.lineStart;
    const head = back ? up : posBeside(view, d.y, 'end');
    if (head === null) return;
    const doc = view.state.doc;
    const size = doc.content.size;
    if (anchor > size || head > size) return;
    const sel = TextSelection.between(doc.resolve(anchor), doc.resolve(head));
    if (sel.eq(view.state.selection) && !BLOCK_KEY.getState(view.state)) return;
    view.dispatch(view.state.tr.setSelection(sel).setMeta(BLOCK_KEY, null));
  }

  document.addEventListener('mousedown', onDown, true);
  return () => {
    stop();
    document.removeEventListener('mousedown', onDown, true);
  };
}

/**
 * The document position at one end of the line of text beside `y`: its start or its end. The
 * height is kept inside what is on screen, where the browser can answer for a point.
 */
function posBeside(view, y: number, end: 'start' | 'end'): number | null {
  const root = view.dom as HTMLElement;
  const box = root.getBoundingClientRect();
  const s = scrollerOf(root);
  const port = s ? s.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const top = Math.min(Math.max(y, Math.max(box.top, port.top) + 1), Math.min(box.bottom, port.bottom) - 1);
  const cs = getComputedStyle(root);
  const left = end === 'start'
    ? box.left + (parseFloat(cs.paddingLeft) || 0) + 1
    : box.right - (parseFloat(cs.paddingRight) || 0) - 1;
  const hit = view.posAtCoords({ left, top });
  return hit ? hit.pos : null;
}

function scrollTopOf(scroller) {
  return scroller ? scroller.scrollTop : window.scrollY;
}
