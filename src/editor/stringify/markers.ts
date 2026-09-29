// Part of the serializer (../stringify.ts). The file's own markers: bullets, numbers and rules
// written as the file wrote them.

import { fenceTracker } from './cleanup.ts';

// ---------------------------------------------------------------------------
// The file's own markers (M12).
//
// remark writes one spelling of each construct — `-` bullets, `1.` numbers, `---` rules,
// backtick fences, two-space nesting — and STRINGIFY_OPTIONS picks the spellings Hassan's
// files use. A file written the other way (a `*` list, a `~~~` fence, four-space nesting)
// keeps its own bytes wherever it is untouched, because that is a block that matched; the
// block the user edited is the one that would come back in the house style. So an edited
// block is put back in the style of the file it lives in, and verified like everything else.

const DEFAULT_STYLE = { bullet: '-', ordered: '.', rule: '---', fence: '`', indent: 2, quote: '> >' };

/** The marker run of a quoted line: the indent, then the `>`s and the spaces between them. */
const QUOTE_RUN = /^( {0,3})((?:>[ \t]?)+)/;

/** What this file is written with. Only what the serialiser would otherwise override. */
export function detectStyle(text) {
  const style = { ...DEFAULT_STYLE };
  const lines = String(text).split('\n');
  const fence = fenceTracker();
  let seenBullet = false;
  let seenIndent = false;
  let seenQuote = false;
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const inFence = fence(line);
    if (f) { style.fence = f.charAt(0); continue; }
    if (inFence) continue;
    // A frame is `>>` in this vault and `> >` in remark's output (M25). The file decides.
    const quote = QUOTE_RUN.exec(line)?.[2];
    if (quote && !seenQuote && (quote.match(/>/g) || []).length > 1) {
      style.quote = /^>>/.test(quote) ? '>>' : '> >';
      seenQuote = true;
    }
    const rule = /^\s{0,3}((?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.exec(line)?.[1];
    if (rule) { style.rule = rule.trimEnd(); continue; }
    const [, lead = '', marker = ''] = /^([ \t]*)([-*+]|\d+[.)])[ \t]/.exec(line) || [];
    if (!marker) continue;
    if (/[-*+]/.test(marker) && !seenBullet) { style.bullet = marker; seenBullet = true; }
    if (/\d/.test(marker)) style.ordered = marker.slice(-1);
    if (lead && !seenIndent) { style.indent = lead.replace(/\t/g, '    ').length; seenIndent = true; }
  }
  return style;
}

const isDefaultStyle = (s) =>
  s.bullet === '-' && s.ordered === '.' && s.rule === '---' && s.fence === '`' && s.indent === 2
  && s.quote === '> >';

/** One block rewritten in `style`. Idempotent on lines that are already in it. */
export function applyStyle(text, style) {
  if (!style || isDefaultStyle(style)) return text;
  const fence = fenceTracker();
  return text.split('\n').map((line) => {
    const f = /^\s{0,3}(`{3,})/.exec(line);
    const inFence = fence(line);
    if (f && style.fence === '~') return line.replace(/`/g, '~');
    if (inFence) return line;
    if (/^\s{0,3}-{3,}\s*$/.test(line)) return style.rule;
    let out = line;
    // `>>` is one construct written two ways, and remark writes the other one. A file that
    // frames a theorem with `>>` keeps `>>` on the line the user edited as well (M25).
    if (style.quote === '>>') {
      out = out.replace(QUOTE_RUN, (m, ind, marks) => {
        const n = (marks.match(/>/g) || []).length;
        return n > 1 ? ind + '>'.repeat(n) + (/[ \t]$/.test(marks) ? ' ' : '') : m;
      });
    }
    // Only remark's own two-space nesting is rescaled, and only in a block with no original to
    // read the indent off (`restoreLinesIn` does that better). Three spaces is what an ordered
    // list's continuation gets, and scaling it would land between two levels.
    if (style.indent !== 2) {
      out = out.replace(/^ +/, (m) => (m.length % 2 ? m : ' '.repeat((m.length / 2) * style.indent)));
    }
    // Two lists side by side are told apart by their markers alone: remark writes the second one
    // with `bulletOther` (`*`) or `)`. Where the file's own marker is that other one, the two
    // trade places, so the lists stay two lists instead of both becoming the file's marker.
    if (style.bullet !== '-') {
      out = out.replace(/^([ \t]*)([-*])([ \t])/, (_m, ind, b, sp) =>
        `${ind}${b === '-' ? style.bullet : (style.bullet === '*' ? '-' : b)}${sp}`);
    }
    if (style.ordered !== '.') {
      out = out.replace(/^([ \t]*\d+)([.)])([ \t])/, (_m, n, d, sp) => `${n}${d === '.' ? style.ordered : '.'}${sp}`);
    }
    return out;
  }).join('\n');
}

/**
 * A heading written `Text` over `-----` is a setext H2, and `setext: false` turns it into
 * `## Text` — deleting a line of the file to gain one it never had (M2). When the block that
 * was a setext heading comes back as an ATX heading of the same level, put it back.
 */
export function keepSetext(next, prev) {
  const a = prev.split('\n');
  if (a.length !== 2) return next;
  const rule = a[1].match(/^\s{0,3}(=+|-+)\s*$/);
  if (!rule || /^\s{0,3}(?:#{1,6}\s|[-*+>]\s|\|)/.test(a[0]) || !a[0].trim()) return next;
  const atx = next.match(/^(#{1,6})[ \t]+(.*)$/);
  if (!atx || atx[1].length !== (rule[1][0] === '=' ? 1 : 2)) return next;
  return atx[2] + '\n' + a[1];
}
