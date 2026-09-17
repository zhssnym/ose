/* The shared drills lib. One file for the pieces the Maths and Informatique plugins both draw:
   the DOM helpers, the words, the clock and the furniture of an item page. The index of each
   plugin is a real table now, and that is `table.js` beside this file.

   It imports nothing, writes no hex and no bare pixel, and knows nothing about either plugin: no
   file name, no route, no data shape beyond what the caller hands it. Everything it draws is
   styled by `drills.css`, which `ensureStylesheet()` links. */

/* ============================================================================ DOM
   The three helpers both plugins already had, byte for byte the Maths spelling: there is no
   `html:` key in this `h`, and that is the point — every string that reaches the screen goes
   through a text node. A plugin that needs real markup builds nodes. */

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (key === 'dataset') Object.assign(el.dataset, value)
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  append(el, children)
  return el
}

export function append(parent, child) {
  if (child == null || child === false) return parent
  if (Array.isArray(child)) { child.forEach(c => append(parent, c)); return parent }
  parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  return parent
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
  return el
}

/* ========================================================================== words */

/** `1 drill`, `3 drills`. */
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * A duration a person reads: `45 s`, `24 min 50`, `1 h 02 min`. Seconds are padded past the
 * minute so a column of them lines up.
 */
export function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} min ${String(total % 60).padStart(2, '0')}`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** The running clock at the top of a page: `0:07`, `12:04`, `1:02:04`. */
export function clockText(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const ss = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}:${ss}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${ss}`
}

const pad = (n) => String(n).padStart(2, '0')

