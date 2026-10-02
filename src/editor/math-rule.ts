// What makes a `$` a formula, on one line: the pandoc rule of math.ts, kept apart from Temml
// and the CSS so that the serializer (stringify.ts) and the headless engine the tests run can
// import it without a DOM (docs/CORE.md, the editor). math.ts re-exports all three.
//
// One line, as the parser sees it.
//
// stringify.ts has to undo the escapes remark writes without touching a formula, and it works
// line by line. This is the one place that decides what a `$` is on a line, so the serializer's
// clean-up and the parser can never disagree.

/**
 * A line cut into runs: `code` is a code span with its backticks, `math` is an inline formula
 * with its dollars, `text` is everything else. A `\$` is a literal dollar and belongs to the
 * text around it.
 */
export function lineRuns(line: string): Array<{ kind: 'code' | 'math' | 'text'; start: number; end: number; }> {
  const runs: Array<{ kind: 'code' | 'math' | 'text'; start: number; end: number; }> = [];
  const src = String(line);
  let text = 0;
  const flush = (to) => { if (to > text) runs.push({ kind: 'text', start: text, end: to }); };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }                 // `\$` and every other escape
    if (ch === '`') {
      let n = 0;
      while (src[i + n] === '`') n++;
      // A code span closes on a run of exactly the same length; a longer one is passed over.
      let j = i + n;
      let close = -1;
      while (j < src.length) {
        if (src[j] !== '`') { j++; continue; }
        let m = 0;
        while (src[j + m] === '`') m++;
        if (m === n) { close = j; break; }
        j += m;
      }
      // An unclosed run of backticks is not a code span: it is text, and so is what follows.
      if (close < 0) { i += n; continue; }
      flush(i);
      runs.push({ kind: 'code', start: i, end: close + n });
      i = text = close + n;
      continue;
    }
    if (ch === '$') {
      const end = inlineMathEnd(src, i);
      if (end < 0) { i++; continue; }
      flush(i);
      runs.push({ kind: 'math', start: i, end });
      i = text = end;
      continue;
    }
    i++;
  }
  flush(src.length);
  return runs;
}

/**
 * The end of the inline formula that opens at `i` (exclusive, the closing `$` included), or -1
 * when the `$` there opens nothing. The pandoc rule, on one line: a formula never crosses a
 * line break, and `$$` opens nothing at all, so `a $$b$$ c` is text.
 */
export function inlineMathEnd(line, i) {
  const src = String(line);
  if (src[i] !== '$') return -1;
  const first = src[i + 1];
  if (first === undefined || first === '$' || first === ' ' || first === '\t') return -1;
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch !== '$') { j++; continue; }
    const before = src[j - 1];
    const after = src[j + 1];
    if (before !== ' ' && before !== '\t' && !(after !== undefined && after >= '0' && after <= '9')) return j + 1;
    j++;
  }
  return -1;
}

/** `$$` opening a display formula at the start of a line (up to three spaces of indent). */
export const opensDisplay = (line) => /^ {0,3}\$\$/.test(String(line));
