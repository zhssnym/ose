/* One series, one owned route (`maths/serie-NN`).
 *
 * The page is one skeleton and it never changes shape. Title line with the clock at the right,
 * one meta line, a statement band, a work band, one control band at a fixed y, a hint, and the
 * quiet path line at the foot. The door, the session and the result all fill those same bands,
 * so pressing `start` does not move the page and neither does question fourteen. Before this
 * the only button on screen sat at a different height on all seventy questions and leapt 240 px
 * on every reveal (ADV-V).
 */

import { confirm, toast } from 'ose:ui'
import {
  h, clear, append, duration, plural, tones, chips, ymd,
  titleLine, metaLine, controls, verdict, errorBlock, pathLine, focusMode,
  createClock, mountClock,
} from '../../_lib/drills.js'

import { ctx, requireRoot, serieFile, seriePath, absPath } from './ctx.js'
import { readSerie, readState, readLog, lastMisses, record } from './store.js'
import { Session, priorAnswers, PAUSE_CAP_MS } from './session.js'
import { resultBlock } from './summary.js'
import { familyCounts } from './parse.js'

/** The page on screen. `maths.start` uses it to start a series already open. */
export let activePage = null

/* `maths.start` navigates and the page starts itself when it arrives. One name, consumed by
   the first mount that sees it, so a later visit to the same route is an ordinary visit. */
let pending = null
export function requestStart(name) { pending = name }

export function openSerie(name) {
  return ctx.ose.route.navigate({ type: 'own', path: 'maths/' + name })
}

