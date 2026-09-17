/* One series, one owned route (`maths/serie-NN`), and the page IS the session.
 *
 * There is no door, no resume button and no summary page: opening a series shows the first
 * question the log has no line for, immediately. The shell folds away, the question is large
 * and centred in the column, and the only other thing on screen is the corner readout: which
 * question this is, and how long it has been on screen.
 *
 * One question is three states. `statement`: the question alone, the one button says
 * `open options`. `options`: the four options under it, and a key or a click picks and locks
 * at once — there is no confirm step, because confirming was a second press that measured
 * nothing and once wrote a 16 ms thinking time into the log. `locked`: the pick and the
 * expected answer are marked, and `next` goes on; a correct answer goes on by itself after a
 * short beat, because there is nothing on screen to read.
 *
 * Time is passive. Two marks, `Date.now()` apart: the question appearing and the options
 * opening give `reflexion_ms`, the options opening and the pick give `reponse_ms`. Nothing
 * accumulates across questions, nothing banks, nothing pauses. Leaving before the pick simply
 * means that question is timed again from the top when it comes back — the log holds no line
 * for it, so there is nothing to disagree with.
 */

import { toast } from 'ose:ui'
import { h, clear, clockText, stamp, errorBlock, focusMode } from '../../_lib/drills.js'
import { ctx, requireRoot, serieFile, seriePath } from './ctx.js'
import { readSerie, readLog, appendLog, progressOf } from './store.js'
import { statementNode, inlineNode } from './math.js'

const LETTERS = ['A', 'B', 'C', 'D']

/** A step cannot follow the one before it sooner than this. A held Enter autorepeats its own
    clicks and a double tap on `next` would skip a question nobody saw; before the options are
    open it is the same floor the reveal always had — nobody read the statement in 250 ms. */
const MIN_STEP_MS = 250

/** A correct answer goes on by itself after this. A wrong one waits for a key: the expected
    option is on screen and looking at it is the whole point of the exercise. */
const NEXT_MS = 700

export function openSerie(id) {
  return ctx.ose.route.navigate({ type: 'own', path: 'maths/' + id })
}

