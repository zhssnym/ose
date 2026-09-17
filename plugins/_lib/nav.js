// The period navigation of a chronological view: the `‹ today ›` group, and the keys that
// drive it. DOM and listeners only; nothing here touches the vault.
//
// Day and Month had the same forty lines each, byte for byte. A plugin may not import another
// plugin, so the copy that stays is this one.

import { esc } from 'ose:ui';

/**
 * The navigation group, laid out by `.v-nav`: the key hint in mono `--fg-3`, then the three
 * buttons. They carry `data-nav` so `bindNav` can drive them without ids; `unit` names the
 * period for the screen reader ("Previous day").
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
