// The three-way merge of a change made on disk into a page being edited (wave 2, H7).
//
// A page that is dirty when another program writes its file used to hold a conflict and ask,
// on the next save, which of the two texts to throw away. Most of the time nothing needs to be
// thrown away: the user typed in one part of the note and the other program (a sync client, an
// agent, a second editor) wrote another. Both changes are made against the same text — the one
// the page was opened from or last wrote, which the page keeps as its baseline — so they can be
// laid over each other line by line, and only where both touched the same lines is there a
// question to ask.
//
// Lines are compared with their line endings attached, so a merged text keeps each line's own
// ending: a CRLF file stays CRLF where it was, and a line that came from the other side keeps
// whatever that side wrote. Nothing is normalised. Pure: no DOM, no `ose`, so the tests import
// it as it is.

import { diff3Merge } from 'node-diff3';

/**
 * `text` cut into lines, each with its own terminator (`\r\n`, `\n` or a lone `\r`); the last
 * line has none when the text does not end in one. Joining the result gives `text` back.
 */
export function splitLines(text: string): string[] {
  const s = String(text ?? '');
  const out: any[] = [];
  const re = /\r\n|\r|\n/g;
  let at = 0;
  let m;
  while ((m = re.exec(s))) {
    out.push(s.slice(at, re.lastIndex));
    at = re.lastIndex;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

/** The ending most of `text`'s lines use, for a line that has to be given one. */
function usualEnding(text) {
  const s = String(text ?? '');
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** `lines` joined, with a terminator put on a last line that lacks one when more follows. */
function joinParts(parts, eol) {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    if (out && !/[\r\n]$/.test(out)) out += eol;
    out += p;
  }
  return out;
}

/**
 * Merge `theirs` (the disk) into `ours` (the buffer), both edited from `base`.
 *
 * Clean: `{ clean: true, text }`, the two sets of changes laid over each other.
 * Overlap: `{ clean: false, text: ours, conflicts }`, the buffer unchanged, and for every region
 * both sides changed, what each side and the base hold there (`ours`, `theirs`, `base`, as
 * text) and `at`, the 0-based line of `ours` where it begins. Two sides that made the very same
 * change are not a conflict.
 */
export function merge3(base: string, ours: string, theirs: string): { clean: true; text: string; } | { clean: false; text: string; conflicts: Array<{ ours: string; theirs: string; base: string; at: number; }>; } {
  const b = String(base ?? '');
  const o = String(ours ?? '');
  const t = String(theirs ?? '');
  if (o === t) return { clean: true, text: o };
  if (b === o) return { clean: true, text: t };
  if (b === t) return { clean: true, text: o };
  const regions = diff3Merge(splitLines(o), splitLines(b), splitLines(t), { excludeFalseConflicts: true });
  const eol = usualEnding(o);
  const parts: any[] = [];
  const conflicts: any[] = [];
  for (const r of regions) {
    if (r.ok) { parts.push(r.ok.join('')); continue; }
    const c = r.conflict;
    if (!c) continue;
    conflicts.push({ ours: c.a.join(''), theirs: c.b.join(''), base: c.o.join(''), at: c.aIndex });
  }
  if (conflicts.length) return { clean: false, text: o, conflicts };
  return { clean: true, text: joinParts(parts, eol) };
}

/**
 * The merge with every overlap settled by keeping both sides: the buffer's lines, then the
 * disk's, with no markers in between. What "Keep both" in the resolve view writes into the
 * buffer, for the user to tidy by hand; nothing either side wrote is lost.
 */
export function keepBoth(base: string, ours: string, theirs: string): string {
  const b = String(base ?? '');
  const o = String(ours ?? '');
  const t = String(theirs ?? '');
  if (o === t || b === t) return o;
  if (b === o) return t;
  const regions = diff3Merge(splitLines(o), splitLines(b), splitLines(t), { excludeFalseConflicts: true });
  const eol = usualEnding(o);
  const parts: any[] = [];
  for (const r of regions) {
    if (r.ok) { parts.push(r.ok.join('')); continue; }
    // Lines both sides agree on at the edges of the region are written once, not twice.
    if (!r.conflict) continue;
    const a = r.conflict.a;
    const b = r.conflict.b;
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    parts.push(
      a.slice(0, head).join(''),
      a.slice(head, a.length - tail).join(''),
      b.slice(head, b.length - tail).join(''),
      a.slice(a.length - tail).join(''),
    );
  }
  return joinParts(parts, eol);
}
