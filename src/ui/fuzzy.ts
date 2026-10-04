// The fuzzy matcher every quick list ranks with (the palette, search, the page picker), so
// they all agree on what "matches" means, and the highlight of the letters it matched.
import { esc } from './html.ts';

const START = /[\s/\\._\-]/;

/** null when q is not a subsequence of text; otherwise {score, hits:Set<index>}. */
export function fuzzy(text, q) {
  if (!q) return { score: 0, hits: null };
  const t = text.toLowerCase(), n = t.length, m = q.length;
  if (m > n) return null;
  const hits: any[] = [];
  let ti = 0, score = 0, streak = 0;
  for (let qi = 0; qi < m; qi++) {
    const c = q[qi];
    let found = -1;
    for (let i = ti; i < n; i++) { if (t[i] === c) { found = i; break; } }
    if (found < 0) return null;
    const gap = found - ti;
    const wordStart = found === 0 || START.test(t[found - 1]) || (text[found] >= 'A' && text[found] <= 'Z' && text[found - 1] >= 'a');
    if (found === ti && qi > 0) { streak += 1; score += 8 + streak * 2; }
    else { streak = 0; score += wordStart ? 10 : 2; score -= Math.min(gap, 12) * 0.4; }
    if (wordStart) score += 4;
    hits.push(found);
    ti = found + 1;
  }
  score -= (n - m) * 0.08;
  return { score, hits: new Set(hits) };
}

/** The matched characters wrapped in <b>. Escapes as it goes; safe for innerHTML. */
export function highlight(text, hits) {
  if (!hits || !hits.size) return esc(text);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = esc(text[i]);
    out += hits.has(i) ? `<b>${ch}</b>` : ch;
  }
  return out;
}
