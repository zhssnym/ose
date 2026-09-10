// The quick-open matcher and list builder, in one place because three surfaces use it: the
// palette's Ctrl+P mode, the search overlay's ranking, and `pickPage` in dialog.js (the Link
// slash item and the `page.link` command). Keeping it here is what makes those three agree on
// what "matches" means; it also keeps dialog.js from importing palette.js, which imports it.
import { esc } from '../registry.js';
import { titleOf, dirName } from './paths.js';

const START = /[\s/\\._\-]/;

/** null when q is not a subsequence of text; otherwise {score, hits:Set<index>}. */
export function fuzzy(text, q) {
  if (!q) return { score: 0, hits: null };
  const t = text.toLowerCase(), n = t.length, m = q.length;
  if (m > n) return null;
  const hits = [];
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

/**
 * Rank a list of vault paths against a query, the quick-open way (L26).
 *
 * The query is split on spaces and **every word** must match, each one either the page's title
 * or its path, as a subsequence. That is what makes `zz live` find `2-learning/zz/living.md`:
 * one word from the folder, one from the name, in any order. A match on the title counts
 * double, and recently opened files float up — strongly with an empty query, gently once the
 * user is typing.
 *
 * `titles` (optional) is a `path -> first H1` map: with it the list matches and shows what the
 * page calls itself rather than what its file is called. Without it the file name is the title,
 * which is what every caller had before.
 *
 * `paths` is `allPages()`; `recent` is `recentFiles()`; both come from the caller so this file
 * stays free of imports that would close a cycle.
 * Returns [{ path, title, hint, score, hits, recent }], best first, capped at `limit`.
 */
export function pageItems(paths, query, { recent = [], limit = 200, titles = null } = {}) {
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rank = new Map(recent.map((p, i) => [p, i]));
  const out = [];
  for (const p of paths) {
    const title = (titles && titles.get(p)) || titleOf(p);
    const lowPath = p.toLowerCase();
    const lowTitle = title.toLowerCase();
    let score = 0;
    let hits = null;
    let ok = true;
    for (const w of words) {
      const inTitle = fuzzy(lowTitle, w);
      const inPath = fuzzy(lowPath, w);
      if (!inTitle && !inPath) { ok = false; break; }
      score += Math.max(inTitle ? inTitle.score * 2 : -Infinity, inPath ? inPath.score : -Infinity);
      // Only the title's matched characters are drawn bold, because the title is the only
      // part of the row a highlight can land on.
      if (inTitle && inTitle.hits) hits = hits ? new Set([...hits, ...inTitle.hits]) : inTitle.hits;
    }
    if (!ok) continue;
    const r = rank.has(p) ? rank.get(p) : 999;
    out.push({
      path: p,
      title,
      hint: dirName(p),
      score: score + (r < 999 ? (40 - r) * (words.length ? 0.4 : 1) : 0),
      hits,
      recent: r < 999,
    });
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return out.slice(0, limit);
}
