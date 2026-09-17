/* Maths — an Ose plugin (docs/PLUGINS.md).
 *
 * Calculation drills. One markdown file per series in the folder `ose.paths` answers for
 * `series`, each question four options behind one control. An AI writes the series files; this
 * plugin is the viewer: it lists them with the status the log gives them, runs one question at
 * a time, and appends one line per answer. It writes nothing else and starts no process, ever.
 *
 * Two commands, because two things happen here: open the list, and open the one to do next.
 */

import { toast } from 'ose:ui'
import { ensureStylesheet } from '../_lib/drills.js'

import { ctx, requireRoot, LOG } from './lib/ctx.js'
import { readAll, progressOf } from './lib/store.js'
import { mountIndex, refreshIndex } from './lib/index-view.js'
import { mountSerie, openSerie } from './lib/serie.js'

export const name = 'Maths'
export const description = 'Calculation drills: one series at a time, four options, one log line per answer.'

/* Where the series are. The plugin writes nothing outside this folder's `.math/log.jsonl`. */
export const paths = {
  series: { folder: 'math', hint: 'One markdown file per series, named serie-NN.md.' },
}

let pending = null
let offPaths = null

export async function activate(ose) {
  ctx.ose = ose
  ensureStylesheet()

  ose.commands.register({
    id: 'maths.index', title: 'Maths: open the series', group: 'Maths',
    run: () => ose.route.navigate({ type: 'view', name: 'maths' }),
  })

  ose.commands.register({
    id: 'maths.next', title: 'Maths: open the next series', group: 'Maths',
    shortcut: 'Mod+Shift+S', run: () => void openNext(),
  })

  ose.views.register('maths', { title: 'Maths', order: 50, icon: 'sigma', mount: mountIndex })

  // A series id is one segment (`serie-02`), so one pattern covers every route this plugin owns.
  ose.route.own('maths/*', mountSerie)
  ose.route.index('maths/*', () => cache.map(s => ({
    path: 'maths/' + s.id,
    title: s.titre || s.id,
  })))

  // The folder is not known here: a view or a route resolves it, the owner can point the plugin
  // at another one, and until there is one the folder itself is what we are waiting for. So the
  // watch is the vault's and the filter is the folder of the moment. The log is left out of it:
  // every answer writes to it, and nothing on screen is redrawn by its own writing.
  ose.watch(({ changes }) => {
    const root = ctx.dataRoot
    const mine = (c) => (under(root, c.path) || under(root, c.to)) && !isLog(c.path) && !isLog(c.to)
    if (root && !changes.some(mine)) return
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
  // `drills.css` and `table.css` stay: the lib is shared, and the last plugin to deactivate
  // cannot know whether the other one is still on screen. `style.css` is the loader's to
  // unlink, not ours.
  ctx.ose = null
}

/* ------------------------------------------------------------------ parts */

const under = (root, path) => !!path && (path === root || String(path).startsWith(root + '/'))
const isLog = (path) => !!path && String(path).endsWith('/' + LOG)

/* Quick open asks synchronously, so it is answered from the last listing. The folder is asked
   for again every time: this runs at boot, when the vault changes and after a Choose, and any
   of those can be the moment the folder appears. */
let cache = []
let warming = null
function warm() {
  if (warming) return warming
  warming = (async () => {
    const root = await requireRoot()
    cache = root ? (await readAll()).series : []
  })()
    .catch(() => null)
    .finally(() => { warming = null })
  return warming
}

/**
 * `maths.next`: the first series the log does not call done. Opening it is starting it, because
 * the page is the session, so there is nothing else for this command to do and nothing it can
 * interrupt: every answer already given is already in the log.
 */
async function openNext() {
  try {
    if (!await requireRoot()) {
      ctx.ose.route.navigate({ type: 'view', name: 'maths' })
      return
    }
    const { series, answers } = await readAll()
    const next = series.find(s => s.ok && !progressOf(answers, s.id, s.questions.length).done)
    if (!next) { toast('Maths: every series is done'); return }
    await openSerie(next.id)
  } catch (err) {
    toast('Maths: ' + ((err && err.message) || err), 'err')
  }
}
