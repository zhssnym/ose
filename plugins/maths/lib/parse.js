/* A series file, the grammar of work/briefs/FORMAT-drills.md, parsed strictly.
 *
 * Strict means: the plugin refuses a file that deviates and names the line. It never rewrites
 * the file and never guesses what was meant — a series that does not parse has no start
 * button and a list of errors with line numbers, which is the fastest way for the generator
 * to be told what it got wrong.
 *
 * The parser is a plain line walk with a cursor. Every error carries the 1-based number of
 * the line it was found on, so the page can print `line 14: …` and the generator can go
 * straight there.
 */

const LETTERS = ['A', 'B', 'C', 'D']

const TITLE = /^# Série (\d+)\s*$/
const HEADER = /^([a-z]+)\s*:\s*(.*)$/
const QUESTION = /^##\s+(\d+)\s+·\s+(\S+)\s*$/
const OPTION = /^-\s([A-D])\.\s+(.+)$/
const REPONSE = /^<!--\s*reponse\s*:\s*([A-D])\s*-->$/
const REGLE = /^<!--\s*regle\s*:\s*(.*?)\s*-->$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * @returns {{ ok: boolean, errors: {line:number, message:string}[],
 *             n:number|null, date:string, duree:number, familles:string[],
 *             questions: {n:number, famille:string, statement:string,
 *                         options:{letter:string, text:string}[],
 *                         reponse:string, regle:string, line:number}[] }}
 */
export function parseSerie(text) {
  const errors = []
  const fail = (line, message) => { errors.push({ line, message }) }
  // The file's endings are its own business: the parser reads either and writes nothing.
  const lines = String(text ?? '').split(/\r\n|\r|\n/)
  const out = { ok: false, errors, n: null, date: '', duree: 0, familles: [], questions: [] }

  const title = TITLE.exec(lines[0] || '')
  if (!title) fail(1, 'the first line must be `# Série N`')
  else out.n = Number(title[1])

  /* ------------------------------------------------------------ the header */

  let i = 1
  const seen = new Map()
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) break
    if (!line.trim()) continue
    const pair = HEADER.exec(line)
    if (!pair) { fail(i + 1, 'the header takes `key: value` lines only, until the first `## `'); continue }
    const [, key, value] = pair
    if (seen.has(key)) fail(i + 1, `\`${key}\` is given twice`)
    seen.set(key, { value: value.trim(), line: i + 1 })
  }

  for (const key of ['date', 'duree', 'familles']) {
    if (!seen.has(key)) fail(1, `the header has no \`${key}\``)
  }
  for (const [key, at] of seen) {
    if (!['date', 'duree', 'familles'].includes(key)) {
      fail(at.line, `\`${key}\` is not a header key (date, duree, familles)`)
    }
  }

  const date = seen.get('date')
  if (date) {
    if (DATE.test(date.value)) out.date = date.value
    else fail(date.line, '`date` must be YYYY-MM-DD')
  }

  const duree = seen.get('duree')
  if (duree) {
    if (/^\d+$/.test(duree.value)) out.duree = Number(duree.value)
    else fail(duree.line, '`duree` must be a whole number of minutes')
  }

  const familles = seen.get('familles')
  if (familles) {
    const list = familles.value.split(',').map(s => s.trim()).filter(Boolean)
    if (!list.length) fail(familles.line, '`familles` must name at least one family')
    for (const slug of list) {
      if (!SLUG.test(slug)) fail(familles.line, `\`${slug}\` is not a family slug (lowercase ASCII, hyphenated)`)
    }
    out.familles = list
  }

  /* --------------------------------------------------------- the questions */

  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue }
    if (!lines[i].startsWith('## ')) {
      fail(i + 1, 'expected a question heading `## <number> · <famille>`')
      i++
      continue
    }
    i = question(lines, i, out, fail)
  }

  if (!out.questions.length) fail(1, 'the file holds no question')

  // The numbers count from 1 with no gaps, and each family is one the header lists.
  out.questions.forEach((q, at) => {
    if (q.n !== at + 1) fail(q.line, `this question is numbered ${q.n}; it is the ${at + 1}${ordinal(at + 1)} and the numbers run from 1 with no gaps`)
    if (out.familles.length && !out.familles.includes(q.famille)) {
      fail(q.line, `\`${q.famille}\` is not in the header's \`familles\``)
    }
  })

  errors.sort((a, b) => a.line - b.line)
  out.ok = errors.length === 0
  return out
}

