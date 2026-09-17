/* The shared drills table. One real `<table>` for both drill indexes, so the Maths list and the
   Informatique list are the same object and not two lists drawn from memory.

     import { drillTable } from '../_lib/table.js'
     const t = drillTable(el, {
       columns: [{ key: 'n', title: '#', align: 'right', mono: true },
                 { key: 'title', title: 'Title', grow: true }],
       rows: [{ id: 'serie-02', cells: { n: '2', title: 'Suites',
                                         status: { text: 'done 61 / 70', tone: 'ok' } } }],
       onOpen: (row) => {},      // the row object, on a click or on Enter
       empty: 'No series yet.',  // the sentence drawn in the table when rows is empty
     })
     t.update(rows)              // repaint, keeping the focused row when its id survives
     t.destroy()

   A cell is a string or `{ text, tone }`, `tone` one of `ok`, `warn`, `muted`. A column is
   `{ key, title, align, mono, grow }`; `grow` is the one column that takes the slack.

   One tab stop: Tab reaches the table, Up, Down, Home and End walk the rows, Enter opens, Tab
   leaves — the way the sidebar and the palette behave. It knows nothing about either plugin: no
   file name, no route, no status rule. Everything it draws is styled by `table.css`, which this
   file links itself. */

const TONES = new Set(['ok', 'warn', 'muted'])
const ROW = '.dt-row'

/** Link `table.css` once. `import.meta.url` is this file's own, so the href is right in the exe
    and in the dev server. Never removed: the lib is shared with whoever else is on screen. */
function ensureStylesheet() {
  if (document.head.querySelector('link[data-shared="drill-table"]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.dataset.shared = 'drill-table'
  link.href = new URL('./table.css', import.meta.url).href
  document.head.appendChild(link)
}

class DrillTable {
  constructor(el, { columns, rows, onOpen, empty } = {}) {
    ensureStylesheet()
    this.el = el
    this.columns = (Array.isArray(columns) ? columns : []).filter(Boolean)
    this.onOpen = typeof onOpen === 'function' ? onOpen : null
    this.empty = empty == null ? '' : String(empty)
    this.current = null                 // the id that holds the tab stop
    this.byId = new Map()

    this.table = document.createElement('table')
    this.table.className = 'dt-table'
    const head = this.table.createTHead().insertRow()
    for (const col of this.columns) head.appendChild(this.cell('th', col, col.title))
    this.body = this.table.createTBody()
    while (el.firstChild) el.removeChild(el.firstChild)
    el.appendChild(this.table)

    // Wired on the body, which outlives every repaint: wiring per draw would stack a listener
    // an update and open a row twice on one press.
    this.onKey = (event) => this.key(event)
    this.onClick = (event) => this.click(event)
    this.body.addEventListener('keydown', this.onKey)
    this.body.addEventListener('click', this.onClick)
    this.update(rows)
  }

  cell(tag, col, value) {
    const object = value && typeof value === 'object'
    const tone = object ? String(value.tone || '') : ''
    const text = object ? value.text : value
    const el = document.createElement(tag)
    el.className = [
      tag === 'th' ? 'dt-head' : 'dt-cell',
      col.mono ? 'dt-mono' : '',
      col.grow ? 'dt-grow' : '',
      col.align === 'right' ? 'dt-right' : col.align === 'center' ? 'dt-center' : '',
      TONES.has(tone) ? 'dt-' + tone : '',
    ].filter(Boolean).join(' ')
    el.textContent = text == null ? '' : String(text)
    return el
  }

  update(rows) {
    const had = this.focusedId()
    const keep = had == null ? this.current : had
    const list = (Array.isArray(rows) ? rows : []).filter(r => r && r.id != null)
    this.byId = new Map(list.map(r => [String(r.id), r]))
    while (this.body.firstChild) this.body.removeChild(this.body.firstChild)
    if (!list.length) {
      this.current = null
      const tr = this.body.insertRow()
      const td = tr.insertCell()
      td.className = 'dt-cell dt-empty'
      td.colSpan = Math.max(1, this.columns.length)
      td.textContent = this.empty
      return
    }
    for (const row of list) {
      const tr = this.body.insertRow()
      tr.className = 'dt-row'
      tr.tabIndex = -1
      tr.dataset.id = String(row.id)
      for (const col of this.columns) tr.appendChild(this.cell('td', col, (row.cells || {})[col.key]))
    }
    // The tab stop goes back where it was, or to the first row when that id is gone.
    const still = keep != null && this.byId.has(String(keep)) ? String(keep) : String(list[0].id)
    this.setCurrent(still)
    if (had != null) this.focus(still)
  }

  rowNodes() { return [...this.body.querySelectorAll(ROW)] }

  /** The row that has the focus now, so a repaint under the user's hands does not lose it. */
  focusedId() {
    const el = document.activeElement
    if (!el || !this.body.contains(el)) return null
    const row = el.closest ? el.closest(ROW) : null
    return row ? (row.dataset.id || null) : null
  }

  /* The row the keyboard is on: it holds the one tab stop and it wears the mark. The mark is a
     class and not `:focus`, so it is still there when the window is not — the way the sidebar
     and the palette mark the row they are on. */
  setCurrent(id) {
    this.current = id == null ? null : String(id)
    for (const node of this.rowNodes()) {
      const mine = node.dataset.id === this.current
      node.tabIndex = mine ? 0 : -1
      node.classList.toggle('dt-current', mine)
    }
  }

  focus(id) {
    const node = id == null ? null
      : this.body.querySelector(`${ROW}[data-id="${CSS.escape(String(id))}"]`)
    if (!node) return false
    this.setCurrent(node.dataset.id)
    node.focus()
    return true
  }

  open(id) {
    const row = this.byId.get(String(id))
    if (this.onOpen && row) this.onOpen(row)
  }

  click(event) {
    const row = event.target.closest ? event.target.closest(ROW) : null
    if (!row || !this.body.contains(row)) return
    this.setCurrent(row.dataset.id)
    this.open(row.dataset.id)
  }

  key(event) {
    const rows = this.rowNodes()
    if (!rows.length) return
    const at = rows.findIndex(r => r.contains(document.activeElement))
    if (at >= 0 && event.key === 'Enter') {
      event.preventDefault()
      this.open(rows[at].dataset.id)
      return
    }
    let to = -1
    if (event.key === 'ArrowDown') to = at < 0 ? 0 : Math.min(rows.length - 1, at + 1)
    else if (event.key === 'ArrowUp') to = at <= 0 ? 0 : at - 1
    else if (event.key === 'Home') to = 0
    else if (event.key === 'End') to = rows.length - 1
    if (to < 0) return
    event.preventDefault()
    this.setCurrent(rows[to].dataset.id)
    rows[to].focus()
  }

  destroy() {
    this.body.removeEventListener('keydown', this.onKey)
    this.body.removeEventListener('click', this.onClick)
    while (this.el.firstChild) this.el.removeChild(this.el.firstChild)
    this.byId = new Map()
  }
}

/** Draw a table of drills into `el`. Answers `{ update(rows), focus(id), destroy() }`. */
export function drillTable(el, options) {
  const view = new DrillTable(el, options || {})
  return {
    update: (rows) => view.update(rows),
    focus: (id) => view.focus(id),
    destroy: () => view.destroy(),
  }
}
