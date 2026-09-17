/* Every read and every write the drills do, over `ose.files`, under the folder `ose.paths`
   answered for `series`. The bytes are FORMAT-drills.md's.

   There used to be an adapter, a host and a re-export barrel between this file and `ose.files`
   — a port for a portal that has no code, twenty-four of whose thirty-nine exports were dead
   (ADV-B). They are gone; this file builds every path it uses from `lib/ctx.js`.

   **Every write goes through one promise chain** (`serial`). Two writes of `state.json` that
   overlap raced the host's atomic rename and left a `.state.json.NNN.tmp` orphan in the vault
   (ADV-M), and a `leave` interleaved with a `start` could leave `en_cours` pointing at the
   series you just left (ADV-T). One chain makes both impossible. `sweepTemp()` takes away the
   orphans a previous version left behind. */

import { parseSerie } from './parse.js'
import { ctx, DOT, vaultPath, serieFile, resultatFile } from './ctx.js'
import { median, duration } from '../../_lib/drills.js'
import { think, frenchDate } from './fmt.js'

export const LOG = `${DOT}/log.jsonl`
export const STATE = `${DOT}/state.json`
export const BILAN = `${DOT}/bilan.md`

/* A series is a file, and its name is its id. `README.md` and `erreurs.md` sit in the same
   folder and are the owner's own: nothing here lists them and nothing here writes to them. */
const SERIE_FILE = /^serie-\d+\.md$/

/** The exact bytes of `state.json`. */
export const stateText = (state) => JSON.stringify({
  series: (state && state.series) || {},
  en_cours: (state && state.en_cours) || null,
}, null, 2) + '\n'

/** The exact bytes of one log line, terminator included. */
export const logText = (entry) => JSON.stringify(entry) + '\n'

const files = () => ctx.ose.files

/* ------------------------------------------------------------- the chain */

let chain = Promise.resolve()

/** Run `fn` after everything already queued, whether that succeeded or not. */
function serial(fn) {
  const next = chain.then(fn, fn)
  chain = next.then(() => {}, () => {})
  return next
}

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
      id, name: id, missing: true, ok: false, questions: [], familles: [],
      date: '', duree: 0, n: null,
      errors: [{ line: 1, message: `there is no ${serieFile(id)}` }],
    }
  }
  return Object.assign({ id, name: id, missing: false }, parseSerie(body))
}

export async function readState() {
  let value = null
  try { value = JSON.parse(await files().read(vaultPath(STATE))) } catch { value = null }
  return {
    series: (value && typeof value.series === 'object' && value.series) || {},
    en_cours: (value && value.en_cours) || null,
  }
}

/** The whole log, split into the answer lines and the session lines. A bad line is skipped. */
export async function readLog() {
  let text = ''
  try { text = await files().read(vaultPath(LOG)) } catch { text = '' }
  return splitLog(text)
}

export function splitLog(text) {
  const answers = []
  const sessions = []
  for (const line of String(text || '').split('\n')) {
    const body = line.trim()
    if (!body) continue
    let value = null
    try { value = JSON.parse(body) } catch { continue }
    if (!value || typeof value !== 'object') continue
    if (value.session) sessions.push(value)
    else if (value.serie && value.n != null) answers.push(value)
  }
  return { answers, sessions }
}

/** Every series and the state that decorates the list, in one read. */
export async function readAll() {
  const ids = await listSeries()
  const state = await readState()
  const series = []
  for (const id of ids) {
    const serie = await readSerie(id)
    // The row menu offers the result file only when there is one to open: a menu item that
    // opens an empty page is a second door to nothing.
    try { serie.hasResultat = await files().exists(vaultPath(resultatFile(id))) }
    catch { serie.hasResultat = false }
    series.push(serie)
  }
  return { series, state }
}

/** The misses of the last complete attempt of a series, read back from the log. */
export async function lastMisses(serie) {
  if (!serie || !serie.ok) return []
  const id = serie.id || serie.name
  const { answers } = await readLog()
  const byNumber = new Map()
  for (const a of answers) if (a.serie === id) byNumber.set(a.n, a)
  const out = []
  for (const q of serie.questions) {
    const a = byNumber.get(q.n)
    if (!a || a.juste) continue
    out.push({
      n: q.n, famille: q.famille, statement: q.statement, regle: q.regle,
      choix: a.choix, attendu: a.attendu, options: q.options, serieN: serie.n,
    })
  }
  return out
}

/* ---------------------------------------------------------------- writing */

export function writeState(state) {
  return serial(() => files().write(vaultPath(STATE), stateText(state)))
}

/** The one field that changes on its own: read and write inside one link of the chain. */
export function setEnCours(en_cours) {
  return serial(async () => {
    const state = await readState()
    state.en_cours = en_cours || null
    await files().write(vaultPath(STATE), stateText(state))
    return state
  })
}

/** One line, written the moment it is true. Never buffered, never rewritten. */
export function appendLog(entry) {
  return serial(() => files().append(vaultPath(LOG), logText(entry)))
}

/**
 * What a completed session does to `state.json`, `bilan.md` and the result file. The first
 * attempt fills the row; a redo only bumps `tentatives`, because the row keeps the first
 * attempt's numbers, and the result file is never rewritten.
 */
export async function record(id, summary, today) {
  const first = await serial(async () => {
    const state = await readState()
    const row = (state.series || {})[id]
    const isFirst = !row || row.statut !== 'fait'
    if (isFirst) {
      const medians = {}
      for (const f of summary.familles) if (f.mediane != null) medians[f.famille] = f.mediane
      state.series[id] = {
        statut: 'fait', tentatives: 1,
        justes: summary.justes, total: summary.total, duree_s: summary.duree_s,
        date: today, mediane_reflexion_ms: medians,
      }
    } else {
      row.tentatives = (Number(row.tentatives) || 1) + 1
    }
    state.en_cours = null
    await files().write(vaultPath(STATE), stateText(state))
    return isFirst
  })
  await writeBilan()
  if (first) await writeResultat(id, summary)
  return { first }
}

