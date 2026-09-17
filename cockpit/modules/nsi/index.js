/* Informatique — an Ose module (docs/MODULES.md).

   Generated coding drills, LeetCode-like: one folder per drill directly under
   `2-learning/1-school/2-nsi/1-drills`, a Python judge in `judge/`, a clock on every drill,
   spaced review. One kind of drill: a function in `solution.py`, judged by `tests.py` when
   there is one and self-graded against the correction when there is not.

   The furniture — the DOM helpers, the chips, the list row, the clock, the verdict, the path
   line — comes from the rice's own `lib/drills.js`, which the Maths module draws from too.
   Everything this module does goes through the facade `activate` is handed; the only process
   it starts is its own CLI. */

import { toast } from 'ose:ui'
import { ensureStylesheet } from '../../lib/drills.js'

import { ctx, open, close } from './lib/ctx.js'
import { cli, cache } from './lib/cli.js'
import { mountIndex, refreshIndex, openDrill, byNumber } from './lib/index-view.js'
import { mountDrill, active } from './lib/drill.js'

let styleLink = null
let pending = null

export async function activate(ose) {
  await open(ose)
  ensureStylesheet()          // the shared one; this module's own is linked below
  addStylesheet()
  forgetOldClocks()

  // `shortcut` on a command both prints the chord and binds it (MODULES.md rule 4), so a
  // module's key works with no line in the rice's keys.json. Ctrl+Shift+N is the kernel's
  // "new folder" and this module used to take it away app-wide (ADV-B).
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
    title: 'Informatique', order: 60, icon: 'command', mount: mountIndex,
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

  ose.watch([ctx.dataRoot], () => {
    clearTimeout(pending)
    pending = setTimeout(() => refreshIndex(), 300)
  })
}

export function deactivate() {
  // The debounce outlived `deactivate` and ran `refreshIndex()` against a facade that was
  // already null (ADV-T).
  clearTimeout(pending)
  pending = null
  if (styleLink && styleLink.parentNode) styleLink.parentNode.removeChild(styleLink)
  styleLink = null
  close()
}

/* ------------------------------------------------------------------ parts */

let warming = null
function warmCache() {
  if (warming) return warming
  warming = cli.list().catch(() => null).finally(() => { warming = null })
  return warming
}

/**
 * The elapsed seconds used to live in `.ose/state.json`, under a doubled key, and nothing ever
 * pruned them. They live beside the data now (`lib/clocks.js`); this takes the old slot away
 * once, so the kernel's state file stops carrying a map of a module's numbers.
 */
function forgetOldClocks() {
  try {
    const slot = ctx.ose.state()
    const current = slot.get()
    if (!current || typeof current !== 'object' || !('nsi' in current)) return
    const next = { ...current }
    delete next.nsi
    slot.set(next)
  } catch { /* nothing there to forget */ }
}

function addStylesheet() {
  if (styleLink) return
  styleLink = document.createElement('link')
  styleLink.rel = 'stylesheet'
  styleLink.dataset.module = 'nsi'
  styleLink.href = new URL('./nsi.css', import.meta.url).href
  document.head.appendChild(styleLink)
}