/** One `## n · famille` block, from its heading to the line after its comments. */
function question(lines, start, out, fail) {
  const head = QUESTION.exec(lines[start])
  if (!head) {
    fail(start + 1, 'a question heading is `## <number> · <famille>`, with a middle dot')
    return skip(lines, start + 1)
  }
  const q = {
    n: Number(head[1]), famille: head[2], statement: '', options: [],
    reponse: '', regle: '', line: start + 1,
  }
  if (!SLUG.test(q.famille)) {
    fail(start + 1, `\`${q.famille}\` is not a family slug (lowercase ASCII, hyphenated)`)
  }

  let i = start + 1
  const body = []
  // The statement runs to the first option, and an option is the first `- A.` line.
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ') || OPTION.test(line) || line.startsWith('<!--')) break
    body.push(line)
  }
  q.statement = body.join('\n').trim()
  if (!q.statement) fail(start + 1, `question ${q.n} has no statement`)

  // Exactly four options, A to D, in order.
  for (const letter of LETTERS) {
    while (i < lines.length && !lines[i].trim()) i++
    const option = OPTION.exec(lines[i] || '')
    if (!option) {
      fail(i + 1, `question ${q.n}: expected the option \`- ${letter}. …\``)
      break
    }
    if (option[1] !== letter) {
      fail(i + 1, `question ${q.n}: the options run A, B, C, D; this one is ${option[1]} where ${letter} was due`)
      break
    }
    q.options.push({ letter, text: option[2].trim() })
    i++
  }
  if (q.options.length === 4) {
    while (i < lines.length && !lines[i].trim()) i++
    if (OPTION.test(lines[i] || '')) fail(i + 1, `question ${q.n} has a fifth option; there are exactly four`)
  }

  // `<!-- reponse: X -->`, then an optional `<!-- regle: … -->`.
  while (i < lines.length && !lines[i].trim()) i++
  const reponse = REPONSE.exec(lines[i] || '')
  if (!reponse) {
    fail(i + 1, `question ${q.n}: expected \`<!-- reponse: X -->\` with one letter of A B C D`)
    // A comment that was meant to be it is eaten here, so one mistake is one error and not
    // two (the trailing scan below would name the same line again).
    if ((lines[i] || '').trim().startsWith('<!--')) i++
  } else { q.reponse = reponse[1]; i++ }

  while (i < lines.length && !lines[i].trim()) i++
  const regle = REGLE.exec(lines[i] || '')
  if (regle) { q.regle = regle[1]; i++ }

  // Whatever is left before the next heading is not part of the grammar.
  for (; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break
    if (!lines[i].trim()) continue
    fail(i + 1, `question ${q.n}: nothing may follow the comments but the next question`)
  }

  out.questions.push(q)
  return i
}

/** Past a block that could not be read, so one bad heading does not make every line an error. */
function skip(lines, from) {
  let i = from
  while (i < lines.length && !lines[i].startsWith('## ')) i++
  return i
}

function ordinal(n) {
  const rest = n % 100
  if (rest >= 11 && rest <= 13) return 'th'
  return ['th', 'st', 'nd', 'rd'][n % 10] || 'th'
}

/** How many questions each family holds, in the order the header names them. */
export function familyCounts(serie) {
  const counts = new Map()
  for (const famille of serie.familles) counts.set(famille, 0)
  for (const q of serie.questions) counts.set(q.famille, (counts.get(q.famille) || 0) + 1)
  return [...counts.entries()].map(([famille, count]) => ({ famille, count }))
}