/**
 * `bilan.md`, rewritten after every session: what the generator reads to decide what the next
 * series is made of.
 *
 * Only **complete** attempts count, and each question counts **once**. A series counts when
 * the log holds a session line for it; an abandoned run has none. Within a series, the last
 * answer line for a question number is the one that stands, so a redo replaces the first
 * attempt instead of being added to it. Before this rule a four-question series read as seven
 * answers over two families and two runs that were never finished appeared as whole series
 * (ADV-M).
 */
export async function writeBilan() {
  const { answers, sessions } = await readLog()
  const complete = new Set(sessions.map(s => s.serie).filter(Boolean))

  const byKey = new Map()
  for (const a of answers) {
    if (!complete.has(a.serie)) continue
    byKey.set(`${a.serie}/${a.n}`, a)      // append order: the last line stands
  }
  const kept = [...byKey.values()]

  const series = [...new Set(kept.map(a => a.serie))]
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
  const last = series.slice(-5)
  const before = series.slice(-10, -5)
  const recent = kept.filter(a => last.includes(a.serie))
  const older = kept.filter(a => before.includes(a.serie))

  const rows = []
  for (const famille of [...new Set(recent.map(a => a.famille))].sort()) {
    const mine = recent.filter(a => a.famille === famille)
    const was = older.filter(a => a.famille === famille)
    const now = median(mine.map(a => Number(a.reflexion_ms)))
    const then = median(was.map(a => Number(a.reflexion_ms)))
    rows.push({
      famille, mediane: now,
      tendance: now != null && then != null ? now - then : null,
      justes: mine.filter(a => a.juste).length,
      total: mine.length,
    })
  }

  // The log line holds no `regle` (FORMAT-drills.md), and the bilan's miss list is specified
  // to carry one, so the rules are read back out of the series of the window.
  const rules = new Map()
  for (const id of last) {
    const s = await readSerie(id)
    if (!s.ok) continue
    for (const q of s.questions) rules.set(`${id}/${q.n}`, q.regle || '')
  }

  const out = []
  out.push('# Bilan des automatismes')
  out.push('')
  out.push(`Écrit par le plugin Maths le ${frenchDate()}. Fenêtre : ${last.length ? last.join(', ') : 'aucune série'}.`)
  out.push('')
  out.push('| famille | médiane | tendance | justes | total | précision |')
  out.push('| --- | --- | --- | --- | --- | --- |')
  for (const row of rows) {
    const trend = row.tendance == null
      ? '—'
      : `${row.tendance > 0 ? '+' : row.tendance < 0 ? '−' : '±'}${think(Math.abs(row.tendance))}`
    const accuracy = row.total ? `${Math.round((row.justes / row.total) * 100)} %` : '—'
    out.push(`| ${row.famille} | ${think(row.mediane)} | ${trend} | ${row.justes} | ${row.total} | ${accuracy} |`)
  }
  if (!rows.length) out.push('| — | — | — | — | — | — |')
  out.push('')
  out.push('## Erreurs de la fenêtre')
  out.push('')
  const misses = recent.filter(a => !a.juste)
  if (!misses.length) out.push('Aucune.')
  for (const miss of misses.sort(byNumber)) {
    const regle = rules.get(`${miss.serie}/${miss.n}`) || miss.regle || '—'
    out.push(`- ${miss.serie} · ${miss.n} · ${miss.famille} · attendu ${miss.attendu} · choisi ${miss.choix} · ${regle}`)
  }
  out.push('')
  return serial(() => files().write(vaultPath(BILAN), out.join('\n')))
}

const byNumber = (a, b) =>
  String(a.serie).localeCompare(String(b.serie), undefined, { numeric: true }) || a.n - b.n

/**
 * `.math/serie-NN-resultat.md`, written once, for the first attempt only. A second attempt
 * leaves the file alone, the way the row keeps the first attempt's numbers. It is the plugin's
 * own writing, so it lives in the plugin's own folder, beside the log and the state.
 */
export function writeResultat(id, summary) {
  const out = []
  out.push(`# Série ${summary.n} · ${summary.justes}/${summary.total} · ${duration(summary.duree_s)}`)
  out.push('')
  for (const row of summary.familles) {
    out.push(`- ${row.famille} · ${row.justes}/${row.total} · médiane ${think(row.mediane)}`)
  }
  out.push('')
  out.push('## Erreurs')
  out.push('')
  if (!summary.misses.length) out.push('Aucune.')
  for (const miss of summary.misses) {
    out.push(`- ${miss.n} · ${miss.famille} · attendu ${miss.attendu} · choisi ${miss.choix} · ${miss.regle || '—'}`)
  }
  out.push('')
  return serial(() => files().write(vaultPath(resultatFile(id)), out.join('\n')))
}

/**
 * The temp files an interrupted atomic write leaves behind. Two overlapping writes of
 * `state.json` used to race the host's rename and strand a `.state.json.27352.13.tmp` in the
 * vault for ever (ADV-M). The chain above means it cannot happen again; this takes away the
 * ones that already did. Once, from `activate`, and never loud: a vault with none is the
 * normal case.
 */
export async function sweepTemp() {
  try {
    const rows = await files().list(vaultPath(DOT))
    for (const row of rows) {
      if (row.kind !== 'file' || !/^\..+\.tmp$/.test(row.name)) continue
      try { await files().trash(vaultPath(`${DOT}/${row.name}`)) } catch { /* it is gone */ }
    }
  } catch { /* no .math yet */ }
}
