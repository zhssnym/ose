/* Informatique — an Ose plugin (docs/PLUGINS.md).

   Generated coding drills, LeetCode-like: one folder per drill under the drills folder, a
   Python judge in `judge/`, a clock on every drill, spaced review. One kind of drill: a
   function in `solution.py`, judged by `tests.py` when there is one and self-graded against
   the correction when there is not.

   The furniture — the DOM helpers, the chips, the list row, the clock, the verdict, the path
   line — comes from `../_lib/drills.js`, which the Maths plugin draws from too. The only
   process this plugin starts is its own CLI. */

import { toast } from 'ose:ui'
import { ensureStylesheet } from '../_lib/drills.js'

import { open, close, onDataRoot } from './lib/ctx.js'
import { cli, cache } from './lib/cli.js'
import { mountIndex, unmountIndex, refreshIndex, openDrill, byNumber } from './lib/index-view.js'
import { mountDrill, active } from './lib/drill.js'

export const name = 'Informatique'
export const description = 'Coding drills as folders, a judge, a clock, spaced review.'

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
    ose.commands.register({ id, title, group: 'Informatique', shortcut, when, run })
  }

  command('nsi.index', 'Informatique: open the drills',
    () => ose.route.navigate({ type: 'view', name: 'nsi' }))

  command('nsi.next', 'Informatique: next drill', async () => {
    // Where the user was before the judge was asked. Reading it takes a Python process, and
    // three seconds later this used to yank them off the page they had moved to (ADV-T).
    const before = JSON.stringify(ose.route.current())
    try {
      const body = await cli.next()
      if (JSON.stringify(ose.route.current()) !== before) return
      if (body.empty || !body.drill) { toast(body.reason || 'nothing to do'); return }
      openDrill(body.drill.id)
      toast(body.reason)
    } catch (err) { toast('Informatique: ' + (err.message || err), 'err') }
  }, 'Mod+Shift+D')

  command('nsi.run', 'Informatique: run the solution',
    () => active && active.run(), 'Mod+Shift+R', () => !!active)

  command('nsi.submit', 'Informatique: submit this drill',
    () => active && active.submit(), 'Mod+Shift+Enter',
    () => !!active && active.judgeable)

  ose.views.register('nsi', {
    title: 'Informatique', order: 60, icon: 'command',
    mount: mountIndex, unmount: unmountIndex,
  })
  // A drill id is the folder's own name, one segment, so one pattern covers every route.
  ose.route.own('nsi/*', mountDrill)
  ose.route.index('nsi/*', () => {
    // Quick open asks synchronously, so it gets the last listing. With none yet (nothing has
    // opened the view), one is fetched in the background and the next press has the rows.
    if (!cache.drills.length) warmCache()
    return [...cache.drills].sort(byNumber).map(d => ({
      path: 'nsi/' + d.id,
      title: `${d.number} · ${d.title}`,
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
  warming = cli.list().catch(() => null).finally(() => { warming = null })
  return warming
}