export function mountSerie(el, route) {
  const id = String(route.path || '').replace(/^maths\//, '')
  const run = new Run(el, id)
  void run.load()
  return { title: id, unmount: () => run.unmount() }
}

class Run {
  constructor(el, id) {
    this.el = el
    this.id = id
    this.gone = false
    this.serie = null
    this.at = 0                 // the question being answered, 0-based
    this.phase = 'none'
    this.choice = null
    this.shownAt = 0
    this.revealedAt = 0
    this.stepAt = 0
    this.timer = null           // the beat after a correct answer
    this.ticker = null          // the corner's second hand
    this.writing = Promise.resolve()
  }

  unmount() {
    this.gone = true
    this.stopTick()
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    focusMode(false)            // every exit path, whether a question was on screen or not
    this.el.classList.remove('maths-host')
    clear(this.el)
  }

  get question() { return this.serie.questions[this.at] }
  get total() { return this.serie.questions.length }

  /* ------------------------------------------------------------- reading */

  async load() {
    // A retry comes back through here, so the run's own shape is given up first.
    this.stopTick()
    focusMode(false)
    this.el.classList.remove('maths-host')
    clear(this.el)
    const page = h('div', { class: 'page-col' })
    const boxHost = h('div')
    page.appendChild(boxHost)
    this.el.appendChild(page)

    // The folder first, into an element with nothing in it: `null` is the kernel's box, and the
    // page stops there. Nothing else can be drawn without it.
    const root = await requireRoot(boxHost)
    if (this.gone || !root) return

    let serie = null
    let answers = []
    try {
      serie = await readSerie(this.id)
      if (this.gone) return
      answers = (await readLog()).answers
    } catch (err) {
      if (this.gone) return
      clear(page).appendChild(errorBlock({
        head: 'the series could not be read',
        detail: String((err && err.message) || err),
        onRetry: () => void this.load(),
      }))
      return
    }
    if (this.gone) return
    this.serie = serie
    // The tab strip and the title bar, which are the shell's and not this page's.
    ctx.ose.route.title(serie.titre || this.id)
    if (!serie.ok) { this.drawErrors(page); return }

    const { correct, resumeAt } = progressOf(answers, this.id, this.total)
    this.build()
    if (resumeAt == null) this.end(correct)
    else { this.at = resumeAt - 1; this.show() }
  }

  /** A file that does not parse: every error with its line, and the way to open the file. */
  drawErrors(page) {
    const box = errorBlock({
      head: 'this series does not parse',
      detail: `${serieFile(this.id)} does not follow the grammar, so it cannot be run. Nothing has been changed in the file.`,
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
      onclick: () => ctx.ose.route.navigate({ type: 'page', path: seriePath(this.id) }),
    }, `open ${serieFile(this.id)}`), box.querySelector('.btn'))
    clear(page).appendChild(box)
  }

  /* -------------------------------------------------------------- the run */

  /** The skeleton, built once. The stage is three grid rows, so the question sits on the exact
      middle of the column and the options grow into the air under it without moving it. */
  build() {
    clear(this.el)
    this.el.classList.add('maths-host')
    this.posEl = h('span', { class: 'maths-pos' })
    this.timeEl = h('span', { class: 'maths-time' })
    this.readout = h('div', { class: 'maths-readout mono-sm' }, this.posEl, this.timeEl)
    this.questionEl = h('div', { class: 'maths-question' })
    this.optionsEl = h('div', { class: 'maths-options' })
    this.act = h('button', {
      class: 'btn primary maths-act', type: 'button', onclick: () => this.step(),
    })
    this.below = h('div', { class: 'maths-below' },
      this.optionsEl, h('div', { class: 'maths-act-row' }, this.act))
    this.root = h('div', { class: 'maths-run', tabindex: '-1' },
      this.readout, h('div', { class: 'maths-stage' }, this.questionEl, this.below))
    this.root.addEventListener('keydown', (event) => this.onKey(event))
    this.el.appendChild(this.root)
    focusMode(true)
  }

  show() {
    this.phase = 'statement'
    this.choice = null
    this.shownAt = Date.now()
    this.revealedAt = 0
    this.stepAt = this.shownAt
    clear(this.questionEl).appendChild(statementNode(this.question.statement, 'maths-statement'))
    clear(this.optionsEl)
    this.act.hidden = false
    this.act.textContent = 'open options'
    this.posEl.textContent = `${this.at + 1} / ${this.total}`
    this.paintTime()
    this.startTick()
    this.act.focus({ preventScroll: true })
  }

  reveal() {
    if (this.phase !== 'statement') return
    this.phase = 'options'
    this.revealedAt = Date.now()
    this.stepAt = this.revealedAt
    clear(this.optionsEl)
    for (const option of this.question.options) {
      this.optionsEl.appendChild(h('button', {
        class: 'maths-opt', type: 'button', tabindex: '-1',
        dataset: { letter: option.letter },
        'aria-label': `${option.letter}. ${option.text}`,
        onclick: () => this.pick(option.letter),
      },
        h('span', { class: 'maths-opt-letter mono-sm' }, option.letter),
        inlineNode(option.text, 'maths-opt-text')))
    }
    // The button has nothing left to do until there is a pick, and a hidden button cannot hold
    // the focus: the keys live on the root, so that is where the focus goes.
    this.act.hidden = true
    this.root.focus({ preventScroll: true })
  }

  /**
   * The pick, and the lock: one press, one line in the log. The line is written before anything
   * else happens, and its two durations are the only times this plugin measures.
   */
  pick(letter) {
    if (this.phase !== 'options' || !LETTERS.includes(letter)) return
    const q = this.question
    const now = Date.now()
    this.phase = 'locked'
    this.choice = letter
    this.stepAt = now
    this.stopTick()

    const entry = {
      t: stamp(),
      serie: this.id,
      n: q.n,
      famille: q.famille,
      reflexion_ms: Math.max(0, this.revealedAt - this.shownAt),
      reponse_ms: Math.max(0, now - this.revealedAt),
      choix: letter,
      attendu: q.reponse,
      juste: letter === q.reponse,
    }
    this.writing = appendLog(entry).catch(err => {
      console.error('[maths]', err)
      toast('Maths: ' + ((err && err.message) || err), 'err')
    })

    for (const row of this.optionsEl.querySelectorAll('.maths-opt')) {
      const letterOf = row.dataset.letter
      row.disabled = true
      if (letterOf === q.reponse) row.classList.add('ok')
      else if (letterOf === letter) row.classList.add('err')
    }
    this.act.hidden = false
    this.act.textContent = this.at + 1 >= this.total ? 'finish' : 'next'
    this.act.focus({ preventScroll: true })
    if (entry.juste) this.timer = setTimeout(() => { this.timer = null; this.step() }, NEXT_MS)
  }

  /** The one button, and the keys that stand in for it. What it does is the phase. */
  step() {
    if (Date.now() - this.stepAt < MIN_STEP_MS) return
    if (this.phase === 'statement') { this.reveal(); return }
    if (this.phase === 'done') { this.leave(); return }
    if (this.phase !== 'locked') return
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.at += 1
    if (this.at >= this.total) void this.finish()
    else this.show()
  }

  /** The last question is answered. The score comes back out of the log, like every other
      number in this plugin, so what the page says is what was written. */
  async finish() {
    this.phase = 'ending'
    this.stopTick()
    try {
      await this.writing
      const { answers } = await readLog()
      if (this.gone) return
      this.end(progressOf(answers, this.id, this.total).correct)
    } catch (err) {
      if (this.gone) return
      clear(this.questionEl).appendChild(errorBlock({
        head: 'the log could not be read back',
        detail: String((err && err.message) || err),
        onRetry: () => void this.finish(),
      }))
    }
  }

  /** One quiet line: the score, and the way back. */
  end(correct) {
    this.phase = 'done'
    this.posEl.textContent = ''
    this.timeEl.textContent = ''
    clear(this.optionsEl)
    clear(this.questionEl).appendChild(
      h('div', { class: 'maths-end mono' }, `${correct} / ${this.total}`))
    this.act.hidden = false
    this.act.textContent = 'back to the list'
    // The same floor as any other step: the Enter that answered the last question must not carry
    // straight through this line and take the score off the screen before it is read.
    this.stepAt = Date.now()
    this.act.focus({ preventScroll: true })
  }

  leave() { ctx.ose.route.navigate({ type: 'view', name: 'maths' }) }

  /* --------------------------------------------------------- the readout */

  startTick() {
    this.stopTick()
    this.ticker = setInterval(() => this.paintTime(), 1000)
  }

  stopTick() {
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null }
  }

  paintTime() {
    if (!this.shownAt) return
    this.timeEl.textContent = clockText((Date.now() - this.shownAt) / 1000)
  }

  /* ------------------------------------------------------------- the keys */

  onKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    // An autorepeat is the keyboard talking, not the person: a key held through a redraw used
    // to answer the next question on its own. Nothing here is a key you hold.
    if (event.repeat) return
    const key = event.key

    if (key === 'Escape') { event.preventDefault(); this.leave(); return }
    // Tab is trapped: nothing inside the run is a tab stop, so there is one place for the focus
    // to be, and it is where the phase put it.
    if (key === 'Tab') { event.preventDefault(); this.keepFocus(); return }

    if (this.phase === 'options') {
      const upper = key.length === 1 ? key.toUpperCase() : ''
      if (LETTERS.includes(upper)) { event.preventDefault(); this.pick(upper); return }
      if (upper >= '1' && upper <= '4') { event.preventDefault(); this.pick(LETTERS[Number(upper) - 1]); return }
      return
    }

    // The button answers its own Space and Enter; this is the same key arriving from anywhere
    // else in the run, so one press is never counted twice.
    if ((key === ' ' || key === 'Spacebar' || key === 'Enter') && event.target !== this.act) {
      event.preventDefault()
      this.step()
    }
  }

  keepFocus() {
    const where = this.act.hidden ? this.root : this.act
    if (document.activeElement !== where) where.focus({ preventScroll: true })
  }
}
