/* The session: one series, one question at a time, and a log line the moment an answer is
   confirmed. It draws into the bands the series page holds open for it, so nothing on the page
   moves between one question and the next.

   The rules of the thing, from 0-index.md and the post-mortem in 1-erreurs.md:

     - the question is solved on paper first, so the four options stay behind one control;
     - the measure that counts is the thinking time between the question appearing and the
       reveal, which is why `reflexion_ms` and `reponse_ms` are separate;
     - **never pass**: there is no skip and no back. Choose the most plausible and move on;
     - nothing says right or wrong until the end.

   ## One key, one job

   Space reveals, and only in `statement`. Enter confirms, and only in `options`, and only with
   a choice. 1–4 and A–D choose. Esc pauses and resumes. Enter used to do all three, so the
   natural "confirm, next" double-tap recorded a thinking time of 16 ms and a median of 0.0 s
   reached `bilan.md`, which the generator reads (ADV-M). Tab is trapped inside the session:
   six presses of it used to walk the focus onto the toolbar and kill every key while the clock
   ran, with nothing on screen to say so.

   ## One clock

   The shared lib's, one per session, owned by the page. `reflexion_ms` and `reponse_ms` are
   two marks on that same clock and a subtraction, so a pause, a hidden window and a closed lid
   are excluded from the thinking time by construction rather than by a second set of timers
   that has to agree with the first. `onBank` writes `en_cours` every ten seconds, so a reload
   costs ten seconds and not the visit.
*/

import { h, clear, focusMode, stamp, median } from '../../_lib/drills.js'
import { statementNode, inlineNode } from './math.js'
import { appendLog, setEnCours } from './store.js'

const LETTERS = ['A', 'B', 'C', 'D']

/** A single pause is capped here: an app left open overnight did not pause for eight hours. */
export const PAUSE_CAP_MS = 5 * 60 * 1000

/** Below this, a difference between wall time and work time is rounding, not a pause. */
const DROP_FLOOR = 2000

/**
 * A reveal cannot arrive sooner than this after the statement was drawn: nobody read it. The
 * autorepeat of a held Space used to land on the redraw that follows a confirm and reveal the
 * next question with no key pressed, writing `reflexion_ms: 4` into the log the generator reads
 * (Q1). `event.repeat` is refused as well; this floor is what catches the same thing arriving
 * some other way. A reveal refused here is simply not a reveal — press it again.
 */
const MIN_READ_MS = 250

/** Milliseconds off the shared clock. `elapsedMs` is S's additive getter (work/inbox/S/001). */
const msOf = (clock) => {
  const ms = clock.elapsedMs
  return Number.isFinite(ms) ? ms : clock.elapsedS * 1000
}

export class Session {
  /**
   * @param {object} opts
   *   serie      the parsed series
   *   bands      { statement, work, controls, hint } — the elements the page holds open
   *   clock      the shared lib's clock, already `setBanked` to what disk held
   *   onProgress (at, total) => void, for the `12 / 70` in the meta line
   *   onEnd      called with the summary when the last question is confirmed
   *   startAt / debut / tentative / prior: where a resume picks up
   */
  constructor(opts) {
    this.serie = opts.serie
    this.name = opts.serie.id || opts.serie.name
    this.bands = opts.bands
    this.clock = opts.clock
    this.onProgress = opts.onProgress || (() => {})
    this.onEnd = opts.onEnd || (() => {})
    this.warn = opts.warn || ((err) => console.error('[maths]', err))

    this.at = opts.startAt || 0
    this.debut = opts.debut || stamp()
    this.tentative = opts.tentative || 1
    this.prior = opts.prior || []
    this.answers = []

    this.phase = 'statement'
    this.choice = null
    this.confirmButton = null
    this.ended = false
    this.gone = false

    // The pause, measured as the difference between wall time and work time (see syncPause).
    this.pausedMs = (Number(opts.pauseMs) || 0)
    this.stretchMs = 0
    this.lastWall = Date.now()
    this.lastWork = msOf(this.clock)

    // Two marks: the question appearing, and the reveal. Each is a wall stamp and the pause
    // total at that instant, so the span between two marks is wall time minus the pause the
    // clock itself measured — see `span()`.
    this.shown = this.mark()
    this.revealed = this.shown
  }

  /* ------------------------------------------------------------------ run */