const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** `2026-09-16T18:04:12`, local, seconds, no zone: the spelling the log lines use. */
export function stamp(date = new Date()) {
  return `${ymd(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/* ========================================================================== clock

   One object, one owner: the page that creates it stops it, and `stop()` is the only way it
   stops. Every leak the old clocks had was the same mistake twice — a clock started by code
   that is not the code that can stop it — so the three numbers below are its whole state.

   `banked` is milliseconds already counted. `since` is a wall-clock stamp, null when stopped.
   `lastSeen` is the stamp the last tick wrote. Elapsed is always a `Date.now()` delta, never a
   tick count, so a throttled background tab and a resumed laptop both read true. */

class Clock {
  constructor({ onTick, onBank, bankEvery = 10, gapS = 60 } = {}) {
    this.banked = 0
    this.since = null
    this.lastSeen = 0
    this.ticks = 0
    this.timer = null
    this.resumeOnVisible = false
    this.bankEvery = Math.max(1, Math.round(Number(bankEvery) || 10))
    this.gapMs = Math.max(1000, Math.round((Number(gapS) || 60) * 1000))
    this.tickFns = new Set()
    this.bankFns = new Set()
    if (typeof onTick === 'function') this.tickFns.add(onTick)
    if (typeof onBank === 'function') this.bankFns.add(onBank)
    // Hidden is stopped: a drill left on screen while the user is in another app is not work.
    this.onVisibility = () => {
      if (document.hidden) {
        if (!this.running) return
        this.resumeOnVisible = true
        this.stop()
      } else if (this.resumeOnVisible) {
        this.resumeOnVisible = false
        this.start()
      }
    }
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  get running() { return this.since != null }

  /** The same number in milliseconds: a thinking time taken as two marks off this clock is
      gap-safe and exact, where a one-second `elapsedS` would quantise every median (M). */
  get elapsedMs() {
    return this.banked + (this.since == null ? 0 : Math.max(0, Date.now() - this.since))
  }

  get elapsedS() { return Math.floor(this.elapsedMs / 1000) }

  /** What the page read from disk before starting. */
  setBanked(s) {
    this.banked = Math.max(0, Math.round((Number(s) || 0) * 1000))
    this.emitTick()
    return this
  }

  start() {
    if (this.running) return this
    const now = Date.now()
    this.since = now        // never a stamp kept from earlier
    this.lastSeen = now
    this.ticks = 0
    if (this.timer == null) this.timer = setInterval(() => this.tick(), 1000)
    this.emitTick()
    return this
  }

  stop() {
    if (this.timer != null) { clearInterval(this.timer); this.timer = null }
    const was = this.since != null
    if (was) {
      this.banked += Math.max(0, Date.now() - this.since)
      this.since = null
    }
    this.ticks = 0
    this.emitTick()
    // A stop on a clock that was not running banks nothing and writes nothing: `unmount` may
    // call it on a page the user never started, and that must not touch the file.
    if (was) this.emitBank()
    return this
  }

  tick() {
    const now = Date.now()
    if (this.since != null && now - this.lastSeen > this.gapMs) {
      // Asleep, or hidden without a visibilitychange we heard. Bank up to the last tick we
      // believe, drop the gap, and keep counting from now.
      this.banked += Math.max(0, this.lastSeen - this.since)
      this.since = now
      this.lastSeen = now
      this.ticks = 0
      this.emitTick()
      this.emitBank()
      return
    }
    this.lastSeen = now
    this.ticks += 1
    this.emitTick()
    if (this.ticks % this.bankEvery === 0) {
      // Bank without stopping: a reload, a crash or a quit costs at most `bankEvery` seconds.
      if (this.since != null) {
        this.banked += Math.max(0, now - this.since)
        this.since = now
      }
      this.emitBank()
    }
  }

  emitTick() { const s = this.elapsedS; for (const fn of [...this.tickFns]) fn(s) }
  emitBank() { const s = this.elapsedS; for (const fn of [...this.bankFns]) fn(s) }

  /** A second painter (mountClock uses it). Answers an unbind. Additive, not a contract name. */
  addTick(fn) {
    if (typeof fn !== 'function') return () => {}
    this.tickFns.add(fn)
    return () => this.tickFns.delete(fn)
  }

  dispose() {
    this.stop()
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.resumeOnVisible = false
    this.tickFns.clear()
    this.bankFns.clear()
  }
}

/**
 * The drill clock. `onTick(elapsedS)` every second; `onBank(elapsedS)` every `bankEvery`th
 * tick, on every gap drop and on `stop()`. A tick that finds more than `gapS` since the last
 * one drops the gap.
 */
export function createClock(options) {
  return new Clock(options || {})
}

/**
 * Paint `el` on every tick: `12:04`, or `12:04 / 25:00` where the page has a budget. Past the
 * budget the element carries `over` and nothing else happens — no alarm, no countdown, no
 * colour that has to be explained. Answers an unbind function.
 */
export function mountClock(clock, el, { budgetS } = {}) {
  if (!clock || !el) return () => {}
  const budget = Number(budgetS)
  const hasBudget = Number.isFinite(budget) && budget > 0
  const paint = (s) => {
    el.textContent = hasBudget ? `${clockText(s)} / ${clockText(budget)}` : clockText(s)
    el.classList.toggle('over', hasBudget && s > budget)
  }
  const off = typeof clock.addTick === 'function' ? clock.addTick(paint) : () => {}
  paint(clock.elapsedS)
  return () => { off() }
}

/* ===================================================================== page pieces */

/** The one line at the top: the drill's name, and the clock at the right. */
export function titleLine(text) {
  const clockEl = h('span', { class: 'drill-clock mono' })
  const el = h('div', { class: 'drill-title' },
    h('h1', { class: 'page-title', text: text == null ? '' : String(text) }),
    clockEl)
  return { el, clockEl }
}

/** The meta line under it: whatever the plugin leads with, then the facts, separated by the
    app's middle dot. */
export function metaLine(lead, facts) {
  const el = h('div', { class: 'page-meta drill-meta' })
  const parts = []
  if (lead) parts.push(lead)
  for (const fact of (Array.isArray(facts) ? facts : facts == null ? [] : [facts])) {
    const text = String(fact == null ? '' : fact).trim()
    if (text) parts.push(h('span', { class: 'drill-fact' }, text))
  }
  parts.forEach((part, i) => {
    if (i) el.appendChild(h('span', { class: 'drill-sep', text: '·' }))
    el.appendChild(part)
  })
  return el
}

/** An uppercase mono label over a band. No rule: whitespace does the grouping. */
export function paneLabel(text) {
  return h('div', { class: 'drill-pane-label mono-sm' }, text == null ? '' : String(text))
}

/**
 * The control band: left-aligned, primary first, the chord printed beside each button and the
 * hint at the end. The band never moves — see `.drill-controls` in drills.css.
 * buttons: [{ label, primary, onClick, chord, disabled }]
 */
export function controls(buttons, hint) {
  const el = h('div', { class: 'drill-controls' })
  const made = []
  for (const spec of (Array.isArray(buttons) ? buttons : [])) {
    if (!spec) continue
    const button = h('button', {
      class: 'btn' + (spec.primary ? ' primary' : ''),
      type: 'button',
      disabled: spec.disabled ? true : null,
      onclick: typeof spec.onClick === 'function' ? spec.onClick : null,
    }, String(spec.label == null ? '' : spec.label))
    made.push(button)
    if (spec.chord) {
      el.appendChild(h('span', { class: 'drill-chord' },
        button, h('span', { class: 'drill-chord-key mono-sm' }, String(spec.chord))))
    } else {
      el.appendChild(button)
    }
  }
  const text = hint == null ? '' : String(hint).trim()
  if (text) el.appendChild(h('span', { class: 'drill-hint mono-sm' }, text))
  el.buttons = made
  return el
}

const VERDICT_STATES = new Set(['ok', 'warn', 'err'])

/** One line, three states: the word in the state's ink, the figure in mono beside it. */
export function verdict({ state, word, figure } = {}) {
  const which = VERDICT_STATES.has(state) ? state : 'ok'
  return h('div', { class: `drill-verdict ${which}` },
    h('span', { class: 'drill-verdict-word' }, word == null ? '' : String(word)),
    figure == null || String(figure) === '' ? null
      : h('span', { class: 'mono-sm' }, String(figure)))
}

/** What went wrong, in the words of whatever threw, and the one way out. */
export function errorBlock({ head, detail, onRetry } = {}) {
  return h('div', { class: 'drill-error' },
    h('div', { class: 'drill-error-head mono-sm' }, head == null ? '' : String(head)),
    detail == null || String(detail) === '' ? null
      : h('p', { class: 'drill-error-detail' }, String(detail)),
    typeof onRetry !== 'function' ? null
      : h('button', { class: 'btn', type: 'button', onclick: onRetry }, 'try again'))
}

/**
 * Focus mode: one class on `<html>`, so the shell folds without anyone writing the user's
 * persisted sidebar preference, which a drill session once left folded for good. A page that
 * turns it on turns it off in `unmount`, on every path.
 *
 * The sidebar goes invisible and keeps its width (drills.css), so the page column does not
 * slide when a session starts or ends. Nothing on screen moves; the chrome stops being there.
 */
export function focusMode(on) {
  document.documentElement.classList.toggle('drill-focus', !!on)
  return !!on
}

/**
 * Link `drills.css` once. `import.meta.url` is this file's own URL, so the href is right
 * whatever the document's is (the dev server, or `<app origin>/plugins/_lib/drills.js` in the
 * exe). It is never removed: the lib is shared, so the last plugin to deactivate cannot know
 * whether the other one is still on screen.
 */
export function ensureStylesheet() {
  const found = document.head.querySelector('link[data-shared="drills"]')
  if (found) return found
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.dataset.shared = 'drills'
  link.href = new URL('./drills.css', import.meta.url).href
  document.head.appendChild(link)
  return link
}
