/* What a finished series looks like. One block, filled two ways: from the summary a session
   just produced, and from `state.json` plus the log when the page is opened again later.

   The chrome is English (`family`, `questions`, `correct`, `median`, `missed`, `chosen`,
   `expected`); `Série N` stays, because it is the file's own heading and file content is never
   translated. The misses are separated by air and nothing else — they used to be fifty-seven
   bordered boxes in an eleven-thousand-pixel ladder (ADV-V). */

import { h, duration, paneLabel } from '../../_lib/drills.js'
import { statementNode, inlineNode } from './math.js'
import { think } from './fmt.js'

/**
 * @param {object} data
 *   pause_s                     optional, printed only when there was one
 *   familles [{ famille, mediane, justes?, total? }]   four columns when the counts are there
 *   misses   [{ n, famille, choix, attendu, regle, options }]
 *   note     optional, the quiet first line (`2 attempts · done 2026-09-16`)
 *
 * The score is not here: it is the figure of the `.drill-verdict` the page draws under its
 * control band, which is the one place both plugins say how it went (Q1). A second score in a
 * second face under the H1 was the thing ADV-V called a second 34 px face.
 */
export function resultBlock(data) {
  const root = h('div', { class: 'maths-result' })

  if (data.note) root.appendChild(h('p', { class: 'maths-note mono-sm' }, data.note))
  if (data.pause_s) {
    root.appendChild(h('p', { class: 'maths-note mono-sm' },
      `pause ${duration(data.pause_s)}, outside the clock`))
  }

  const familles = data.familles || []
  if (familles.length) {
    const counted = familles.some(row => row.total != null)
    const table = h('table', { class: 'table maths-table' })
    table.appendChild(h('thead', {}, h('tr', {},
      h('th', {}, 'family'),
      counted ? h('th', {}, 'questions') : null,
      counted ? h('th', {}, 'correct') : null,
      h('th', {}, 'median'))))
    const body = h('tbody')
    for (const row of familles) {
      body.appendChild(h('tr', {},
        h('td', {}, row.famille),
        counted ? h('td', { class: 'mono-sm' }, String(row.total)) : null,
        counted ? h('td', { class: 'mono-sm' }, `${row.justes}/${row.total}`) : null,
        h('td', { class: 'mono-sm' }, think(row.mediane))))
    }
    table.appendChild(body)
    root.appendChild(table)
  }

  const misses = data.misses || []
  root.appendChild(paneLabel(misses.length ? `${misses.length} missed` : 'nothing missed'))
  for (const miss of misses) root.appendChild(missNode(miss))
  return root
}

/** One miss: the number, the family, what was chosen, what was expected, and the rule. */
export function missNode(miss) {
  const box = h('div', { class: 'maths-miss' })
  box.appendChild(h('div', { class: 'maths-miss-head mono-sm' },
    h('span', { class: 'maths-miss-n' }, String(miss.n)), ' · ', String(miss.famille)))
  box.appendChild(statementNode(miss.statement, 'maths-miss-statement'))
  // One grid for the two lines, so `chosen` and `expected` line up without a magic width.
  box.appendChild(h('div', { class: 'maths-miss-lines' },
    h('span', { class: 'maths-miss-label mono-sm' }, 'chosen'),
    inlineNode(optionText(miss, miss.choix), 'maths-chosen'),
    h('span', { class: 'maths-miss-label mono-sm' }, 'expected'),
    inlineNode(optionText(miss, miss.attendu), 'maths-expected')))
  if (miss.regle) box.appendChild(h('p', { class: 'maths-regle' }, miss.regle))
  return box
}

function optionText(miss, letter) {
  const option = (miss.options || []).find(o => o.letter === letter)
  return option ? `${letter}. ${option.text}` : String(letter || '—')
}
