// The order modules are shown in, in the sidebar and on the dashboard.
//
// It is the order of `cockpit.json`'s `modules` list, which is the rice's own file: to move a
// module, move its line. A module added to the end of that list lands at the bottom. The
// loader activates modules concurrently, so `ose.modules.list()` has no order worth keeping;
// a view no listed module owns comes after them all, by its declared `order`, then its title.

import { ose } from 'ose:kernel';

let listed = [];
try {
  const res = await fetch(new URL('../cockpit.json', import.meta.url), { cache: 'no-store' });
  const cockpit = await res.json();
  if (Array.isArray(cockpit.modules)) listed = cockpit.modules.map(String);
} catch { /* no cockpit.json: every module falls back to its declared order */ }

/** A view's place: the index of the module that owns it in cockpit.json, or after them all. */
function rank(viewName) {
  const owner = ose.modules.list().find((m) => m.view && m.view.name === viewName);
  const i = owner ? listed.indexOf(owner.id) : -1;
  return i < 0 ? listed.length : i;
}

/** Sort comparator over `{ name, title, order }` view rows. */
export function byModuleOrder(a, b) {
  return (rank(a.name) - rank(b.name))
    || ((a.order ?? 100) - (b.order ?? 100))
    || String(a.title || a.name).localeCompare(String(b.title || b.name));
}
