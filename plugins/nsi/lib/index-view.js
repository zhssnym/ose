/* The Code index: one table, one row per drill, in number order. The number, the
   title, the drill's dominant category, its date and where you stand with it — nothing else,
   and nothing that has to be explained.

   The table itself is `../_lib/table.js`, the one the Maths index draws with: same borders,
   same keyboard, same header. Nothing on this page creates or deletes a drill: drills are
   written into the folder by an agent reading the log, and the folder is the sidebar's. */

import { h, clear, plural, errorBlock } from '../../_lib/drills.js'
import { drillTable } from '../../_lib/table.js'

import { ctx, dataRoot } from './ctx.js'
import { listDrills, statusCell } from './data.js'

const COLUMNS = [
  { key: 'n', title: '#', align: 'right', mono: true },
  { key: 'title', title: 'Title', grow: true },
  { key: 'category', title: 'Category' },
  { key: 'date', title: 'Date', mono: true },
  { key: 'status', title: 'Status' },
]

const live = new Set()

export function refreshIndex() {
  live.forEach(view => view.refresh())
}

export function mountIndex(el) {
  const view = new IndexView(el)
  live.add(view)
  view.refresh()
  return { unmount: () => unmountIndex() }
}

/**
 * Leaving the view. The router keeps the object `views.register` was handed and calls
 * `unmount()` on that, not on what `mount` answered, so the table's keyboard has to be given
 * back from here. One view is on screen at a time; anything else in `live` is already gone.
 */
export function unmountIndex() {
  for (const view of [...live]) {
    live.delete(view)
    view.unmount()
  }
}

class IndexView {
  constructor(el) {
    this.el = el
    this.token = 0
    this.table = null
    this.root = null
    clear(el)
  }

  unmount() {
    if (this.table) { this.table.destroy(); this.table = null }
    clear(this.el)
  }

  /** The page column, built the first time the drills folder answers. */
  frame() {
    if (this.root) return
    this.root = h('div', { class: 'page-col nsi-index' })
    this.count = h('p', { class: 'page-meta' })
    this.body = h('div', {})
    this.root.appendChild(h('h1', { class: 'page-title view-title', text: 'Code' }))
    this.root.appendChild(this.count)
    this.root.appendChild(this.body)
    clear(this.el).appendChild(this.root)
  }

  async refresh() {
    const token = ++this.token
    // The drills folder before anything else. Without one the kernel has drawn what is missing
    // and its Choose button into `el`, and there is no table to draw over it.
    const folder = await dataRoot(this.el)
    if (token !== this.token) return
    if (!folder) {
      if (this.table) { this.table.destroy(); this.table = null }
      this.root = null
      return
    }
    this.frame()
    try {
      const drills = await listDrills()
      if (token !== this.token) return
      this.draw(drills)
    } catch (err) {
      if (token !== this.token) return
      this.fail(err)
    }
  }

  fail(err) {
    if (this.table) { this.table.destroy(); this.table = null }
    this.count.textContent = ''
    clear(this.body).appendChild(errorBlock({
      head: 'the drills could not be read',
      detail: String((err && err.message) || err),
      onRetry: () => this.refresh(),
    }))
  }

  draw(drills) {
    const done = drills.filter(d => d.done).length
    this.count.textContent = `${plural(drills.length, 'drill')} · ${done} done`
    const next = drills.find(d => !d.done)     // the first drill not done: where the keyboard starts
    const rows = drills.map(d => ({
      id: d.id,
      here: !!next && next.id === d.id,
      cells: {
        n: d.number == null ? '' : String(d.number),
        title: d.title,
        category: d.category,
        date: d.date,
        status: statusCell(d),
      },
    }))
    if (this.table) { this.table.update(rows); return }
    this.table = drillTable(clear(this.body), {
      columns: COLUMNS,
      rows,
      onOpen: row => openDrill(row.id),
      empty: `no drill folders under ${ctx.dataRoot} yet.`,
    })
  }
}

function openDrill(id) {
  return ctx.ose.route.navigate({ type: 'own', path: 'nsi/' + id })
}
