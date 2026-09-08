// What every view shares and none of them owns: the period navigation (the ‹ today › group,
// the keys that drive it, and the hint that says the keys exist), and the loading line an
// asynchronous region prints while its reads are still out (lib/loading.js). Nothing here
// touches the bridge or the shell; it is DOM and timers only, and every function hands back
// the way to undo itself.

import { esc } from '../registry.js';

/* ------------------------------------------------------------------- nav */

/**
 * The navigation group of a periodic view, laid out by `.v-nav`: the key hint in mono `--fg-3`
 * then the three buttons. The buttons carry `data-nav` so `bindNav` can drive them without
 * ids; `unit` names the period for the screen reader ("Previous day").
 */
export function navHtml(unit) {
  return `<div class="v-nav">
    <span class="v-keys mono-sm" aria-hidden="true">&larr; &rarr; &middot; t</span>
    <button class="btn sm" data-nav="prev" aria-label="Previous ${esc(unit)}">&lsaquo;</button>
    <button class="btn sm" data-nav="today">today</button>
    <button class="btn sm" data-nav="next" aria-label="Next ${esc(unit)}">&rsaquo;</button>
  </div>`;
}

/** A key pressed while writing belongs to the field, never to the view. */
function inField(t) {
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}

/**
 * Wire one view's period navigation: clicks on `[data-nav]` inside `root`, and the keys
 * ArrowLeft / ArrowRight / t while focus is anywhere in `root` that is not a text field. Keys
 * with a modifier are left alone so the shell's map (Alt+Left is back) is never shadowed.
 * -> a function that removes both listeners; call it from unmount.
 */
export function bindNav(root, { prev, next, today }) {
  const onClick = (ev) => {
    const b = ev.target.closest('[data-nav]');
    if (!b || !root.contains(b)) return;
    if (b.dataset.nav === 'prev') prev();
    else if (b.dataset.nav === 'next') next();
    else if (b.dataset.nav === 'today') today();
  };
  const onKey = (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
    if (inField(ev.target)) return;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); prev(); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); next(); }
    else if (ev.key === 't' || ev.key === 'T') { ev.preventDefault(); today(); }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKey);
  };
}

/* --------------------------------------------------------------- loading */

// The loading line moved to lib/loading.js so the router prints the same one while a page
// mounts (D9). Re-exported here because this is where the views import it from.
export { loadingLine } from '../lib/loading.js';
