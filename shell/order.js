// The order the registered views are shown in: the planner row on Home, and anywhere else a
// list of views is drawn.
//
// A view carries its place: `order`, then its title (`ose.views.register(name, { order })`).
// There is no list of views anywhere else, so there is nothing else to sort by: the planner's
// Day, Week, Month and Journal use 10 to 40.

const rank = (v) => (Number.isFinite(v && v.order) ? v.order : 100);
const title = (v) => String((v && (v.title || v.name)) || '');

/**
 * Sort comparator over `{ name, title, order }` view rows: `order`, then the title.
 * @param {{name?: string, title?: string, order?: number}} a
 * @param {{name?: string, title?: string, order?: number}} b
 * @returns {number}
 */
export function byViewOrder(a, b) {
  return (rank(a) - rank(b)) || title(a).localeCompare(title(b));
}
