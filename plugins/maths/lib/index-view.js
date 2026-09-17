/* The Maths view: every series on one list, in name order.
 *
 * The row is the shared lib's, so this list and Informatique's are the same object rather than
 * two lists drawn from memory: number, name, one mono figure at the right. A series had no name
 * at all before — a bare integer and a date — while the palette already called it `Série 2`
 * (ADV-U). The family chips have left the row: every series carries the same five, so they told
 * the eye nothing and sliced in half at 900 px; they are on the series page now, with counts.
 *
 * Nothing on this list creates a series. Series come from the generator (`gen/generate.py`).
 */

import { confirm, toast } from 'ose:ui'
import { h, clear, duration, plural, list, errorBlock } from '../../_lib/drills.js'

import { ctx, requireRoot, vaultPath, serieFile, seriePath, resultatPath } from './ctx.js'
import { readAll } from './store.js'
import { openSerie } from './serie.js'

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

class IndexView {
  constructor(el) {
    this.el = el
    this.token = 0
    this.byKey = new Map()
    this.root = h('div', { class: 'page-col maths-index' })
    this.meta = h('p', { class: 'page-meta' })
    this.rowsHost = h('div', { class: 'maths-rows-host' })
    // Where the kernel draws its box when the vault does not say where the series are. It is an
    // element of its own so the box lands in something empty and the list keeps its host.
    this.boxHost = h('div', { class: 'maths-box-host' })
    this.root.append(h('h1', { class: 'page-title', text: 'Maths' }), this.meta,
      this.rowsHost, this.boxHost)
    clear(el).appendChild(this.root)
    this.list = null
  }

  unmount() {
    if (this.list) { this.list.dispose(); this.list = null }
    clear(this.el)
  }

  async refresh() {
    const token = ++this.token
    if (!this.list && !this.rowsHost.childElementCount) {
      this.meta.textContent = ''
      this.rowsHost.appendChild(h('p', { class: 'empty', text: 'reading the series…' }))
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

  /** No folder: the box says so, and there is no list to keep. */
  nothing() {
    if (this.list) { this.list.dispose(); this.list = null }
    this.byKey = new Map()
    this.meta.textContent = ''
    clear(this.rowsHost)
  }

  fail(err) {
    if (this.list) { this.list.dispose(); this.list = null }
    this.meta.textContent = ''
    clear(this.rowsHost).appendChild(errorBlock({
      head: 'the series could not be read',
      detail: String((err && err.message) || err),
      onRetry: () => void this.refresh(),
    }))
  }

  draw({ series, state }) {
    this.byKey = new Map(series.map(s => [s.id, s]))
    const done = series.filter(s => ((state.series || {})[s.id] || {}).statut === 'fait').length
    this.meta.textContent = `${plural(series.length, 'serie')} · ${done} done`

    const rows = series.map(s => this.row(s, state))
    if (!this.list) {
      this.list = list({
        root: this.rowsHost,
        rows,
        onOpen: (key) => void openSerie(key),
        menu: (key) => this.menu(key),
        empty: `no serie-NN.md in ${vaultPath('')} yet. The generator writes them.`,
      })
    } else {
      this.list.refresh(rows)
    }
    this.markMalformed(series)
  }

  /**
   * One series. The number, the name, and at the right one figure of one kind: how long it took
   * once it is done, the date it is for until then. It used to hold `18/70 · 3 min 15` on one
   * row and `2026-09-17` on the next, so the column could not be read down and did not line up
   * with Informatique's, which has always been a time (Q1). The score has not gone anywhere:
   * it is the verdict's figure on the series page. `done` is the green ground, `again` — the
   * accent edge — is the series in progress, which is the one asking for another go.
   */
  row(s, state) {
    const row = (state.series || {})[s.id] || null
    const isDone = !!row && row.statut === 'fait'
    const going = !!state.en_cours && state.en_cours.serie === s.id
    const number = s.n == null ? s.id.replace(/^serie-0*/, '') : String(s.n)
    return {
      key: s.id,
      num: number,
      name: s.ok ? `Série ${number}` : 'malformed',
      fig: isDone ? duration(row.duree_s) : (s.date || ''),
      state: isDone ? 'done' : going ? 'again' : 'plain',
    }
  }

  /* The lib's row takes a state, not a class, and `malformed` is not a state of a drill — it is
     a state of the file. So the one word that needs the error ink is marked here, after every
     draw, on the name cell the lib built. */
  markMalformed(series) {
    for (const s of series) {
      if (s.ok) continue
      const name = this.rowsHost.querySelector(`.drill-row[data-key="${CSS.escape(s.id)}"] .drill-name`)
      if (name) name.classList.add('maths-malformed')
    }
  }

  menu(key) {
    const s = this.byKey.get(key)
    if (!s) return []
    const items = [
      { label: 'Open', run: () => void openSerie(s.id) },
      { sep: true },
      { label: `Open ${serieFile(s.id)}`, run: () => ctx.ose.route.navigate({ type: 'page', path: seriePath(s.id) }) },
      { label: 'Show in the file manager', run: () => void this.reveal(s.id) },
    ]
    if (s.hasResultat) {
      items.push({ label: 'Open the result', run: () => ctx.ose.route.navigate({ type: 'page', path: resultatPath(s.id) }) })
    }
    items.push({ sep: true })
    // The same verb gets the same treatment in both plugins: the danger ink here and in the
    // dialog it opens. It was the ink of `Open` on this menu and red on Informatique's (Q1).
    items.push({ label: 'Delete…', danger: true, run: () => void this.remove(s) })
    return items
  }

  /** The series file where it lives, selected in the file manager. */
  async reveal(id) {
    const target = seriePath(id)
    try {
      const files = ctx.ose.files
      if (files.reveal) await files.reveal(target)
      else await files.open(target)
    } catch (err) {
      toast('Maths: ' + ((err && err.message) || err), 'err')
    }
  }

  /** A generated series can be wrong, and the trash is cheap. It asks first, every time. */
  async remove(s) {
    const number = s.n == null ? s.id.replace(/^serie-0*/, '') : String(s.n)
    const yes = await confirm({
      title: `Delete Série ${number}?`,
      body: `${serieFile(s.id)} goes to the trash. What it wrote to the log and its result file stay.`,
      ok: 'Delete',
      danger: true,
    })
    if (!yes) return
    try {
      await ctx.ose.files.trash(seriePath(s.id))
    } catch (err) {
      toast('Maths: ' + ((err && err.message) || err), 'err')
      return
    }
    await this.refresh()
  }
}
