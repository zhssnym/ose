/* The Maths view: every series in one table, in name order.
 *
 * The table is the shared lib's, so this one and Code's are the same object rather than
 * two lists drawn from memory: a real `<table>` with bordered cells and a header, four columns,
 * `#`, `Title`, `Date` and `Status`. The status is computed from the log every time it is
 * drawn, because the log is the only state there is.
 *
 * Nothing on this page creates, opens or deletes a file: series are written into the folder by
 * an AI, and clicking a row starts answering it.
 */

import { h, clear, plural, errorBlock } from '../../_lib/drills.js'
import { drillTable } from '../../_lib/table.js'

import { requireRoot, vaultPath } from './ctx.js'
import { readAll, progressOf } from './store.js'
import { openSerie } from './serie.js'

const COLUMNS = [
  { key: 'n', title: '#', align: 'right', mono: true },
  { key: 'title', title: 'Title', grow: true },
  { key: 'date', title: 'Date', mono: true },
  { key: 'status', title: 'Status', mono: true },
]

const live = new Set()

export function refreshIndex() { live.forEach(view => void view.refresh()) }

export function mountIndex(el) {
  const view = new IndexView(el)
  live.add(view)
  void view.refresh()
  return {
    unmount() { live.delete(view); view.unmount() },
    refresh: () => void view.refresh(),
  }
}

/** What the log says about a series, in the three words the Status column has to say. */
export function statusCell(serie, answers) {
  if (!serie.ok) return { text: 'does not parse', tone: 'warn' }
  const { answered, correct, total, done } = progressOf(answers, serie.id, serie.questions.length)
  if (done) return { text: `done ${correct} / ${total}`, tone: 'ok' }
  if (answered) return { text: `${answered} / ${total}`, tone: 'warn' }
  return { text: 'not done', tone: 'muted' }
}

class IndexView {
  constructor(el) {
    this.el = el
    this.token = 0
    this.root = h('div', { class: 'page-col maths-index' })
    this.meta = h('p', { class: 'page-meta' })
    this.tableHost = h('div', { class: 'maths-table-host' })
    // Where the kernel draws its box when the vault does not say where the series are. It is an
    // element of its own so the box lands in something empty and the table keeps its host.
    this.boxHost = h('div', { class: 'maths-box-host' })
    this.root.append(h('h1', { class: 'page-title view-title', text: 'Maths' }), this.meta,
      this.tableHost, this.boxHost)
    clear(el).appendChild(this.root)
    this.table = null
  }

  unmount() {
    if (this.table) { this.table.destroy(); this.table = null }
    clear(this.el)
  }

  async refresh() {
    const token = ++this.token
    if (!this.table && !this.tableHost.childElementCount) {
      this.meta.textContent = ''
      this.tableHost.appendChild(h('p', { class: 'maths-empty', text: 'reading the series…' }))
    }
    // The folder is asked for here and not once at boot: the owner can point the plugin at
    // another one, and a `null` is a box in `boxHost` saying what is missing, not an error.
    const root = await requireRoot(clear(this.boxHost))
    if (token !== this.token) return
    if (!root) { this.nothing(); return }
    let body = null
    try {
      body = await readAll()
    } catch (err) {
      if (token !== this.token) return
      this.fail(err)
      return
    }
    if (token !== this.token) return
    this.draw(body)
  }

  /** No folder: the box says so, and there is no table to keep. */
  nothing() {
    if (this.table) { this.table.destroy(); this.table = null }
    this.meta.textContent = ''
    clear(this.tableHost)
  }

  fail(err) {
    if (this.table) { this.table.destroy(); this.table = null }
    this.meta.textContent = ''
    clear(this.tableHost).appendChild(errorBlock({
      head: 'the series could not be read',
      detail: String((err && err.message) || err),
      onRetry: () => void this.refresh(),
    }))
  }

  draw({ series, answers }) {
    let done = 0
    let next = null                     // the first series that is not done: where the keyboard starts
    const rows = series.map(s => {
      const status = statusCell(s, answers)
      if (status.tone === 'ok') done += 1
      else if (next == null) next = s.id
      return {
        id: s.id,
        here: next === s.id,
        cells: {
          n: s.n == null ? s.id.replace(/^serie-0*/, '') : String(s.n),
          title: s.titre || s.id,
          date: s.date || '',
          status,
        },
      }
    })
    this.meta.textContent = `${plural(series.length, 'serie')} · ${done} done`
    if (!this.table) {
      this.table = drillTable(clear(this.tableHost), {
        columns: COLUMNS,
        rows,
        onOpen: (row) => void openSerie(row.id),
        empty: `no serie-NN.md in ${vaultPath('')} yet`,
      })
    } else {
      this.table.update(rows)
    }
  }
}
