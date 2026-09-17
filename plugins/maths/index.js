/* Maths — an Ose module (docs/MODULES.md).
 *
 * Daily calculation drills. One series a day, one folder per series under
 * `2-learning/1-school/1-math/1-drills`, seventy questions, twenty-five minutes, four options
 * hidden behind one control. The generator writes the series; this module runs them, times
 * them, logs every answer as it is given and writes the three reports the next generation
 * reads. It starts no process, ever (`run: []`).
 *
 * Two commands, because two things happen here: open the list, and start the day's series.
 * `maths.reveal`, `maths.pause` and `maths.bilan` are gone — the first two duplicated Space and
 * Escape, which the session binds on its own element, and the third opened a file the row menu
 * and the path line already reach (ADV-B).
 *
 * The furniture — the list row, the chips, the clock, the bands, the verdict, the error box,
 * the path line — is the rice's own `lib/drills.js`, shared with Informatique. This module
 * draws what is its own: the grammar, the maths, the session and the reports.
 */

import { toast } from 'ose:ui'
import { h, ensureStylesheet } from '../../lib/drills.js'

import { ctx, DEFAULT_MODULE_DIR, DATA_ROOT } from './lib/ctx.js'
import { readAll, readState, sweepTemp } from './lib/store.js'
import { mountIndex, refreshIndex } from './lib/index-view.js'
import { mountSerie, openSerie, requestStart, activePage } from './lib/serie.js'

let styleLinks = []
let pending = null

export async function activate(ose) {
  ctx.ose = ose
  ctx.moduleDir = moduleDirFromUrl()
  const info = await ose.vault.info()
  ctx.vaultRoot = (info && info.root) || ''
  ensureStylesheet()
  addStylesheets()
  void sweepTemp()

  const command = (id, title, run, shortcut) => {
    ose.commands.register({ id, title, group: 'Maths', shortcut, run })
  }

  command('maths.index', 'Maths: open the series',
    () => ose.route.navigate({ type: 'view', name: 'maths' }))

  command('maths.start', 'Maths: start the next series',
    () => void startNext(), 'Mod+Shift+S')

  ose.views.register('maths', { title: 'Maths', order: 50, icon: 'tasks', mount: mountIndex })

  // A series name is one segment (`serie-02`), so one pattern covers every route this module
  // owns, and it is the one module.json declares.
  ose.route.own('maths/*', mountSerie)
  ose.route.index('maths/*', () => cache.map(s => ({
    path: 'maths/' + s.id,
    title: s.n ? `Série ${s.n}` : s.id,
  })))

  ose.watch([DATA_ROOT], () => {
    clearTimeout(pending)
    pending = setTimeout(() => { void warm(); refreshIndex() }, 300)
  })

  void warm()
}

export function deactivate() {
  // The debounce outlived `deactivate`, so a tick landing inside 300 ms of a vault change ran
  // against a facade that was already null (ADV-T).
  clearTimeout(pending)
  pending = null
  for (const link of styleLinks) if (link.parentNode) link.parentNode.removeChild(link)
  styleLinks = []
  // `drills.css` stays: the lib is shared, and the last module to deactivate cannot know
  // whether the other one is still on screen.
  ctx.ose = null
}

/* ------------------------------------------------------------------ parts */

/* Quick open asks synchronously, so it is answered from the last listing. */
let cache = []
let warming = null
function warm() {
  if (warming) return warming
  warming = readAll()
    .then(body => { cache = body.series })
    .catch(() => null)
    .finally(() => { warming = null })
  return warming
}

/**
 * `maths.start`: whatever is half done, else the first series that is not. It navigates and the
 * series page starts itself the moment it mounts, so the command is the same whether the page
 * is already open or not.
 *
 * **It never ends a session and never starts one over another.** Three cases, in order:
 *
 *   1. a live session on the open page — the command focuses it and changes nothing. It used to
 *      redraw the page under the running session: the session object was dropped but its clock
 *      kept ticking, `drill-focus` stayed on `<html>`, the sidebar stayed folded and `resume`
 *      did nothing for ever. Twenty seconds of work nobody did were banked to `state.json` in
 *      twenty-two seconds, and the only cure was to guess that leaving was the cure (Q1);
 *   2. a series page open while a *different* series is the one in progress — that page's own
 *      door already says so and offers both ways out (`resume Série N` / `start this one
 *      instead`, which asks). The command draws that door and steps back: choosing between the
 *      two is the one thing this door exists to refuse. The chord is printed beside its primary
 *      button, so what the command does from there is written on the screen;
 *   3. anywhere else — go to the series in progress, or to the first that is not done, and
 *      start it. That is the command's whole job.
 *
 * The read takes a moment, and the user is allowed to go elsewhere in that moment: the route is
 * compared before and after, and a route that moved is left alone. It used to yank the user off
 * the page he had moved to, three seconds later (ADV-T).
 */
async function startNext() {
  if (activePage && activePage.live) { activePage.focusSession(); return }   // 1
  const before = routeKey(ctx.ose.route.current())
  try {
    const state = await readState()
    const going = state.en_cours && state.en_cours.serie ? state.en_cours.serie : null
    let name = going
    if (!name) {
      const { series } = await readAll()
      const next = series.find(s => s.ok && ((state.series || {})[s.id] || {}).statut !== 'fait')
      if (!next) { toast('Maths: every series is done'); return }
      name = next.id
    }
    if (routeKey(ctx.ose.route.current()) !== before) return
    const page = activePage
    if (page && page.live) { page.focusSession(); return }                   // 1, after the read
    if (going && page && page.name !== going && page.focusDoor()) return      // 2
    requestStart(name)
    if (page && page.name === name) await page.load()                        // 3
    else await openSerie(name)
  } catch (err) {
    toast('Maths: ' + ((err && err.message) || err), 'err')
  }
}

const routeKey = (route) =>
  !route ? '' : `${route.type || ''}:${route.path || route.name || ''}`

/**
 * Two stylesheets, both from this module's own folder: Temml's (the MathML rules, no fonts —
 * the system maths font draws it) and the module's own. `import './maths.css'` is not a thing
 * in a rice with no bundler, so they are `<link>`s the entry adds and `deactivate` takes away
 * (MODULES.md rule 3). `import.meta.url` spells no origin.
 */
function addStylesheets() {
  if (styleLinks.length) return
  for (const name of ['./vendor/Temml-Local.css', './maths.css']) {
    const link = h('link', { rel: 'stylesheet' })
    link.dataset.module = 'maths'
    link.href = new URL(name, import.meta.url).href
    document.head.appendChild(link)
    styleLinks.push(link)
  }
}

/**
 * Where this module's files are, vault-relative.
 * `app://localhost/modules/maths/index.js` (the host) and
 * `/…/work/vault/.ose/app/modules/maths/index.js` (a dev server serving the rice)
 * both answer `.ose/app/modules/maths`.
 */
function moduleDirFromUrl() {
  try {
    const dir = new URL(import.meta.url).pathname.replace(/\/[^/]*$/, '')
    const at = dir.lastIndexOf('/.ose/app/')
    if (at >= 0) return '.ose/app' + dir.slice(at + '/.ose/app'.length)
    const tail = dir.replace(/^\/+/, '').replace(/\/+$/, '')
    return tail ? '.ose/app/' + tail : DEFAULT_MODULE_DIR
  } catch {
    return DEFAULT_MODULE_DIR
  }
}
