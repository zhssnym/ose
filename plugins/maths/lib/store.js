/* Every read and the one write the plugin does, over `ose.files`, under the folder `ose.paths`
   answered for `series`.

   **The log is the only state.** There is no `state.json`, no `bilan.md` and no result file:
   the status of a series, its score and the question to resume at are computed from
   `.math/log.jsonl` every time they are wanted. The only thing this plugin writes is one line
   of that log, the moment an answer is picked.

   The appends go through one promise chain, so two picks that overlap cannot interleave inside
   the host's read-modify-write. */

import { parseSerie } from './parse.js'
import { ctx, LOG, vaultPath, serieFile } from './ctx.js'

/* A series is a file, and its name is its id. `README.md` and `erreurs.md` sit in the same
   folder and are the owner's own: nothing here lists them and nothing here writes to them. */
const SERIE_FILE = /^serie-\d+\.md$/

const files = () => ctx.ose.files

/** The exact bytes of one log line, terminator included. */
export const logText = (entry) => JSON.stringify(entry) + '\n'

/* ---------------------------------------------------------------- reading */

/** Every series id, in name order. The id of `serie-02.md` is `serie-02`. */
export async function listSeries() {
  let rows = []
  try { rows = await files().list(vaultPath('')) } catch { return [] }
  return rows
    .filter(r => r.kind === 'file' && SERIE_FILE.test(r.name))
    .map(r => r.name.replace(/\.md$/, ''))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** One series read and parsed. `missing` when the file is gone since it was listed. */
export async function readSerie(id) {
  let body = null
  try { body = await files().read(vaultPath(serieFile(id))) } catch { body = null }
  if (body == null) {
    return {
      id, missing: true, ok: false, questions: [], familles: [],
      titre: id, date: '', n: null,
      errors: [{ line: 1, message: `there is no ${serieFile(id)}` }],
    }
  }
  return Object.assign({ id, missing: false }, parseSerie(body))
}

/** Every answer line in the log, in the order they were written. A bad line is skipped. */
export async function readLog() {
  let text = ''
  try { text = await files().read(vaultPath(LOG)) } catch { text = '' }
  return splitLog(text)
}

export function splitLog(text) {
  const answers = []
  for (const line of String(text || '').split('\n')) {
    const body = line.trim()
    if (!body) continue
    let value = null
    try { value = JSON.parse(body) } catch { continue }
    if (!value || typeof value !== 'object') continue
    // A session line from an older version has no `n`, and is not an answer. It is left where
    // it is: a log is never rewritten.
    if (value.serie && value.n != null) answers.push(value)
  }
  return { answers }
}

/** Every series, parsed, and the whole log, in one read. */
export async function readAll() {
  const ids = await listSeries()
  const series = []
  for (const id of ids) series.push(await readSerie(id))
  const { answers } = await readLog()
  return { series, answers }
}

/**
 * What the log says about one series, which is everything anyone asks about it.
 *
 *   answered  how many of its question numbers have a line
 *   correct   the score: the FIRST line of each question is the one that counts
 *   done      every question number has a line
 *   resumeAt  the first question number with no line, or null when there is none
 */
export function progressOf(answers, id, total) {
  const first = new Map()
  for (const a of (answers || [])) {
    if (a.serie !== id) continue
    const n = Number(a.n)
    if (!Number.isFinite(n) || first.has(n)) continue
    first.set(n, a)
  }
  let answered = 0
  let correct = 0
  let resumeAt = null
  for (let n = 1; n <= total; n++) {
    const a = first.get(n)
    if (!a) { if (resumeAt == null) resumeAt = n; continue }
    answered += 1
    if (a.juste) correct += 1
  }
  return { answered, correct, total, done: total > 0 && answered === total, resumeAt }
}

/* ---------------------------------------------------------------- writing */

let chain = Promise.resolve()

/** One line, written the moment it is true. Never buffered, never rewritten. */
export function appendLog(entry) {
  const next = chain.then(
    () => files().append(vaultPath(LOG), logText(entry)),
    () => files().append(vaultPath(LOG), logText(entry)),
  )
  chain = next.then(() => {}, () => {})
  return next
}
