// The order plugins are shown in, in the sidebar and on the dashboard.
//
// A view carries its place: `order`, then its title (docs/PLUGINS.md). There is no list of
// plugins anywhere and the loader activates them concurrently, so there is nothing else to
// sort by: a plugin that wants to sit between two others changes the `order` of its view. The
// stock six use 10 to 60.

const rank = (v) => (Number.isFinite(v && v.order) ? v.order : 100);
const title = (v) => String((v && (v.title || v.name)) || '');

/** Sort comparator over `{ name, title, order }` view rows. */
export function byViewOrder(a, b) {
  return (rank(a) - rank(b)) || title(a).localeCompare(title(b));
}

/**
 * A plugin's place: its first view's, so a plugin sits where the thing it opens sits. One with
 * no view at all has nothing to sort by and goes last, which is where the dashboard draws it:
 * a line under the grid rather than a card that opens nothing.
 */
export function byPluginOrder(a, b) {
  const first = (p) => ((p && p.views) || []).slice().sort(byViewOrder)[0];
  const va = first(a), vb = first(b);
  if (va && vb) return byViewOrder(va, vb);
  if (va || vb) return va ? -1 : 1;
  return String(a.name || a.id).localeCompare(String(b.name || b.id));
}
