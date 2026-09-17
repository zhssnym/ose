/* One drill, one column: the statement, then `solution.py` in the editor, then the verdict.
   Every drill is code, so there is one answer widget and no kind to branch on. A mono clock
   sits at the right of the title line and counts this visit. The route `nsi/<folder>` mounts
   this.

   Nothing on the page is chrome: no file path, no breadcrumb, no second band. The editor takes
   the height that is left. */

import { codeEditor, render } from 'ose:editor'
import {
  h, clear, duration, plural, createClock, mountClock,
  titleLine, metaLine, paneLabel, controls, verdict, errorBlock,
} from '../../_lib/drills.js'

import { ctx, python, dataRoot, vaultPath } from './ctx.js'
import { cli, JudgeError } from './cli.js'
import { cachedRow, stateOf } from './data.js'
import { readClock, writeClock } from './clocks.js'
import { refreshIndex } from './index-view.js'

/** The drill page that has the focus, for the commands. */
export let active = null

const VERDICT = { pass: 'passed', partial: 'partial', fail: 'failed' }
const SAVED_FOR = 2000

export function mountDrill(el, route) {
  const id = String(route.path || '').replace(/^nsi\//, '')
  const page = new DrillPage(el, id)
  page.load()
  return {
    // The title comes from the last listing, so the window and the tab read the drill's name
    // from the first frame — and still do when the judge will not run (ADV-N).
    title: page.cachedTitle,
    unmount: () => page.unmount(),
  }
}

class DrillPage {
  constructor(el, id) {
    this.el = el
    this.id = id
    this.gone = false
    this.detail = null
    this.editor = null
    this.correctionEditor = null
    this.runId = null
    this.busy = false
    this.savedTimer = null
    this.showingCorrection = false
    // The judge asked how it went and the band is the three answers until it is told.
    this.awaitingGrade = false
    const row = cachedRow(id)
    this.cachedTitle = (row && row.title) || id
    // What the log says, until `load` reads it for itself.
    this.done = !!(row && row.done)
    this.best = row ? row.best : null
    // The column is put into `el` by `load`, once the drills folder has answered: until then
    // `el` is the kernel's to draw the missing box into.
    this.root = h('div', { class: 'page-col nsi-drill' })
    clear(el)

    // One clock, one owner. It is created here and stopped here and nowhere else (ADV-T).
    this.clock = createClock({
      onTick: () => this.paintClock(),
      onBank: (s) => this.bank(s),
    })
    this.unbindClock = null
    // The kernel calls `unmount` on the window's closing notice; until every host does, the
    // page banks what it has on `pagehide` too. It costs one listener.
    this.onPageHide = () => { try { this.clock.stop() } catch { /* going anyway */ } }
    window.addEventListener('pagehide', this.onPageHide)

    active = this
  }

  /**
   * Leaving the page. The editor's save goes first: `pauseClock` used to, and when the clock's
   * write threw on an `ose` that was already gone it took the save with it and the user's
   * `solution.py` was lost silently (ADV-T).
   */
  async unmount() {
    this.gone = true
    if (active === this) active = null
    window.removeEventListener('pagehide', this.onPageHide)
    if (this.savedTimer) { clearTimeout(this.savedTimer); this.savedTimer = null }

    const ed = this.editor
    this.editor = null
    if (ed) {
      try {
        // Only when there is something to write: merely opening a drill and leaving used to
        // rewrite `solution.py` (ADV-U).
        if (ed.dirty) await ed.save({ explicit: true })
      } catch (err) {
        console.error('[nsi] save on leave', err)
      }
      try { await ed.close({ force: true }) } catch { /* already gone */ }
    }
    this.closeCorrectionEditor()
    this.stopRun()
    // `dispose` stops the clock, and stopping banks through `onBank`, which sets
    // `pendingBank` to the write it started. Awaiting that is what makes the last ten
    // seconds of a visit survive the page (the router awaits `unmount`).
    this.clock.dispose()
    try { await this.pendingBank } catch (err) { console.error('[nsi] clocks.json', err) }
    if (this.unbindClock) { this.unbindClock(); this.unbindClock = null }
    try { ctx.ose.status.clear('nsi') } catch { /* `ose` may be gone */ }
    clear(this.el)
  }

  /* ---------------------------------------------------------------------- clock */

  /** Has the judge anything to say about this drill? No: then there is no clock at all. */
  get judgeable() {
    const d = this.detail
    return !!d && d.judged !== false
  }

  /**
   * The clock node. A done drill shows the best time it has been done in, static, and its
   * clock still runs from zero underneath: a second go is timed on its own, and the pass it
   * earns logs that go's duration, not the first solve's over again (ADV-N).
   */
  paintClock() {
    if (!this.clockEl) return
    if (!this.judgeable) { this.clockEl.textContent = ''; return }
    if (this.showBest && this.best) {
      this.clockEl.textContent = 'best ' + duration(this.best)
      return
    }
    // mountClock paints the running number; this only owns the two other states. A done drill
    // with no time in the log has neither: the node stays empty and `.drill-clock:empty` takes
    // it off the line.
  }

  /**
   * The clock starts when the page draws, not when the user types: reading the statement is
   * work, and the time it takes is part of how long the drill took. That is deliberate and it
   * stays (Q1 asked, D2 answers). Maths starts on `start` because a series has a door to press;
   * a drill has none — the page opening _is_ the start.
   */
  startClock() {
    if (!this.judgeable) return
    this.showBest = this.done
    // A drill you have not done carries its earlier visits; a second go starts at zero.
    this.clock.setBanked(this.done ? 0 : this.bankedAtOpen)
    if (!this.showBest) this.unbindClock = mountClock(this.clock, this.clockEl)
    this.clock.start()
    this.paintClock()
  }

  /** The running number takes the node over: a second go that failed, a drill being worked on. */
  showRunningClock() {
    if (this.showBest) {
      this.showBest = false
      if (!this.unbindClock) this.unbindClock = mountClock(this.clock, this.clockEl)
    }
    this.paintClock()
  }

  bank(seconds) {
    // A drill that is done has its time in the log: `clocks.json` carries only what is still
    // running up.
    this.pendingBank = writeClock(this.id, this.done ? null : seconds)
      .catch(err => console.error('[nsi] clocks.json', err))
    return this.pendingBank
  }

  /* ----------------------------------------------------------------------- load */

  async load() {
    const folder = await dataRoot(this.el)
    if (this.gone) return
    // No drills folder: the kernel's box is in `el`, and a choice remounts this route.
    if (!folder) return
    clear(this.el).appendChild(this.root)
    clear(this.root).appendChild(h('p', { class: 'empty', text: 'loading…' }))
    try {
      // The judge for what the folder holds, the log for where the user stands with it.
      const [body, state] = await Promise.all([cli.detail(this.id), stateOf(this.id)])
      if (this.gone) return
      this.detail = body
      this.done = state.done
      this.best = state.best
      this.bankedAtOpen = await readClock(this.id)
      if (this.gone) return
      this.draw()
    } catch (err) {
      if (this.gone) return
      ctx.ose.route.title(this.cachedTitle)
      clear(this.root).appendChild(judgeError(err, () => this.load()))
    }
  }

  draw() {
    const d = this.detail
    const root = clear(this.root)
    // `route.title` and not `window.title`: the router owns the window title and adds
    // ` · <vault>` the way it does for a page.
    ctx.ose.route.title(d.title)

    const head = titleLine(d.title)
    this.clockEl = head.clockEl
    root.appendChild(head.el)
    root.appendChild(this.meta())

    root.appendChild(paneLabel('statement'))
    root.appendChild(this.statement())

    root.appendChild(paneLabel(fileName(d.answer_path) || 'solution.py'))
    this.answerHost = h('div', { class: 'nsi-answer-host' })
    root.appendChild(this.answerHost)

    root.appendChild(this.actions())
    // The verdict, the tests table and the run output are one place, directly under the
    // controls, so nothing the user presses moves what they are about to read.
    this.result = h('div', { class: 'nsi-result' })
    root.appendChild(this.result)

    this.correctionBox = h('div', { class: 'nsi-correction' })
    if (this.hasCorrection) root.appendChild(this.correctionBox)

    this.mountAnswer()
    this.startClock()
  }

  /**
   * The line under the title: the drill's tags, then the one fact. Plain words, no chips: the
   * index carries the category in its own column now, and a colour per tag was a second
   * vocabulary to learn for a page that shows one drill.
   */
  meta() {
    const tags = Array.isArray(this.detail.tags) ? this.detail.tags : []
    return metaLine(null, [...tags, this.fact()])
  }

  /** The one fact beside the tags: what the drill can be judged with. */
  fact() {
    const d = this.detail
    if (d.has_tests) {
      return Number.isFinite(d.tests_count) ? plural(d.tests_count, 'test') : 'tests'
    }
    // What the submit will do, not what file it reads: the judge hands the correction back and
    // the user says how they did. `correction` named a file where `7 tests` names a fact (Q2).
    if (d.has_correction) return 'self-graded'
    return 'nothing to judge'
  }

  statement() {
    const d = this.detail
    const text = statementBody(d)
    if (!text.trim()) {
      return h('p', { class: 'mono-sm nsi-hint' },
        'the statement is empty: write it in enonce.md.')
    }
    const box = h('div', { class: 'nsi-statement' })
    try {
      // Every drill here is Python, so a fenced block that names no language is Python and is
      // coloured as such.
      box.appendChild(render(text, {
        basePath: vaultPath(d.folder), codeLanguage: 'python',
      }))
    } catch {
      box.appendChild(h('pre', { class: 'nsi-pre' }, text))
    }
    return box
  }

  /** Is there a correction to show? */
  get hasCorrection() {
    return this.judgeable && this.detail.has_correction !== false
  }

  /**
   * One band, and the page's whole vocabulary of action in it: `submit · run · show the
   * correction`, primary first, the chord printed beside the two that have one. `run` becomes
   * `stop` in place while a run is going — the head of the run panel used to grow a second,
   * smaller `stop` button, which made two button sizes on one page and a third way to end one
   * run (Q2). The band is rebuilt, never moved: the buttons keep their place under the hand.
   */
  actions() {
    const buttons = []
    if (this.awaitingGrade) {
      const bar = controls(['pass', 'partial', 'fail'].map(v => ({
        label: VERDICT[v], primary: v === 'pass', onClick: () => this.selfgrade(v),
      })), 'against the correction below')
      this.submitButton = null
      this.runButton = null
      this.bandEl = bar
      return bar
    }
    if (this.judgeable) {
      buttons.push({
        label: 'submit', primary: true, disabled: this.busy,
        onClick: () => this.submit(), chord: shortcut('nsi.submit'),
      })
    }
    buttons.push({
      label: this.runId ? 'stop' : 'run',
      onClick: () => this.run(), chord: shortcut('nsi.run'),
    })
    if (this.hasCorrection) {
      buttons.push({
        label: this.showingCorrection ? 'hide the correction' : 'show the correction',
        onClick: () => this.toggleCorrection(),
      })
    }
    // The honest rule, in three words: looking at the answer of a drill you have never passed
    // is a failure, and the log says so.
    const hint = this.hasCorrection && !this.showingCorrection && !this.done
      ? 'counts as a failure' : ''
    const bar = controls(buttons, hint)
    let at = 0
    this.submitButton = this.judgeable ? bar.buttons[at++] : null
    this.runButton = bar.buttons[at]
    this.bandEl = bar
    return bar
  }

  /** The band says what the page is doing, so anything that changes that redraws it. */
  paintActions() {
    const old = this.bandEl
    if (!old || !old.parentNode) return
    old.replaceWith(this.actions())
  }

  /* ------------------------------------------------------------------------ run */

  /**
   * Save, then `python solution.py` in the drill's own folder, the output streamed under the
   * controls as it comes, stderr in the error ink, and a `stop` while it runs. Nothing is
   * judged and nothing is logged: a run is not an attempt.
   */
  async run() {
    if (this.runId) { this.stopRun(); return }
    if (this.awaitingGrade) return
    const d = this.detail
    const panel = clear(this.result)
    this.closeCorrection()
    const status = h('span', { class: 'mono-sm nsi-hint' }, 'saving…')
    // The head says what is running and how it ended. The one way to stop it is the band's own
    // button, which carries the chord (Q2: there were three).
    panel.appendChild(h('div', { class: 'nsi-run-head' },
      h('span', { class: 'mono-sm nsi-run-label' }, 'python solution.py'), status))
    const out = h('pre', { class: 'nsi-pre nsi-run-out' })
    panel.appendChild(out)
    this.runId = 'nsi.run.' + Date.now()
    this.runButton.textContent = 'stop'
    try {
      if (this.editor) {
        const ok = await this.editor.save({ explicit: true })
        if (!ok) throw new Error('the file is not saved; fix that first')
      }
      if (this.gone) return
      status.textContent = 'running…'
      const result = await ctx.ose.run(await python(), ['solution.py'], {
        id: this.runId,
        cwd: vaultPath(d.folder),
        onLine: (line, stream) => {
          out.appendChild(h('span', { class: stream === 'stderr' ? 'err' : '' },
            line + String.fromCharCode(10)))
        },
      })
      if (this.gone) return
      // No exit code and no elapsed: the output is what the user pressed run for (ADV-N).
      status.textContent = result.timedOut ? 'stopped: it took too long'
        : result.code === null ? 'stopped' : ''
      if (!out.childNodes.length) out.appendChild(h('span', { class: 'nsi-hint' }, '(no output)'))
    } catch (err) {
      if (this.gone) return
      status.textContent = 'could not run'
      out.appendChild(h('span', { class: 'err' }, String((err && err.message) || err)))
    } finally {
      this.runId = null
      if (this.runButton) this.runButton.textContent = 'run'
    }
  }

  stopRun() {
    if (!this.runId) return
    try { ctx.ose.run.kill(this.runId).catch(() => {}) } catch { /* already gone */ }
  }

  /* -------------------------------------------------------------------- answers */

  mountAnswer() {
    const d = this.detail
    this.editor = codeEditor(this.answerHost, {
      path: vaultPath(d.answer_path),
      language: 'python',
      // The editor is as tall as the file and never scrolls inside itself; the column scrolls.
      // Its floor is in style.css: the height the window has left.
      grow: true,
      onSave: () => this.saidSaved(),
    })
    // The file may not exist yet: seed it with the signature stub the judge would have used,
    // so the first keystroke lands on real code.
    if (!d.answer_exists && d.answer) {
      const ready = this.editor.ready || Promise.resolve()
      ready.then(() => {
        if (this.gone) return
        if (this.editor && !this.editor.getText().trim()) this.editor.setText(d.answer)
      }).catch(() => {})
    }
  }

  /** `solution saved`, and then the bar is the bar again (ADV-N: it stayed for ever). */
  saidSaved() {
    ctx.ose.status.set('nsi', 'solution saved')
    if (this.savedTimer) clearTimeout(this.savedTimer)
    this.savedTimer = setTimeout(() => {
      this.savedTimer = null
      try { ctx.ose.status.clear('nsi') } catch { /* gone */ }
    }, SAVED_FOR)
  }

  /* ---------------------------------------------------------------------- verbs */

  async submit() {
    if (this.busy || !this.judgeable || this.awaitingGrade) return
    this.busy = true
    if (this.submitButton) this.submitButton.disabled = true
    this.closeCorrection()
    const panel = clear(this.result)
    const line = h('p', { class: 'mono-sm nsi-hint' }, 'saving…')
    panel.appendChild(line)
    try {
      if (this.editor) await this.editor.save({ explicit: true })
      if (this.gone) return
      line.textContent = 'judging…'
      ctx.ose.status.set('nsi', 'judging ' + this.id)
      const body = await cli.submit(this.id, {
        duration: this.clock.elapsedS,
        onStatus: text => { if (!this.gone) line.textContent = text },
      })
      if (this.gone) return
      this.applyState(body)
      this.showResult(body)
      // The editor keeps its floor, so the verdict can land below the fold on a one-line
      // answer. Submit brings it to the eye rather than leaving it there (ADV-N).
      this.result.scrollIntoView({ block: 'center' })
    } catch (err) {
      if (this.gone) return
      const panel = clear(this.result)
      // A refusal the user can fix is a sentence, not the judge's error panel with its Python
      // advice.
      if (err instanceof JudgeError
          && (err.kind === 'bad_request' || err.kind === 'not_judgeable')) {
        panel.appendChild(h('p', { class: 'nsi-warn' }, err.message))
      } else {
        panel.appendChild(judgeError(err, () => this.submit()))
      }
    } finally {
      this.busy = false
      if (this.submitButton) this.submitButton.disabled = false
      if (!this.gone) ctx.ose.status.clear('nsi')
    }
  }

  /**
   * Take the line the judge wrote into the page, the clock included. The log line is the whole
   * state: a pass in it is what "done" means, here and on the index.
   */
  applyState(body) {
    const logged = body && body.logged
    const verdict = logged && logged.verdict
    if (!verdict) return          // a reveal on a drill that has already passed writes nothing
    if (verdict === 'pass') {
      this.done = true
      // A pass ends the visit: the clock stops where it is, and the node becomes the record.
      this.clock.stop()
      const seconds = Number(logged.duration_s)
      if (Number.isFinite(seconds) && seconds > 0) {
        this.best = this.best ? Math.min(this.best, seconds) : seconds
      }
      this.showBest = true
      if (this.unbindClock) { this.unbindClock(); this.unbindClock = null }
      this.paintClock()
    } else {
      // Failed, or partial: the work is not over, so neither is the clock (ADV-N).
      this.showRunningClock()
      if (!this.clock.running) this.clock.start()
    }
    // Passing the drill retires the hint under the band, so the band is redrawn with it.
    this.paintActions()
    refreshIndex()
  }

  showResult(body) {
    const panel = clear(this.result)
    // No cases: the judge hands back the correction and waits for the honest answer. The
    // question takes the one band over rather than raising a band of its own under it — the
    // page has one row of buttons in every state it is ever in (Q2).
    if (body.awaiting_selfgrade) {
      this.awaitingGrade = true
      this.paintActions()
      this.openCorrection(body.correction, body.correction_format, { scroll: false })
      return
    }

    panel.appendChild(this.verdictLine(body))
    const violations = body.constraint_violations || []
    if (body.error && !violations.some(v => v.message === body.error)) {
      panel.appendChild(h('p', { class: 'nsi-warn' }, body.error))
    }
    if (violations.length) {
      panel.appendChild(h('ul', { class: 'nsi-violations' },
        violations.map(v => h('li', {}, v.message + (v.line ? ` (line ${v.line})` : '')))))
    }
    // The table is for what went wrong: a green row per passing test is a wall of ticks.
    const failed = (body.tests || []).filter(t => !t.ok)
    if (failed.length) panel.appendChild(testsTable(body.tests))
  }

  /** `passed · 7/7 · 1 min 34`, `partial · 4/7`, `failed · 3/7`. One line, three states. */
  verdictLine(body) {
    const word = VERDICT[body.verdict] || body.verdict || '—'
    const state = body.verdict === 'pass' ? 'ok' : body.verdict === 'partial' ? 'warn' : 'err'
    const figure = []
    if (body.total) figure.push(`${body.passed}/${body.total}`)
    const seconds = body.logged && Number(body.logged.duration_s)
    if (Number.isFinite(seconds) && seconds > 0) figure.push(duration(seconds))
    return verdict({ state, word, figure: figure.join(' · ') })
  }

  async selfgrade(grade) {
    try {
      const body = await cli.selfgrade(this.id, grade, this.clock.elapsedS)
      if (this.gone) return
      this.awaitingGrade = false
      this.applyState(body)
      clear(this.result).appendChild(this.verdictLine(body))
    } catch (err) {
      if (this.gone) return
      clear(this.result).appendChild(judgeError(err, () => this.selfgrade(grade)))
    }
  }

  /* ----------------------------------------------------------------- correction */

  /**
   * `show the correction` / `hide the correction`. The third button of the one band, and a
   * toggle rather than a question: the confirm it used to raise asked something it already knew
   * the answer to, stayed on screen after the user left the plugin, and revealed 1,400 px below
   * the fold without scrolling to any of it (ADV-V). It had a band of its own until Q2 counted
   * two on the page.
   */
  async toggleCorrection() {
    if (this.showingCorrection) { this.closeCorrection(); return }
    try {
      const body = await cli.reveal(this.id, this.clock.elapsedS)
      if (this.gone) return
      this.applyState(body)
      this.openCorrection(body.correction, body.correction_format)
    } catch (err) {
      if (this.gone) return
      clear(this.correctionBox).appendChild(judgeError(err, () => this.toggleCorrection()))
    }
  }

  /**
   * The correction with its syntax colours. A Python correction goes into a read-only code
   * editor — the same highlighter, the same `--code-*` tokens as the editor two inches above
   * it — and a markdown one through the kernel's renderer, which colours its fenced blocks.
   */
  openCorrection(text, format, { scroll = true } = {}) {
    this.showingCorrection = true
    this.paintActions()
    this.closeCorrectionEditor()
    const box = clear(this.correctionBox)
    box.appendChild(paneLabel('correction'))
    const kind = format || (String(this.detail.correction_path || '').endsWith('.py') ? 'py' : 'md')
    if (kind === 'py') {
      const host = h('div', { class: 'nsi-correction-host' })
      box.appendChild(host)
      this.correctionEditor = codeEditor(host, {
        text: String(text || ''), language: 'python',
        readOnly: true, grow: true, gutter: false,
      })
    } else {
      try {
        box.appendChild(h('div', { class: 'nsi-statement' },
          render(String(text || ''), {
            basePath: vaultPath(this.detail.folder), codeLanguage: 'python',
          })))
      } catch {
        box.appendChild(h('pre', { class: 'nsi-pre' }, String(text || '')))
      }
    }
    if (scroll) box.scrollIntoView({ block: 'start' })
  }

  closeCorrection() {
    if (!this.showingCorrection) return
    this.showingCorrection = false
    this.closeCorrectionEditor()
    if (this.correctionBox) clear(this.correctionBox)
    this.paintActions()
  }

  closeCorrectionEditor() {
    const ed = this.correctionEditor
    this.correctionEditor = null
    if (ed) { try { ed.close({ force: true }) } catch { /* already gone */ } }
  }
}

/* --------------------------------------------------------------------- pieces */

/** The judge will not run: one box, the words of whatever threw, and a way to try again. */
function judgeError(err, retry) {
  return errorBlock({
    head: 'the judge could not run',
    detail: [err && err.message, err && err.detail].filter(Boolean).join('\n'),
    onRetry: retry,
  })
}

function fileName(path) {
  return String(path || '').split('/').pop()
}

/**
 * The statement without the one thing the page already says: the H1, which is the title by the
 * format's own rule.
 */
function statementBody(detail) {
  const lines = String(detail.enonce || '').split('\n')
  let at = 0
  while (at < lines.length && !lines[at].trim()) at++
  if (at < lines.length && /^#\s+/.test(lines[at])) {
    lines.splice(0, at + 1)
    while (lines.length && !lines[0].trim()) lines.shift()
  }
  return lines.join('\n')
}

function testsTable(tests) {
  const table = h('table', { class: 'table nsi-tests' },
    h('thead', {}, h('tr', {},
      h('th', {}, ''), h('th', {}, 'test'), h('th', {}, 'expected'), h('th', {}, 'got'))))
  const body = h('tbody', {})
  tests.forEach(test => {
    const ok = !!test.ok
    body.appendChild(h('tr', { class: ok ? 'ok' : 'bad' },
      h('td', { class: 'nsi-mark' }, ok ? '✓' : '✗'),
      h('td', {}, h('div', {}, test.name),
        test.call ? h('code', { class: 'nsi-call' }, test.call) : null),
      h('td', {}, h('code', {}, test.expected_repr || '')),
      h('td', {}, test.error
        ? h('pre', { class: 'nsi-pre nsi-trace' }, test.error)
        : h('code', {}, test.got_repr || ''))))
  })
  table.appendChild(body)
  return h('div', { class: 'nsi-scroll' }, table)
}

function shortcut(command) {
  const keys = ctx.ose.keys.shortcutFor ? ctx.ose.keys.shortcutFor(command) : null
  return keys || ''
}