  begin() {
    if (this.gone) return
    focusMode(true)
    this.clock.start()
    this.lastWall = Date.now()
    this.lastWork = msOf(this.clock)
    this.showQuestion()
    // On disk before the first answer is, so a window closed on question one resumes there.
    void this.persist()
  }

  get question() { return this.serie.questions[this.at] }
  get total() { return this.serie.questions.length }

  showQuestion() {
    this.phase = 'statement'
    this.choice = null
    this.shown = this.mark()
    this.revealed = this.shown
    this.onProgress(Math.min(this.at + 1, this.total), this.total)
    this.draw()
  }

  reveal() {
    if (this.phase !== 'statement' || this.ended) return
    if (Date.now() - this.shown.wall < MIN_READ_MS) return   // see MIN_READ_MS
    this.revealed = this.mark()
    this.phase = 'options'
    this.draw()
  }

  select(letter) {
    if (this.phase !== 'options' || this.ended) return
    if (!LETTERS.includes(letter)) return
    this.choice = letter
    for (const row of this.bands.work.querySelectorAll('.drill-opt')) {
      row.classList.toggle('current', row.dataset.letter === letter)
      row.setAttribute('aria-pressed', String(row.dataset.letter === letter))
    }
    // The button is in the band either way and at the same place: choosing lights it, it does
    // not make it appear. Disabled is honest; enabled and silently dead is not (Q1).
    if (this.confirmButton) this.confirmButton.disabled = false
  }

  /**
   * The one irreversible step. With no choice there is nothing to confirm, and the button says
   * so: it is drawn disabled and `select()` lights it. It never moves and never leaves the band
   * — the band's shape is the contract, not the button's state.
   */
  async confirm() {
    if (this.phase !== 'options' || !this.choice || this.ended) return
    const q = this.question
    const entry = {
      t: stamp(),
      serie: this.name,
      n: q.n,
      famille: q.famille,
      reflexion_ms: this.span(this.shown, this.revealed),
      reponse_ms: this.span(this.revealed, this.mark()),
      choix: this.choice,
      attendu: q.reponse,
      juste: this.choice === q.reponse,
    }
    this.answers.push({ ...entry, statement: q.statement, regle: q.regle, options: q.options })
    this.at += 1
    const last = this.at >= this.total
    // Before any await: a second Enter on the last question used to pass the guard above while
    // `finish()` was still in flight and read `this.question` — undefined (ADV-M).
    if (last) this.ended = true
    else this.showQuestion()

    try { await appendLog(entry) } catch (err) { this.warn(err) }
    if (this.gone) return
    if (last) await this.finish()
    else await this.persist()
  }

  /**
   * A mark: the wall stamp, and the pause total at that instant. `syncPause()` first, so the
   * pause total is current before it is written down.
   */
  mark() {
    this.syncPause()
    return { wall: Date.now(), pause: this.pausedMs }
  }

  /**
   * The work between two marks, in milliseconds: wall time minus the pause the clock measured
   * over the same window. The pause is the one gap-safe source — the clock stops when the
   * window is hidden and drops a gap when the machine slept, and `syncPause` turns exactly that
   * into `pausedMs` — so a closed lid and an Escape are both excluded here and from `pause_s`
   * by the same subtraction. Nothing quantises: an ordinary question, with no pause in it, is
   * measured to the millisecond. This is the number `bilan.md` and the generator live on.
   */
  span(from, to) {
    return Math.max(0, Math.round((to.wall - from.wall) - (to.pause - from.pause)))
  }

  /* ---------------------------------------------------------------- pause */

  pause() {
    if (this.ended || this.phase === 'paused' || this.gone) return
    this.was = this.phase
    this.phase = 'paused'
    this.syncPause()
    this.clock.stop()
    this.draw()
    void this.persist()
    // The pause itself is banked while it lasts: closing the window while paused is exactly
    // when a person has walked away, and that used to write `pause_s: 0` for ever (ADV-M).
    clearInterval(this.pauseBank)
    this.pauseBank = setInterval(() => { this.syncPause(); void this.persist() }, 10000)
  }

  resumeRun() {
    if (this.phase !== 'paused' || this.gone) return
    clearInterval(this.pauseBank)
    this.pauseBank = null
    this.syncPause()
    this.clock.start()
    this.lastWall = Date.now()
    this.lastWork = msOf(this.clock)
    this.phase = this.was || 'statement'
    this.draw()
  }

