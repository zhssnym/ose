// Page view: where each A4 sheet ends, drawn over the page while it is being written.
//
// The screen cannot paginate a document it is editing, so nothing is moved: the page is laid
// out as one sheet of the print width, size and leading (sheets.css), and this file walks its
// blocks the way the printer will and draws a dashed rule at each place a sheet ends. The walk
// follows print.css's rules for breaks: a bar, a frame, a figure and a display formula are
// never cut unless they are taller than a sheet; a heading and a run-in label go with what
// follows them; a paragraph, a list, a listing and a table break between two lines, with at
// least two lines on each side. Chromium's own pagination has more rules than these, so a rule
// can land a line away from where the PDF breaks on an unusual page; on an ordinary one it
// is where the sheet ends.

const AVOID = 'blockquote, .milkdown-image-block, .ose-math-display, math[display="block"]';
// The printable height of an A4 sheet with 2cm margins, in CSS px: 25.7cm at 96 per inch.
const SHEET_H = (25.7 / 2.54) * 96;

const keepsWithNext = (el) =>
  /^H[1-6]$/.test(el.tagName)
  || el.classList.contains('page-title')
  || (el.tagName === 'P' && el.firstChild && el.firstChild === el.firstElementChild && el.firstElementChild.tagName === 'STRONG');

const unbreakable = (el) => el.matches(AVOID) || !!el.querySelector(':scope > .ose-math-display, :scope > math[display="block"]');

/** The bottoms of the lines inside a block, in client px, sorted, one per line. */
function lineBottoms(el) {
  let rects;
  const rows = el.querySelectorAll('.cm-line, tr');
  if (rows.length) rects = [...rows].map((r) => r.getBoundingClientRect());
  else {
    const range = document.createRange();
    range.selectNodeContents(el);
    rects = [...range.getClientRects()];
  }
  const out = [];
  for (const r of rects) {
    if (r.height <= 0) continue;
    // Two rects of one line (a bold run, a formula) share a bottom within a pixel or two.
    const b = r.bottom;
    const i = out.findIndex((x) => Math.abs(x - b) < 3);
    if (i < 0) out.push(b); else out[i] = Math.max(out[i], b);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Watch a page column and keep its sheet rules current. `getContent` answers the ProseMirror
 * element, which the editor mounts after the column exists. Returns the teardown.
 */
export function attachSheets(col, getContent) {
  const root = document.documentElement;
  const layer = document.createElement('div');
  layer.className = 'sheet-breaks';
  layer.setAttribute('aria-hidden', 'true');
  let frame = 0;
  let timer = 0;

  const on = () => root.dataset.layout === 'pages';

  function units() {
    const list = [];
    for (const el of col.children) {
      if (el === layer || el.classList.contains('page-meta') || el.classList.contains('ed-bl')) continue;
      if (el.classList.contains('ed-body')) break;
      list.push(el);
    }
    const pm = getContent();
    if (pm) for (const el of pm.children) if (el.getBoundingClientRect().height > 0) list.push(el);
    return list;
  }

  function measure() {
    frame = 0;
    if (!on() || !col.isConnected) { layer.replaceChildren(); return; }
    if (layer.parentNode !== col) col.append(layer);

    const box = col.getBoundingClientRect();
    if (!col.offsetWidth) return;
    // The sheet may be zoomed as one object: client px over layout px is the factor.
    const z = box.width / col.offsetWidth;
    const pad = parseFloat(getComputedStyle(col).paddingTop) * z;
    const top0 = box.top + pad;
    const H = SHEET_H * z;

    const us = units();
    const breaks = [];
    let start = 0;
    for (let i = 0; i < us.length; i++) {
      const el = us[i];
      const r = el.getBoundingClientRect();
      const t = r.top - top0;
      const b = r.bottom - top0;
      let guard = 0;
      while (b > start + H + 0.5 && guard++ < 200) {
        const end = start + H;
        let at = null;
        if (!(unbreakable(el) && b - t <= H)) {
          const lines = lineBottoms(el).map((y) => y - top0).filter((y) => y > start + 0.5);
          const fit = lines.filter((y) => y <= end + 0.5);
          // Two lines on each side of the cut: the orphans and widows print.css sets.
          const opened = t < start - 0.5;
          let k = fit.length;
          while (k > 0 && lines.length - k < 2) k--;
          if (k >= (opened ? 1 : 2)) at = fit[k - 1];
        }
        if (at === null) {
          if (t > start + 0.5) {
            at = t;
            // The block goes to the next sheet, and a heading or a label above it goes too.
            const prev = us[i - 1];
            if (prev && keepsWithNext(prev)) {
              const pt = prev.getBoundingClientRect().top - top0;
              if (pt > start + 0.5) at = pt;
            }
          } else {
            at = end;          // taller than a sheet and nothing to cut between: the edge cuts it
          }
        }
        if (at <= start + 0.5) at = end;
        breaks.push(at);
        start = at;
      }
    }

    layer.replaceChildren(...breaks.map((y, n) => {
      const d = document.createElement('div');
      d.className = 'sheet-break';
      d.style.top = `${(y + pad) / z}px`;
      d.dataset.n = String(n + 2);
      return d;
    }));
  }

  // Typing reflows a paragraph within a frame; a pause is enough for the rules to follow.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!frame) frame = requestAnimationFrame(measure); }, 120);
  };

  const ro = new ResizeObserver(schedule);
  ro.observe(col);
  let watched = null;
  const watchContent = () => {
    const pm = getContent();
    if (pm && pm !== watched) { if (watched) ro.unobserve(watched); ro.observe(pm); watched = pm; }
  };
  // The rules themselves are inside the column: redrawing them must not ask for another redraw.
  const mo = new MutationObserver((records) => {
    if (records.every((r) => r.target === layer || layer.contains(r.target))) return;
    watchContent();
    schedule();
  });
  mo.observe(col, { childList: true, subtree: true, characterData: true });
  // The layout setting and the reading settings live on <html>.
  const rootMo = new MutationObserver(schedule);
  rootMo.observe(root, { attributes: true, attributeFilter: ['data-layout', 'data-face', 'style', 'class'] });
  const onLoad = (e) => { if (e.target && e.target.tagName === 'IMG') schedule(); };
  col.addEventListener('load', onLoad, true);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule, () => {});
  watchContent();
  schedule();

  return () => {
    clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame);
    ro.disconnect();
    mo.disconnect();
    rootMo.disconnect();
    col.removeEventListener('load', onLoad, true);
    layer.remove();
  };
}
