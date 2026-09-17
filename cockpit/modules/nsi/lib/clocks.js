/* Where the elapsed seconds of a drill are kept: `<data root>/.nsi/clocks.json`, beside the
   judge's own state and log.

       { "1-recherche-dictionnaire-temps-constant": 117 }

   Beside the data and not in `.ose/state.json` (ADV-U, ADV-T): the files are the database, a
   module's numbers belong next to the files they describe, and the kernel's state file is for
   the editor. It was in `.ose/state.json` under a doubled key, another reviewer's probe wiped
   it, and with it every drill's time.

   One number per drill, and only while the drill is unsolved: a solved drill's time is in
   `log.jsonl`, which is where a best time is read from. A review starts from zero.

   The file is small and is read once per visit. Every write drops the ids the last listing did
   not carry, so a drill that went to the trash does not keep a number for ever. */

import { ctx, vaultPath, DATA_DIRNAME } from './ctx.js'
import { cache } from './cli.js'

const FILE = DATA_DIRNAME + '/clocks.json'

async function readAll() {
  try {
    const text = await ctx.ose.files.read(vaultPath(FILE))
    const value = JSON.parse(text)
    return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {}
  } catch {
    // No file yet, or a file somebody broke by hand: an empty clock is the honest answer, and
    // the next write lays a good one down.
    return {}
  }
}

/** The seconds banked for one drill by earlier visits. 0 when there are none. */
export async function readClock(id) {
  const seconds = Number((await readAll())[id])
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0
}

/**
 * Bank `seconds` for one drill, or forget it when `seconds` is null (the drill is solved: its
 * time lives in the log now). Ids the last listing did not carry are dropped on the way.
 */
export async function writeClock(id, seconds) {
  // No listing yet (a drill opened cold, before the index ever drew) means nothing is known to
  // be gone: everything is kept. Pruning against an empty set would drop every other drill's
  // seconds on the first bank of the session.
  const known = cache.drills.length ? new Set(cache.drills.map(d => d.id)) : null
  const current = await readAll()
  const next = {}
  for (const [key, value] of Object.entries(current)) {
    const n = Number(value)
    if (key !== id && (!known || known.has(key)) && Number.isFinite(n) && n > 0) next[key] = Math.round(n)
  }
  if (seconds != null && Number(seconds) > 0) next[id] = Math.round(Number(seconds))
  await ctx.ose.files.write(vaultPath(FILE), JSON.stringify(next, null, 2) + '\n')
}