  /**
   * Wall time that the clock did not count is pause: an Escape, a hidden window, a closed lid,
   * a page left open on another route. One source, one subtraction — there is no second clock
   * to disagree with the first. A single stretch counts at most `PAUSE_CAP_MS`, because a
   * paused session left overnight reported the night (ADV-T).
   */
  syncPause() {
    const wall = Date.now()
    const work = msOf(this.clock)
    const dWall = Math.max(0, wall - this.lastWall)
    const dWork = Math.max(0, work - this.lastWork)
    // A drop under `DROP_FLOOR` is not a pause, it is the clock's own resolution: `elapsedS`
    // advances a whole second at a time, so two marks 400 ms apart can show no work at all.
    // Nothing a person does is a two-second pause, and a real one is minutes.
    const dropped = dWall - dWork > DROP_FLOOR ? dWall - dWork : 0
    if (!dropped) this.stretchMs = 0                           // nothing lost: a new stretch
    const room = Math.max(0, PAUSE_CAP_MS - this.stretchMs)
    this.pausedMs += Math.min(dropped, room)
    this.stretchMs += dropped
    this.lastWall = wall
    this.lastWork = work
  }

  /** Leaving the page. The state on disk says where to come back, and `vu` says when. */
  async leave() {
    clearInterval(this.pauseBank)
    this.pauseBank = null
    if (this.ended) { focusMode(false); return }
    this.syncPause()
    this.clock.stop()
    focusMode(false)
    await this.persist()
  }

  /**
   * `en_cours`, and with it `vu`: the last moment this session was on the page. The Session
   * object dies when the page is left, so nothing in memory spans an absence — the run that
   * picks the series back up reads `vu` and counts the wall time since as pause (`awayMs` in
   * serie.js). Without it the time away was recorded nowhere at all, and a session line's
   * `fin − debut` could exceed `duree_s + pause_s` by any amount (Q1).
   *
   * It is written on every persist and not only on the way out, because the way out can be a
   * closed window or a reload, where an async write races the unload and loses. A stamp banked
   * every ten seconds is at most ten seconds stale — the same bar `ecoule_ms` already lives
   * with, and the two are stale together, so their sum stays true.
   */
  persist() {
    if (this.ended) return Promise.resolve()
    return setEnCours({
      serie: this.name,
      n: this.at + 1,
      debut: this.debut,
      ecoule_ms: Math.round(msOf(this.clock)),
      // Neither of the last two is in FORMAT-drills.md's sketch of `en_cours`, and both have to
      // be: without them a resumed run cannot write a true `pause_s` on its session line.
      pause_s: Math.round(this.pausedMs / 1000),
      vu: stamp(),
    }).catch(err => this.warn(err))
  }

  /* ------------------------------------------------------------------ end */

  async finish() {
    this.ended = true
    this.syncPause()
    this.clock.stop()
    focusMode(false)

    const summary = this.summarise()
    try {
      await appendLog({
        t: stamp(),
        serie: this.name,
        session: {
          debut: this.debut,
          fin: stamp(),
          duree_s: summary.duree_s,
          pause_s: summary.pause_s,
          justes: summary.justes,
          total: summary.total,
          tentative: this.tentative,
        },
      })
    } catch (err) { this.warn(err) }
    if (this.gone) return
    this.onEnd(summary)
  }

  /** Everything the summary, `state.json`, `bilan.md` and the result file are made of. */
  summarise() {
    const byNumber = new Map()
    for (const a of this.prior) byNumber.set(a.n, a)
    for (const a of this.answers) byNumber.set(a.n, a)
    const all = this.serie.questions.map(q => {
      const a = byNumber.get(q.n)
      return a ? { ...a, statement: q.statement, regle: q.regle, options: q.options, famille: q.famille } : null
    }).filter(Boolean)

    const familles = []
    for (const famille of [...new Set(all.map(a => a.famille))]) {
      const mine = all.filter(a => a.famille === famille)
      familles.push({
        famille,
        total: mine.length,
        justes: mine.filter(a => a.juste).length,
        mediane: median(mine.map(a => Number(a.reflexion_ms))),
      })
    }

    return {
      name: this.name,
      n: this.serie.n,
      date: this.serie.date,
      tentative: this.tentative,
      justes: all.filter(a => a.juste).length,
      total: this.total,
      duree_s: Math.round(msOf(this.clock) / 1000),
      pause_s: Math.round(this.pausedMs / 1000),
      familles,
      misses: all.filter(a => !a.juste).map(a => ({
        n: a.n, famille: a.famille, statement: a.statement,
        choix: a.choix, attendu: a.attendu, regle: a.regle || '',
        serieN: this.serie.n, options: a.options || [],
      })),
    }
  }

