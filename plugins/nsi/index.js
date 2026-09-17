/* Code — an Ose plugin (docs/PLUGINS.md).

   Coding drills, LeetCode-like: one folder per drill under the drills folder, a Python judge
   in `judge/`, a clock on every drill. One kind of drill: a function in `solution.py`, judged
   by `tests.py` when there is one and self-graded against the correction when there is not.

   The plugin shows the drills and records the attempts; it decides nothing. What the next
   drill should be is worked out by an agent reading `.nsi/log.jsonl` and written into the
   folder as files.

   The furniture — the DOM helpers, the clock, the title line, the verdict — comes from
   `../_lib/drills.js`, and the table from `../_lib/table.js`; the Maths plugin draws with
   both. The only process this plugin starts is its own CLI. */

import { ensureStylesheet } from '../_lib/drills.js'

import { open, close, onDataRoot } from './lib/ctx.js'
import { cache, listDrills } from './lib/data.js'
import { mountIndex, unmountIndex, refreshIndex } from './lib/index-view.js'
import { mountDrill, active } from './lib/drill.js'

export const name = 'Code'
export const description = 'Coding drills as folders, a judge, a clock, one log.'

export const paths = {
  drills: {
    folder: 'nsi',
    hint: 'One folder per drill, each with enonce.md, meta.json and solution.py.',
  },
}

let pending = null
let unwatch = null

export async function activate(ose) {
  await open(ose)
  ensureStylesheet()          // the shared one; this plugin's own is linked by the loader

  // `shortcut` on a command both prints the chord and binds it (PLUGINS.md rule 4), so a
  // plugin's key works with no line in the shell's keys.json. Ctrl+Shift+N is the kernel's
  // "new folder" and this plugin used to take it away app-wide (ADV-B).
  const command = (id, title, run, shortcut, when) => {
    ose.commands.register({ id, title, group: 'Code', shortcut, when, run })
  }

  command('nsi.index', 'Code: open the drills',
    () => ose.route.navigate({ type: 'view', name: 'nsi' }))

  command('nsi.run', 'Code: run the solution',
    () => active && active.run(), 'Mod+Shift+R', () => !!active)

  command('nsi.submit', 'Code: submit this drill',
    () => active && active.submit(), 'Mod+Shift+Enter',
    () => !!active && active.judgeable)

  ose.views.register('nsi', {
    title: 'Code', order: 60, icon: 'command',
    mount: mountIndex, unmount: unmountIndex,
  })
  // A drill id is the folder's own name, one segment, so one pattern covers every route.
  ose.route.own('nsi/*', mountDrill)
  ose.route.index('nsi/*', () => {
    // Quick open asks synchronously, so it gets the last listing. With none yet (nothing has
    // opened the view), one is read in the background and the next press has the rows.
    if (!cache.drills.length) warmCache()
    return cache.drills.map(d => ({
      path: 'nsi/' + d.id,
      title: d.number == null ? d.title : `${d.number} · ${d.title}`,
    }))
  })

  // The drills folder is known only once a view or a route has asked `ose.paths` for it, and
  // the user may point the plugin at another one. The watch follows whatever it answers.
  onDataRoot(folder => {
    if (unwatch) unwatch()
    unwatch = ose.watch([folder], () => {
      clearTimeout(pending)
      pending = setTimeout(() => refreshIndex(), 300)
    })
  })
}

export function deactivate() {
  // The debounce outlived `deactivate` and ran `refreshIndex()` against an `ose` that was
  // already gone (ADV-T).
  clearTimeout(pending)
  pending = null
  if (unwatch) { unwatch(); unwatch = null }
  close()
}

/* ------------------------------------------------------------------ parts */

let warming = null
function warmCache() {
  if (warming) return warming
  warming = listDrills().catch(() => null).finally(() => { warming = null })
  return warming
}
