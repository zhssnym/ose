/* Maths — an Ose plugin (docs/PLUGINS.md).
 *
 * Daily calculation drills. One series a day, one markdown file per series in the folder
 * `ose.paths` answers for `series`, seventy questions, twenty-five minutes, four options hidden
 * behind one control. The generator writes the series; this plugin runs them, times them, logs
 * every answer as it is given and writes the three reports the next generation reads. It starts
 * no process, ever.
 *
 * Two commands, because two things happen here: open the list, and start the day's series.
 * `maths.reveal`, `maths.pause` and `maths.bilan` are gone — the first two duplicated Space and
 * Escape, which the session binds on its own element, and the third opened a file the row menu
 * and the path line already reach (ADV-B).
 *
 * The furniture — the list row, the chips, the clock, the bands, the verdict, the error box,
 * the path line — is `../_lib/drills.js`, shared with the nsi plugin. This one draws what is its
 * own: the grammar, the maths, the session and the reports.
 */

import { toast } from 'ose:ui'
import { ensureStylesheet } from '../_lib/drills.js'

import { ctx, requireRoot } from './lib/ctx.js'
import { readAll, readState, sweepTemp } from './lib/store.js'
import { mountIndex, refreshIndex } from './lib/index-view.js'
import { mountSerie, openSerie, requestStart, activePage } from './lib/serie.js'

export const name = 'Maths'
export const description = 'Calculation drills: one series a day, timed, with a thinking-time curve.'

/* Where the series are. The plugin writes nothing outside this folder and its `.math/`. */
export const paths = {
  series: { folder: 'math', hint: 'One markdown file per series, named serie-NN.md.' },
}

let pending = null
let offPaths = null

export async function activate(ose) {
  ctx.ose = ose
  const info = await ose.vault.info()
  ctx.vaultRoot = (info && info.root) || ''
  ensureStylesheet()

  const command = (id, title, run, shortcut) => {
    ose.commands.register({ id, title, group: 'Maths', shortcut, run })
  }

  command('maths.index', 'Maths: open the series',
    () => ose.route.navigate({ type: 'view', name: 'maths' }))

  command('maths.start', 'Maths: start the next series',
    () => void startNext(), 'Mod+Shift+S')

  ose.views.register('maths', { title: 'Maths', order: 50, icon: 'tasks', mount: mountIndex })

  // A series id is one segment (`serie-02`), so one pattern covers every route this plugin owns.
  ose.route.own('maths/*', mountSerie)
  ose.route.index('maths/*', () => cache.map(s => ({
    path: 'maths/' + s.id,
    title: s.n ? `Série ${s.n}` : s.id,
  })))

  // The folder is not known here: a view or a route resolves it, the owner can point the plugin
  // at another one, and until there is one the folder itself is what we are waiting for. So the
  // watch is the vault's and the filter is the folder of the moment.
  ose.watch(({ changes }) => {
    const root = ctx.dataRoot
    if (root && !changes.some(c => under(root, c.path) || under(root, c.to))) return
    clearTimeout(pending)
    pending = setTimeout(() => { void warm(); refreshIndex() }, 300)
  })

  // A folder chosen by hand moves everything at once. The kernel mounts the route on screen
  // again; the list of series behind quick open is ours to redo.
  offPaths = ose.paths.on(() => { void warm(); refreshIndex() })

  void warm()
}

export function deactivate() {
  // The debounce outlived `deactivate`, so a tick landing inside 300 ms of a vault change ran
  // against an `ose` that was already null (ADV-T).
  clearTimeout(pending)
  pending = null
  // The watch is taken back with the plugin's other registrations; this subscription is not one
  // of them (PLUGINS.md), so it is undone here.
  if (offPaths) { offPaths(); offPaths = null }
  // `drills.css` stays: the lib is shared, and the last plugin to deactivate cannot know whether
  // the other one is still on screen. `style.css` is the loader's to unlink, not ours.
  ctx.ose = null
}

/* ------------------------------------------------------------------ parts */

const under = (root, path) => !!path && (path === root || String(path).startsWith(root + '/'))

/* Quick open asks synchronously, so it is answered from the last listing. The folder is asked
   for again every time: this runs at boot, when the vault changes and after a Choose, and any
   of those can be the moment the folder appears. */
let cache = []
let swept = null
let warming = null
function warm() {
  if (warming) return warming
  warming = (async () => {
    const root = await requireRoot()
    if (root && root !== swept) { swept = root; void sweepTemp() }
    cache = root ? (await readAll()).series : []
  })()
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
 * With no folder resolved there is nothing to start: the list is where the box that says so is
 * drawn, so the command goes there.
 *
 * The read takes a moment, and the user is allowed to go elsewhere in that moment: the route is
 * compared before and after, and a route that moved is left alone. It used to yank the user off
 * the page he had moved to, three seconds later (ADV-T).
 */
async function startNext() {
  if (activePage && activePage.live) { activePage.focusSession(); return }   // 1
  const before = routeKey(ctx.ose.route.current())
  try {
    if (!await requireRoot()) {
      ctx.ose.route.navigate({ type: 'view', name: 'maths' })
      return
    }
    const state = await readState()
    const going = state.en_cours && state.en_cours.serie ? state.en_cours.serie : null
    let id = going
    if (!id) {
      const { series } = await readAll()
      const next = series.find(s => s.ok && ((state.series || {})[s.id] || {}).statut !== 'fait')
      if (!next) { toast('Maths: every series is done'); return }
      id = next.id
    }
    if (routeKey(ctx.ose.route.current()) !== before) return
    const page = activePage
    if (page && page.live) { page.focusSession(); return }                   // 1, after the read
    if (going && page && page.name !== going && page.focusDoor()) return      // 2
    requestStart(id)
    if (page && page.name === id) await page.load()                          // 3
    else await openSerie(id)
  } catch (err) {
    toast('Maths: ' + ((err && err.message) || err), 'err')
  }
}

const routeKey = (route) =>
  !route ? '' : `${route.type || ''}:${route.path || route.name || ''}`
