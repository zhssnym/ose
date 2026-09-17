/* The drills, and what the log says has become of them.

   The judge judges one drill and appends one line; it answers no listing. So the list is read
   here, from the two things that hold it: the drills folder (one folder per drill, a meta.json
   in each) and `.nsi/log.jsonl`, append only, the only state there is. Status, date and the
   best time are computed from those lines every time and nothing is kept on disk.

   `meta.json` is read for three keys and no others: `title`, `tags` (the first is the drill's
   category) and `date`. The judge reads `code` as well, which is its business, not this
   file's. */

import { parseJsonl } from 'ose:md'
import { plural } from '../../_lib/drills.js'

import { ctx, vaultPath, DATA_DIRNAME } from './ctx.js'

const LOG = DATA_DIRNAME + '/log.jsonl'
const NUMBER = /^(\d+)/
const SLUG_OF = /^\d+-/
const GRADED = new Set(['pass', 'partial', 'fail'])

/* The last listing, so quick open and a drill page can answer without reading the folder
   again. Filled by every `listDrills`, never by `activate`. */
export const cache = { drills: [] }

/** The row of the last listing with this id, or null. */
export function cachedRow(id) {
  return cache.drills.find(d => d.id === id) || null
}

/* ------------------------------------------------------------------------- the log */

/**
 * Every line that names a drill, oldest first, grouped by drill id. A line the log carries for
 * a folder that is not there any more is simply never asked for.
 */
async function readLog() {
  const out = new Map()
  let text = ''
  try {
    text = await ctx.ose.files.read(vaultPath(LOG))
  } catch {
    return out           // no submission yet: no file, and that is not an error
  }
  for (const line of parseJsonl(text)) {
    const id = line && line.problem
    if (typeof id !== 'string' || !id) continue
    const rows = out.get(id)
    if (rows) rows.push(line)
    else out.set(id, [line])
  }
  return out
}

/**
 * What one drill's lines add up to. `done` the moment one submission ever passed, `attempts`
 * the lines that carry a verdict (a note written into the log by hand is not an attempt),
 * `best` the shortest passing duration, `date` the day of the first line.
 */
function summarise(lines) {
  const rows = Array.isArray(lines) ? lines : []
  const graded = rows.filter(l => GRADED.has(l.verdict))
  let best = null
  for (const line of graded) {
    if (line.verdict !== 'pass') continue
    const seconds = Number(line.duration_s)
    // A duration of 0 is a submission that was not timed, not a best of no seconds.
    if (!Number.isFinite(seconds) || seconds <= 0) continue
    if (best === null || seconds < best) best = seconds
  }
  return {
    done: graded.some(l => l.verdict === 'pass'),
    attempts: graded.length,
    best,
    date: day(rows.length ? rows[0].ts : ''),
  }
}

/** The status column: three states, and the log decides which. */
export function statusCell({ done, attempts } = {}) {
  if (done) return { text: 'done', tone: 'ok' }
  if (!attempts) return { text: 'not done', tone: 'muted' }
  return { text: plural(attempts, 'attempt'), tone: 'warn' }
}

/** What the log knows about one drill, read fresh. For a page opened cold. */
export async function stateOf(id) {
  return summarise((await readLog()).get(id) || [])
}

/* ---------------------------------------------------------------------- the folder */

/**
 * Every drill under the drills folder, in number order: one folder, one meta.json, one row.
 * A folder whose meta.json is missing or broken is not a drill — the judge would refuse it
 * too — and it is named on the console rather than dropped in silence.
 */
export async function listDrills() {
  const folder = ctx.dataRoot
  if (!folder) return []
  const [entries, log] = await Promise.all([
    ctx.ose.files.list(folder),
    readLog(),
  ])
  const rows = await Promise.all((entries || [])
    .filter(entry => entry && entry.kind === 'dir' && !entry.name.startsWith('.'))
    .map(entry => row(entry.name, log.get(entry.name) || [])))
  const out = rows.filter(Boolean).sort(byNumber)
  cache.drills = out
  return out
}

async function row(id, lines) {
  let meta = null
  try {
    meta = JSON.parse(await ctx.ose.files.read(vaultPath(id + '/meta.json')))
  } catch {
    return null
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    console.warn('[nsi] meta.json is not an object, drill skipped: ' + id)
    return null
  }
  const state = summarise(lines)
  const tags = Array.isArray(meta.tags) ? meta.tags.map(text).filter(Boolean) : []
  return {
    id,
    number: numberOf(id),
    title: text(meta.title) || id.replace(SLUG_OF, ''),
    // The dominant category of the drill: the first tag it was written with.
    category: tags[0] || '',
    ...state,
    // The day the drill was written, when the file says so; failing that the day it was first
    // worked on, which is the closest thing the log knows. It comes after the spread: the
    // state carries a date of its own and the file has the last word.
    date: text(meta.date) || state.date,
  }
}

/** A drill's place in the list: its number, and its id when two share one. */
function byNumber(a, b) {
  const na = a.number
  const nb = b.number
  if (na !== null && nb !== null && na !== nb) return na - nb
  if (na === null && nb !== null) return 1
  if (nb === null && na !== null) return -1
  return String(a.id).localeCompare(String(b.id))
}

/** The integer a folder name starts with, or null. `07-x` is 7, `x` is none. */
function numberOf(name) {
  const found = NUMBER.exec(String(name || ''))
  return found ? Number(found[1]) : null
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** The `YYYY-MM-DD` of a log timestamp (`2026-09-17T21:40:13`), or empty. */
function day(ts) {
  const found = /^(\d{4}-\d{2}-\d{2})/.exec(String(ts || ''))
  return found ? found[1] : ''
}
