/* The one way this plugin talks to the judge: `python -B -m judge.cli` through `ose.run`, one
   JSON object back. Nothing else spawns a process.

   `-B` because the judge lives in the vault, under `.ose/plugins/nsi`, and a vault is plain
   files a person edits: a `__pycache__` of build output has no business there (ADV-B). */

import { ctx, python, dataRoot, absDataRoot } from './ctx.js'

export class JudgeError extends Error {
  constructor(message, kind, detail) {
    super(message)
    this.name = 'JudgeError'
    this.kind = kind || 'error'
    this.detail = detail || ''
  }
}

const STATUS = '@@STATUS '
const START = '@@START '
const STARTUP_GRACE = 5000
const TIMEOUT = 120000

/** Pull the one result object out of stdout: the last line that parses. */
function parseBody(stdout) {
  const lines = String(stdout || '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try { return JSON.parse(line) } catch { /* keep looking */ }
  }
  return null
}

/** Both markers, with or without their trailing space: neither is for a person to read. */
const isMarker = line => line.startsWith(STATUS.trim()) || line.startsWith(START.trim())

/**
 * The last of a stream, as the error panel shows it. `@@START` and `@@STATUS` are the CLI's own
 * protocol lines on stderr; `onLine` filters them out of the lines it keeps, but
 * `result.stderr` is every line the process wrote.
 */
function tail(text, n = 400) {
  const clean = String(text || '').split(/\r?\n/)
    .filter(l => l.trim() && !isMarker(l)).join('\n')
  return clean.length > n ? clean.slice(-n) : clean
}

/**
 * Run one judge command.
 *   judge(['detail', id])                       -> the payload object
 *   judge(['submit', id], { onStatus, input })  -> the payload object
 * Throws JudgeError on a refusal (`ok:false`), a crash, or a timeout.
 */
export async function judge(args, opts = {}) {
  const { ose } = ctx
  // The judge is never run without a folder to run it against. A view or a route has resolved
  // one already, with the element the kernel draws its Choose box into; a command pressed
  // before either was ever opened resolves it here, quietly, and answers one sentence when
  // the vault has no drills folder at all.
  if (!ctx.dataRoot && !await dataRoot()) {
    throw new JudgeError('no drills folder in this vault', 'not_found')
  }
  const timeout = opts.timeout || TIMEOUT
  const argv = ['-B', '-m', 'judge.cli', '--root', absDataRoot(), ...args.map(String)]

  // The result object, as soon as it is printed. A host whose `run` resolves the moment the
  // process starts (rather than when it exits) would otherwise hand back an empty stdout; the
  // one JSON line the CLI prints is the real signal.
  const lines = []
  let sawBody = null
  let started = false
  let announce = null
  const printed = new Promise(resolve => { announce = resolve })

  const runOpts = {
    cwd: ctx.pluginDir,          // the plugin's own folder: `-m judge.cli` resolves from it
    timeout,
    onLine(line, stream) {
      if (stream === 'stderr') {
        if (line.startsWith(START)) { started = true; return }
        if (line.startsWith(STATUS)) {
          started = true
          if (opts.onStatus) {
            try { opts.onStatus(JSON.parse(line.slice(STATUS.length)).text) } catch { /* ignore */ }
          }
          return
        }
        lines.push(line)
      } else {
        lines.push(line)
        const trimmed = line.trim()
        if (!sawBody && trimmed.startsWith('{')) {
          try { sawBody = JSON.parse(trimmed); announce(sawBody) } catch { /* not the one */ }
        }
      }
      if (opts.onLine) opts.onLine(line, stream)
    },
  }
  if (opts.input != null) runOpts.input = opts.input

  let result
  try {
    result = await ose.run(await python(), argv, runOpts)
  } catch (err) {
    throw new JudgeError(String((err && err.message) || err), 'run')
  }

  if (result.timedOut) {
    throw new JudgeError(`the judge took longer than ${Math.round(timeout / 1000)}s`,
      'timeout', tail(result.stderr) || tail(lines.join('\n')))
  }

  let body = parseBody(result.stdout) || sawBody
  if (!body) body = await waitForBody()
  if (!body) body = parseBody(lines.join('\n'))

  async function waitForBody() {
    // `@@START` is the CLI's first line. Without it after a short grace the process never got
    // as far as running: fail now instead of at the timeout.
    const grace = await Promise.race([printed, after(STARTUP_GRACE)])
    if (grace) return grace
    if (!started) return null
    return Promise.race([printed, after(timeout)])
  }
  if (!body) {
    throw new JudgeError(
      result.code === 0 ? 'the judge answered nothing' : `python exited with ${result.code}`,
      'run', tail(result.stderr) || tail(lines.join('\n')) || tail(result.stdout))
  }
  if (!body.ok) throw new JudgeError(body.error || 'refused', body.error_kind, tail(result.stderr))
  return body
}

function after(ms) {
  return new Promise(resolve => setTimeout(() => resolve(null), ms))
}

/* The last listing, so quick open and the row menu can answer without spawning a process.
   Filled by every `list` call, never by `activate`. */
export const cache = { drills: [] }

/** The rows of the last listing, by id. */
export function cachedRow(id) {
  return cache.drills.find(d => d.id === id) || null
}

export const cli = {
  async list() {
    const body = await judge(['list'])
    cache.drills = Array.isArray(body.drills) ? body.drills : []
    return body
  },
  next: () => judge(['next']),
  detail: id => judge(['detail', id]),
  reveal: id => judge(['reveal', id]),
  selfgrade: (id, verdict, duration) =>
    judge(['selfgrade', id, verdict, '--duration', Math.round(duration || 0)]),
  submit(id, { duration, onStatus } = {}) {
    return judge(['submit', id, '--duration', Math.round(duration || 0)], { onStatus })
  },
  // `update` takes a JSON spec on stdin, and the one field it writes is `tags`.
  update: (id, tags) => judge(['update', id], { input: JSON.stringify({ tags }) }),
}