  /* -------------------------------------------------------------- drawing */

  draw() {
    const { statement, work, controls, hint } = this.bands
    clear(statement)
    clear(work)
    clear(controls)
    work.removeAttribute('role')
    work.removeAttribute('aria-label')

    if (this.phase === 'paused') {
      // The question goes away with the clock, so a pause is not thinking time. The bands keep
      // their reserved heights, so nothing under them moves.
      this.confirmButton = null
      statement.appendChild(h('div', { class: 'maths-paused-word mono' }, 'paused'))
      controls.appendChild(this.button('resume', () => this.resumeRun()))
      hint.textContent = 'esc or enter resumes · the clock is stopped'
      controls.appendChild(hint)
      this.keepFocus()
      return
    }

    const q = this.question
    statement.appendChild(statementNode(q.statement, 'maths-statement'))

    if (this.phase === 'options') {
      // The options are the work band's own rows: the band is already the column they need, so
      // there is no wrapper and no second list shape.
      work.setAttribute('role', 'group')
      work.setAttribute('aria-label', 'options')
      for (const option of q.options) {
        work.appendChild(h('button', {
          class: 'drill-opt' + (this.choice === option.letter ? ' current' : ''),
          type: 'button', tabindex: '-1',
          dataset: { letter: option.letter },
          'aria-label': `${option.letter}. ${option.text}`,
          'aria-pressed': String(this.choice === option.letter),
          onclick: () => this.select(option.letter),
        },
          h('span', { class: 'maths-opt-letter mono-sm' }, option.letter),
          inlineNode(option.text, 'maths-opt-text')))
      }
      this.confirmButton = this.button('confirm', () => void this.confirm())
      this.confirmButton.disabled = !this.choice
      controls.appendChild(this.confirmButton)
      hint.textContent = '1–4 or A–D chooses · enter confirms · esc pauses'
    } else {
      this.confirmButton = null
      controls.appendChild(this.button('reveal', () => this.reveal()))
      hint.textContent = 'space reveals · esc pauses'
    }
    controls.appendChild(hint)
    this.keepFocus()
  }

  button(label, onClick) {
    return h('button', { class: 'btn primary', type: 'button', tabindex: '-1', onclick: onClick }, label)
  }

  /**
   * The keys live on the session's root, so the focus must never leave it. A redraw throws away
   * whatever had it — an option the mouse clicked, the control it pressed — and the focus would
   * fall back to `body`, where nothing this plugin binds is listening.
   */
  keepFocus() {
    const root = this.bands.root
    if (!root.contains(document.activeElement)) root.focus()
  }

  /* ----------------------------------------------------------- the keys */

  onKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    // An autorepeat is the keyboard talking, not the person: a key held down through the redraw
    // that follows a confirm used to reveal the next question on its own (Q1). Nothing in this
    // session is a key you hold.
    if (event.repeat) return
    const key = event.key

    // Tab is trapped: the focus stays on the session root for as long as the session is on
    // screen. Nothing inside it is a tab stop, so there is one place for Tab to land.
    if (key === 'Tab') { event.preventDefault(); this.keepFocus(); return }

    if (this.phase === 'paused') {
      if (key === 'Escape' || key === 'Enter') { event.preventDefault(); this.resumeRun() }
      return
    }
    if (key === 'Escape') { event.preventDefault(); this.pause(); return }

    if (this.phase === 'statement') {
      if (key === ' ' || key === 'Spacebar') { event.preventDefault(); this.reveal() }
      return
    }

    const upper = key.length === 1 ? key.toUpperCase() : ''
    if (LETTERS.includes(upper)) { event.preventDefault(); this.select(upper); return }
    if (upper >= '1' && upper <= '4') { event.preventDefault(); this.select(LETTERS[Number(upper) - 1]); return }
    if (key === 'Enter') { event.preventDefault(); void this.confirm() }
  }
}

/**
 * What the log already holds for the attempt being resumed: the last line written for each
 * question before the one we are about to show. A redo writes new lines for the same numbers,
 * so the last line of each is the one that belongs to this attempt.
 */
export function priorAnswers(answers, name, upto) {
  const byNumber = new Map()
  for (const a of answers) {
    if (a.serie !== name) continue
    if (!(a.n < upto)) continue
    byNumber.set(a.n, a)
  }
  return [...byNumber.values()].sort((a, b) => a.n - b.n)
}