export function mountSerie(el, route) {
  const name = String(route.path || '').replace(/^maths\//, '')
  const page = new SeriePage(el, name)
  void page.load()
  return {
    title: name,
    unmount: () => page.unmount(),
  }
}

class SeriePage {
  constructor(el, name) {
    this.el = el
    this.name = name
    this.gone = false
    this.session = null
    this.serie = null
    this.state = null
    this.summary = null
    this.misses = []

    this.root = h('div', { class: 'page-col maths-serie' })
    const title = titleLine(name)
    this.titleEl = title.el
    this.clockEl = title.clockEl
    this.metaHost = h('div', { class: 'maths-meta-host' })
    this.body = h('div', { class: 'maths-body' })
    this.pathHost = h('div', { class: 'maths-path-host' })
    append(this.root, [this.titleEl, this.metaHost, this.body, this.pathHost])
    clear(el).appendChild(this.root)

    // Ctrl+R and a closed window: K's kernel change awaits `unmount` and calls it on reload.
    // Until it lands this is the same exit, and it costs nothing to keep afterwards.
    this.onPageHide = () => { void this.leaveSession() }
    window.addEventListener('pagehide', this.onPageHide)
    activePage = this
  }

  unmount() {
    this.gone = true
    if (activePage === this) activePage = null
    window.removeEventListener('pagehide', this.onPageHide)
    const done = this.leaveSession()
    focusMode(false)                 // every exit path, whether a session ran or not
    clear(this.el)
    return done
  }

  /** A session that is on this page and has not finished. `maths.start` never ends one. */
  get live() { return !!this.session && !this.session.ended }

  /** Where the keys are: the session's own root, which is the only thing that listens. */
  focusSession() {
    const root = this.body.querySelector('.maths-session')
    if (root) root.focus()
    return !!root
  }

  /** The door's primary button, when there is a door. Answers false when there is not. */
  focusDoor() {
    const button = this.body.querySelector('.drill-controls .btn')
    if (!button) return false
    button.focus()
    return true
  }

  /** The one way a session stops. Answers a promise so `unmount` can be awaited. */
  leaveSession() {
    const session = this.session
    this.session = null
    if (this.unbindClock) { this.unbindClock(); this.unbindClock = null }
    if (!session) {
      if (this.clock) { this.clock.dispose(); this.clock = null }
      return Promise.resolve()
    }
    session.gone = true
    const done = session.leave().catch(err => console.error('[maths]', err))
    if (this.clock) { this.clock.dispose(); this.clock = null }
    return done
  }

  /* ------------------------------------------------------------- reading */

  async load() {
    this.metaHost.textContent = ''
    // The folder first, into a body with nothing in it: `null` is the kernel's box, and the page
    // stops there. Nothing else on the page can be drawn without it.
    clear(this.body)
    const root = await requireRoot(this.body)
    if (this.gone) return
    if (!root) { clear(this.pathHost); return }
    this.body.appendChild(h('p', { class: 'empty', text: 'reading the series…' }))
    let serie = null
    let state = null
    let misses = []
    try {
      serie = await readSerie(this.name)
      if (this.gone) return
      state = await readState()
      if (this.gone) return
      misses = await lastMisses(serie)
    } catch (err) {
      if (this.gone) return
      clear(this.body).appendChild(errorBlock({
        head: 'the series could not be read',
        detail: String((err && err.message) || err),
        onRetry: () => void this.load(),
      }))
      return
    }
    if (this.gone) return
    this.serie = serie
    this.state = state
    this.misses = misses
    this.summary = null
    this.draw()
    if (pending === this.name) {
      pending = null
      if (this.serie.ok && !this.otherGoing) await this.start()
    }
  }

  get row() { return (this.state.series || {})[this.name] || null }
  get isDone() { return !!this.row && this.row.statut === 'fait' }
  get going() { return this.state.en_cours && this.state.en_cours.serie ? this.state.en_cours : null }
  get resumable() { return !!this.going && this.going.serie === this.name }
  get otherGoing() { return this.going && this.going.serie !== this.name ? this.going : null }

  /* ---------------------------------------------------------- the skeleton */

  /** The title and the meta line, which every mode shares. */
  head({ progress } = {}) {
    const s = this.serie
    const title = s.n ? `Série ${s.n}` : this.name
    ctx.ose.route.title(title)
    this.titleEl.querySelector('.page-title').textContent = title

    const facts = []
    if (progress) facts.push(progress)
    if (s.ok) {
      facts.push(`${s.duree} min`)
      if (!progress) facts.push(plural(s.questions.length, 'question'))
      if (s.date) facts.push(s.date)
    }
    const counts = s.ok ? familyCounts(s) : []
    const names = counts.map(c => c.famille)
    const chipsEl = counts.length
      ? chips(names, {
          tones: tones(names),
          counts: new Map(counts.map(c => [c.famille, c.count])),
        })
      : null
    clear(this.metaHost).appendChild(metaLine(chipsEl, facts))
  }

  foot() {
    clear(this.pathHost).appendChild(pathLine(absPath(serieFile(this.name)), {
      onOpen: () => void this.reveal(),
    }))
  }

  /** The series file where it lives, selected in the file manager. */
  async reveal() {
    const target = seriePath(this.name)
    try {
      const files = ctx.ose.files
      if (files.reveal) await files.reveal(target)
      else await files.open(target)
    } catch (err) {
      toast('Maths: ' + ((err && err.message) || err), 'err')
    }
  }

  /* ------------------------------------------------------------- the door */

  draw() {
    const s = this.serie
    this.head()
    const body = clear(this.body)
    this.clockEl.textContent = ''

    if (!s.ok) {
      body.appendChild(this.errorPane())
      this.foot()
      return
    }

    // The control band first and the verdict directly under it, then the numbers: ADV-V's
    // wireframe puts the verdict below the band with nothing above it moving, and fifty-two
    // misses above the only button on the page left it nowhere to live (Q1).
    body.appendChild(this.doorControls())

    if (this.isDone && !this.resumable) {
      const row = this.row
      const medians = row.mediane_reflexion_ms || {}
      body.appendChild(this.verdictLine(row))
      body.appendChild(resultBlock({
        familles: Object.keys(medians).map(famille => ({ famille, mediane: medians[famille] })),
        misses: this.misses,
        note: `${plural(row.tentatives || 1, 'attempt')} · done ${row.date || '—'}`,
      }))
    }

    this.foot()
    const first = body.querySelector('.drill-controls .btn')
    if (first) first.focus()
  }

  /**
   * How it went, in the shared lib's one component, the same object Informatique draws. A
   * series has no pass and no fail — it is never finished on a threshold — so the state is
   * always `ok` and the word is what is true: it is done. The figure carries the score, which
   * is why the list's right-hand column no longer does (Q1).
   */
  verdictLine({ justes, total, duree_s }) {
    return verdict({
      state: 'ok',
      word: 'done',
      figure: `${justes}/${total} · ${duration(duree_s)}`,
    })
  }

  /**
   * One button, and the hint beside it. When another series is half done the door says so and
   * offers both ways out: starting this one used to overwrite `en_cours` in silence and leave
   * the other one's answers in the log as orphans (ADV-M).
   */
  doorControls() {
    const other = this.otherGoing
    if (other) {
      const n = String(other.serie).replace(/^serie-0*/, '')
      // The chord goes beside `resume Série N` because that is exactly what it does from here:
      // `maths.start` on a page that is not the series in progress draws this door and stops.
      return controls([
        { label: `resume Série ${n}`, primary: true, chord: this.chord(), onClick: () => void openSerie(other.serie) },
        { label: 'start this one instead', onClick: () => void this.startInstead(other) },
      ], `Série ${n} is in progress`)
    }
    const label = this.resumable ? 'resume' : this.isDone ? 'redo' : 'start'
    const hint = this.resumable
      ? `question ${this.going.n} of ${this.serie.questions.length}, ${duration((this.going.ecoule_ms || 0) / 1000)} on the clock`
      : this.isDone ? 'a new attempt; the row keeps the first one'
      : 'never pass: choose the most plausible and move on'
    return controls(
      [{ label, primary: true, onClick: () => void this.start(), chord: this.chord() }],
      hint)
  }

  async startInstead(other) {
    const n = String(other.serie).replace(/^serie-0*/, '')
    const yes = await confirm({
      title: 'Start this series?',
      body: `Série ${n} is in progress at question ${other.n}. Starting this one gives it up: its answers stay in the log and it goes back to the beginning.`,
      ok: 'Start this one',
    })
    if (!yes || this.gone) return
    await this.start()
  }

  /** A file that does not parse: every error with its line, and no way to start. */
  errorPane() {
    const box = errorBlock({
      head: 'this series does not parse',
      detail: `${serieFile(this.name)} does not follow the grammar, so it cannot be run. Nothing has been changed in the file.`,
      onRetry: () => void this.load(),
    })
    const list = h('ul', { class: 'maths-error-list' })
    for (const error of this.serie.errors) {
      list.appendChild(h('li', {},
        h('span', { class: 'maths-error-line mono-sm' }, `line ${error.line}`), ' ', error.message))
    }
    box.insertBefore(list, box.querySelector('.btn'))
    box.insertBefore(h('button', {
      class: 'drill-link mono-sm', type: 'button',
      onclick: () => ctx.ose.route.navigate({ type: 'page', path: seriePath(this.name) }),
    }, `open ${serieFile(this.name)}`), box.querySelector('.btn'))
    return box
  }

  /* ---------------------------------------------------------- the session */

  async start() {
    if (!this.serie || !this.serie.ok || this.session || this.gone) return

    const state = await readState()
    if (this.gone) return
    this.state = state
    const row = this.row
    const tentative = (row && Number(row.tentatives) ? Number(row.tentatives) : 0) + 1

    let startAt = 0, bankedMs = 0, pauseMs = 0, debut = null, prior = []
    if (this.resumable) {
      const going = this.going
      const at = Math.max(0, (Number(going.n) || 1) - 1)
      startAt = at >= this.serie.questions.length ? 0 : at
      bankedMs = Number(going.ecoule_ms) || 0
      pauseMs = (Number(going.pause_s) || 0) * 1000 + awayMs(going.vu)
      debut = going.debut || null
      const { answers } = await readLog()
      if (this.gone) return
      prior = priorAnswers(answers, this.name, startAt + 1)
    }
    if (this.gone) return

    const bands = this.sessionBands()
    this.clock = createClock({
      onBank: () => { if (this.session) void this.session.persist() },
    })
    this.clock.setBanked(bankedMs / 1000)
    this.unbindClock = mountClock(this.clock, this.clockEl, { budgetS: (this.serie.duree || 0) * 60 })

    this.session = new Session({
      serie: this.serie, bands, clock: this.clock,
      startAt, pauseMs, debut, tentative, prior,
      warn: (err) => {
        console.error('[maths] session write', err)
        toast('Maths: ' + ((err && err.message) || err), 'err')
      },
      onProgress: (at, total) => this.head({ progress: `${at} / ${total}` }),
      onEnd: (summary) => void this.finished(summary),
    })
    bands.root.addEventListener('keydown', e => this.session && this.session.onKey(e))
    this.session.begin()
  }

  /** The three bands the session draws into. They are built once and never rebuilt. */
  sessionBands() {
    const statement = h('div', { class: 'drill-band-statement' })
    const work = h('div', { class: 'drill-band-work' })
    const band = h('div', { class: 'drill-controls' })
    const hint = h('span', { class: 'drill-hint mono-sm' })
    const root = h('div', { class: 'maths-session', tabindex: '-1' }, statement, work, band)
    clear(this.body).appendChild(root)
    this.foot()
    root.focus()
    return { root, statement, work, controls: band, hint }
  }

  async finished(summary) {
    this.session = null
    if (this.unbindClock) { this.unbindClock(); this.unbindClock = null }
    if (this.clock) { this.clock.dispose(); this.clock = null }
    this.summary = summary
    try {
      await record(this.name, summary, ymd())
    } catch (err) {
      toast('Maths: ' + ((err && err.message) || err), 'err')
    }
    if (this.gone) return
    this.state = await readState()
    if (this.gone) return
    this.misses = summary.misses
    this.drawSummary()
  }

  drawSummary() {
    this.head()
    this.clockEl.textContent = ''
    const body = clear(this.body)
    body.appendChild(controls([
      { label: 'redo', primary: true, onClick: () => void this.start(), chord: this.chord() },
      { label: 'back to the series', onClick: () => void this.load() },
    ]))
    body.appendChild(this.verdictLine(this.summary))
    body.appendChild(resultBlock(this.summary))
    this.foot()
    const first = body.querySelector('.drill-controls .btn')
    if (first) first.focus()
  }

  /** The chord beside the primary button, printed on every band this page draws. */
  chord() { return ctx.ose.keys.shortcutFor('maths.start') }
}

/**
 * Time away from the page, in milliseconds. The session stamps `en_cours.vu` every time it
 * writes, and this counts from that stamp to now, so the minutes between pressing Back and
 * pressing resume land in `pause_s` instead of nowhere — and so do the minutes after a window
 * that was closed without its last write landing. One stretch is capped like any other pause:
 * a series left open for a week did not pause for a week.
 */
function awayMs(vu) {
  if (!vu) return 0
  const seen = Date.parse(String(vu))
  if (!Number.isFinite(seen)) return 0
  return Math.min(Math.max(0, Date.now() - seen), PAUSE_CAP_MS)
}
