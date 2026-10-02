// The marquee: a rubber band drawn from the empty space around the blocks, Notion's way of
// selecting several blocks with the mouse.
//
// A press in the space that holds no text — the side air of the column, the gap between two
// blocks, the room around the body — and a drag of more than a few pixels draws a rectangle
// that follows the pointer. Every top-level block the rectangle meets, measured top to bottom
// only, is selected while the pointer moves, and the selection that is left on release is the
// block selection of blocks.ts (`selectRange`): Backspace deletes it, Ctrl+C copies it, the
// Shift+arrows extend it from the end the drag went towards, Esc and the arrows collapse it.
//
// A press inside text is ProseMirror's, as is a press inside a node view that handles its own
// mouse (a table cell, a code block's CodeMirror, Crepe's block handle): only a press whose
// target is the editor's root or one of the elements around it starts here. Such a press is
// taken from the browser at once, or its own drag would select text under the band; a press
// that turns out to be a click (under `THRESHOLD` pixels) then does what the browser would
// have done: a caret at the point between blocks, the focus given up in the air. The page's
// own blank-click rule (page/dom.ts, the caret at the end) still runs as before.
//
// Nothing here edits the document: the only transactions are selection ones.

import { TextSelection } from '@milkdown/kit/prose/state';
import { BLOCK_KEY, selectRange } from './blocks.ts';
import { scrollerOf } from './reveal.ts';

/** Pixels the pointer moves before a press in the air becomes a drag. */
const THRESHOLD = 4;
/** How near the scroller's top or bottom edge the pointer starts the page scrolling. */
const EDGE = 40;
/** The fastest auto-scroll, in pixels a frame, reached at the edge itself and beyond it. */
const SPEED = 24;

/**
 * The run of blocks a band from `y1` to `y2` meets, as indexes into `rects` (top to bottom, in
 * the same coordinates as the band), or null when it meets none. A block meets the band when
 * the two overlap by more than nothing; one with no height is never met.
 */
export function blocksInBand(rects: ReadonlyArray<{ top: number, bottom: number }>, y1: number, y2: number) {
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  let first = -1;
  let last = -1;
  rects.forEach((r, i) => {
    if (!(r.bottom > r.top)) return;
    if (r.bottom > top && r.top < bottom) {
      if (first < 0) first = i;
      last = i;
    }
  });
  return first < 0 ? null : { first, last };
}

type MarqueeOpts = {
  /** The page column (`.page-col.ed`). */
  col: HTMLElement,
  /** The editor view, or null while there is none (Source, a page being torn down). */
  view: () => any,
  /** Whether this page is the one on screen and taking input. */
  active: () => boolean,
};

/** Wire the marquee for one page. Answers the function that unwires it. */
export function attachMarquee({ col, view: viewOf, active }: MarqueeOpts) {
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
    // Taken from the browser now, or its own drag would select text under the band.
    e.preventDefault();
    const scroller = scrollerOf(col);
    drag = {
      view, scroller, target: e.target,
      x0: e.clientX, y0: e.clientY, top0: scrollTopOf(scroller),
      x: e.clientX, y: e.clientY,
      on: false, band: null as HTMLElement | null, frame: 0, last: '-',
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
      const band = document.createElement('div');
      band.className = 'os-marquee';
      document.body.append(band);
      drag.band = band;
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
    if (drag.band) drag.band.remove();
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

  /** Draw the band where the pointer is now, and select what it meets. */
  function update() {
    const d = drag;
    if (!d || !d.on) return;
    const view = viewOf();
    if (!view || view !== d.view) { stop(); return; }
    const s = d.scroller;
    // The press is held in the page's own coordinates, so it scrolls with the page.
    const y0 = d.y0 - (scrollTopOf(s) - d.top0);
    const box = s ? s.getBoundingClientRect() : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    const top = Math.max(Math.min(y0, d.y), box.top);
    const bottom = Math.min(Math.max(y0, d.y), box.bottom);
    const left = Math.max(Math.min(d.x0, d.x), box.left);
    const right = Math.min(Math.max(d.x0, d.x), box.right);
    if (d.band) {
      const st = d.band.style;
      st.left = `${left}px`;
      st.top = `${top}px`;
      st.width = `${Math.max(0, right - left)}px`;
      st.height = `${Math.max(0, bottom - top)}px`;
    }
    select(view, y0, d.y, d.y < y0 ? 'start' : 'end');
  }

  /** The block selection over the top-level blocks between `y1` and `y2`, or none. */
  function select(view, y1, y2, head) {
    const doc = view.state.doc;
    const spans: { from: number, to: number }[] = [];
    const rects: { top: number, bottom: number }[] = [];
    doc.forEach((node, pos) => {
      spans.push({ from: pos, to: pos + node.nodeSize });
      const dom = view.nodeDOM(pos);
      const r = dom instanceof Element ? dom.getBoundingClientRect() : null;
      rects.push(r ? { top: r.top, bottom: r.bottom } : { top: 0, bottom: 0 });
    });
    const hit = blocksInBand(rects, y1, y2);
    const key = hit ? `${hit.first}:${hit.last}:${head}` : '';
    if (key === drag.last) return;
    drag.last = key;
    if (!hit) {
      if (BLOCK_KEY.getState(view.state)) view.dispatch(view.state.tr.setMeta(BLOCK_KEY, null));
      return;
    }
    const from = spans[hit.first]?.from;
    const to = spans[hit.last]?.to;
    if (from === undefined || to === undefined) return;
    selectRange(view, { from, to, head });
  }

  document.addEventListener('mousedown', onDown, true);
  return () => {
    stop();
    document.removeEventListener('mousedown', onDown, true);
  };
}

function scrollTopOf(scroller) {
  return scroller ? scroller.scrollTop : window.scrollY;
}
