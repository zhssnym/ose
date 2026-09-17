/* The maths, and the markdown-lite around it.
 *
 * A statement and an option are not markdown. They are paragraphs, `$…$` inline and `$$…$$`
 * display, and text everywhere else — text that becomes a text node and never a string of
 * markup. Temml builds its MathML as DOM nodes through `render(latex, node, opts)`, so no
 * `innerHTML` is spoken anywhere in this plugin, and a `$` that never closes stays a `$`.
 *
 * Temml is imported here, once, rather than handed in through an adapter: the portal layer
 * that made that necessary is gone (ADV-B), and the vendored file is this plugin's own.
 */

import { h, append } from '../../_lib/drills.js'
import temml from '../vendor/temml.mjs'

/**
 * One run of text cut into its pieces: plain text, inline maths, display maths.
 * `\$` is a dollar sign and not a delimiter.
 */
export function pieces(text) {
  const out = []
  const source = String(text ?? '')
  let buffer = ''
  let i = 0
  const flush = () => { if (buffer) { out.push({ text: buffer }); buffer = '' } }
  while (i < source.length) {
    const c = source[i]
    if (c === '\\' && source[i + 1] === '$') { buffer += '$'; i += 2; continue }
    if (c === '$') {
      const display = source[i + 1] === '$'
      const mark = display ? '$$' : '$'
      const from = i + mark.length
      const close = source.indexOf(mark, from)
      // An inline `$` must close on its own line; an unclosed one is a dollar sign.
      const latex = close > from ? source.slice(from, close) : null
      if (latex !== null && (display || !latex.includes('\n'))) {
        flush()
        out.push({ latex, display })
        i = close + mark.length
        continue
      }
    }
    buffer += c
    i += 1
  }
  flush()
  return out
}

/** One piece of LaTeX as a node. A piece Temml refuses keeps its source, marked. */
export function mathNode(latex, display) {
  const box = h('span', { class: 'maths-tex' + (display ? ' display' : '') })
  try {
    temml.render(String(latex), box, { displayMode: !!display, wrap: 'none' })
  } catch (err) {
    box.className = 'maths-tex bad'
    box.title = String((err && err.message) || err)
    box.textContent = (display ? '$$' : '$') + latex + (display ? '$$' : '$')
  }
  return box
}

/** A single line — an option, a miss's line — as a span with its maths in place. */
export function inlineNode(text, className) {
  const span = h('span', { class: className || 'maths-line' })
  for (const piece of pieces(text)) {
    if (piece.text != null) append(span, piece.text)
    else span.appendChild(mathNode(piece.latex, piece.display))
  }
  return span
}

/**
 * A statement: paragraphs separated by a blank line, each one a `<p>` with its inline maths,
 * and a paragraph that is nothing but display maths standing on its own instead.
 */
export function statementNode(text, className) {
  const box = h('div', { class: className || 'maths-statement' })
  for (const paragraph of String(text ?? '').split(/\n[ \t]*\n/)) {
    const body = paragraph.trim()
    if (!body) continue
    const parts = pieces(body)
    if (parts.length === 1 && parts[0].display) {
      box.appendChild(mathNode(parts[0].latex, true))
      continue
    }
    const p = h('p', { class: 'maths-p' })
    for (const piece of parts) {
      if (piece.text != null) append(p, piece.text)
      else p.appendChild(mathNode(piece.latex, piece.display))
    }
    box.appendChild(p)
  }
  if (!box.childElementCount) box.appendChild(h('p', { class: 'maths-p' }, String(text ?? '')))
  return box
}
