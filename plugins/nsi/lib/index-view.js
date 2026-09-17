/* The Informatique index: every drill on one flat list, in number order. A row is the number,
   the title, its tags and the best time it has ever been done in. A row's state is its colour.
   Every row operation is on the context menu, by mouse or by key.

   Nothing on this list creates a drill: drills come from a generator, the way Maths' series do,
   and the `+ new drill` row that used to sit at the bottom made an empty folder the module then
   offered to grade you against (ADV-N, ADV-U, ADV-V, ADV-B). */

import { prompt, confirm, toast } from 'ose:ui'
import { h, clear, plural, duration, tones, list, errorBlock }
  from '../../../lib/drills.js'

import { ctx, vaultPath } from './ctx.js'
import { cli } from './cli.js'

const live = new Set()

export function refreshIndex() {
  live.forEach(view => view.refresh())
}

export function mountIndex(el) {
  const view = new IndexView(el)
  live.add(view)
  view.refresh()
  return {
    unmount() { live.delete(view); view.unmount() },
    refresh: () => view.refresh(),
  }
}

/** A drill's place in the list: its number, and its id when two share one. */
export function byNumber(a, b) {
  const na = Number(a.number)
  const nb = Number(b.number)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return String(a.number ?? '').localeCompare(String(b.number ?? ''), undefined, { numeric: true })
    || String(a.id).localeCompare(String(b.id))
}

class IndexView {
  constructor(el) {
    this.el = el
    this.root = h('div', { class: 'page-col nsi-index' })
    clear(el).appendChild(this.root)
    this.token = 0
    this.byId = new Map()
    this.list = null
    this.head = h('h1', { class: 'page-title', text: 'Informatique' })
    this.count = h('p', { class: 'page-meta' })
    this.body = h('div', {})
    this.root.appendChild(this.head)
    this.root.appendChild(this.count)
    this.root.appendChild(this.body)
  }

  unmount() {
    if (this.list) { this.list.dispose(); this.list = null }
    clear(this.el)
  }

  async refresh() {
    const token = ++this.token
    if (!this.list && !this.body.childElementCount) {
      this.count.textContent = ''
      this.body.appendChild(h('p', { class: 'empty', text: 'reading the drills…' }))
    }
    try {
      const body = await cli.list()
      if (token !== this.token) return
      this.draw(Array.isArray(body.drills) ? body.drills : [])
    } catch (err) {
      if (token !== this.token) return
      this.fail(err)
    }
  }

  fail(err) {
    if (this.list) { this.list.dispose(); this.list = null }
    this.count.textContent = ''
    clear(this.body).appendChild(errorBlock({
      head: 'the judge could not run',
      detail: [err && err.message, err && err.detail].filter(Boolean).join('\n'),
      onRetry: () => this.refresh(),
    }))
  }

  draw(drills) {
    const rows = [...drills].sort(byNumber)
    this.byId = new Map(rows.map(d => [d.id, d]))
    const done = rows.filter(isDone).length
    this.count.textContent = `${plural(rows.length, 'drill')} · ${done} done`

    // One tone map for the whole listing: a tag is the same colour on every row, and with
    // eight tones over the sorted set no two of the vault's five names collide (ADV-U).
    const toneMap = tones(rows.flatMap(d => d.tags || []))
    const model = rows.map(d => ({
      key: d.id,
      num: d.number ?? '',
      name: d.title,
      chips: d.tags || [],
      tones: toneMap,
      // The best time belongs to a drill that has ever passed. It used to be gated on today's
      // status, so a failed review blanked the column (ADV-N).
      fig: d.meilleure_s ? duration(d.meilleure_s) : '',
      state: isDone(d) ? 'done' : d.status === 'failed' ? 'again' : 'plain',
    }))

    if (this.list) {
      this.list.refresh(model)
      return
    }
    clear(this.body)
    this.list = list({
      root: this.body,
      rows: model,
      onOpen: key => openDrill(key),
      menu: key => this.rowMenu(this.byId.get(key)),
      empty: `no drill folders under ${ctx.dataRoot} yet.`,
    })
  }

  rowMenu(item) {
    if (!item) return []
    return [
      { label: 'Open', run: () => openDrill(item.id) },
      { label: 'Edit tags…', run: () => this.editTags(item) },
      { sep: true },
      { label: 'Open folder', run: () => this.openFolder(item) },
      { label: 'Open statement', run: () => this.openFileOf(item, 'enonce.md') },
      { label: 'Open meta.json', run: () => this.openFileOf(item, 'meta.json') },
      { sep: true },
      { label: 'Delete…', danger: true, run: () => this.remove(item) },
    ]
  }

  /* ------------------------------------------------------------------ row verbs */

  async editTags(item) {
    const answer = await prompt({
      title: 'Tags', value: (item.tags || []).join(', '), ok: 'Save',
      placeholder: 'dictionnaires, parcours',
      body: 'Comma separated. A single - clears them.',
    })
    if (answer == null) return
    const tags = answer === '-' ? [] : answer.split(',').map(t => t.trim()).filter(Boolean)
    try {
      await cli.update(item.id, tags)
      await this.refresh()
    } catch (err) {
      toast('Informatique: ' + (err.message || err), 'err')
    }
  }

  /** One of the drill's own files, as a page in Ose, so an edit is one click away. */
  async openFileOf(item, name) {
    try {
      await ctx.ose.route.navigate({ type: 'page', path: vaultPath(item.id + '/' + name) })
    } catch (err) { toast('Informatique: ' + (err.message || err), 'err') }
  }

  async openFolder(item) {
    const target = vaultPath(item.id)
    const files = ctx.ose.files
    try {
      if (files.reveal) { await files.reveal(target); return }
      await files.open(target)
    } catch (err) {
      try { await files.open(target) }
      catch { toast(String((err && err.message) || err), 'err') }
    }
  }

  /**
   * Delete. The confirm names the files that are really there — it used to recite a fixed
   * sentence about tests and a correction a drill may never have had (ADV-N) — and it reads
   * the folder rather than asking the judge, so the dialog is up at once (the old one waited
   * two to three seconds on a Python process before it appeared).
   */
  async remove(item) {
    const folder = vaultPath(item.id)
    let names = []
    try {
      names = (await ctx.ose.files.list(folder)).map(f => f.name).sort()
    } catch { /* the dialog can name the folder alone */ }
    const what = names.length
      ? `, with ${names.join(', ')} in it`
      : ''
    const yes = await confirm({
      title: 'Delete this drill?',
      body: `“${item.title}” and its folder ${item.id} go to the trash${what}.`,
      ok: 'Delete', danger: true,
    })
    if (!yes) return
    try {
      await ctx.ose.files.trash(folder)
      toast(`${item.title} is in the trash`)
      await this.refresh()
    } catch (err) {
      toast('Informatique: ' + (err.message || err), 'err')
    }
  }
}

/** Solved, and a review that has come round: both are drills you have done. */
export function isDone(item) {
  return !!item && (item.status === 'solved' || item.status === 'due')
}

export function openDrill(id) {
  return ctx.ose.route.navigate({ type: 'own', path: 'nsi/' + id })
}

/** The judge will not run: one box, the words of whatever threw, and a way to try again. */
export function judgeError(err, retry) {
  return errorBlock({
    head: 'the judge could not run',
    detail: [err && err.message, err && err.detail].filter(Boolean).join('\n'),
    onRetry: retry,
  })
}
