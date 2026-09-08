// Inbound links: which pages link to a file, and rewriting those links when the file moves
// (CONTRACT.md batch 9, C13). A rename or a move in the tree used to leave every `](href)`
// pointing at the old path; the page column then opened "page not found" from a link that
// was right a minute ago. Finding them is a vault search on the file's name; each hit is
// confirmed by parsing the linking file and resolving the href the way the editor does
// (editor/paths.js resolveHref), so a page that merely mentions the name is left alone.
//
// Fidelity: only the bytes of a confirmed href change. The rest of the file, its line endings
// and its trailing newline are untouched, because the text is spliced in place, never split
// and rejoined. Nothing here touches the DOM.

import { bridge } from '../bridge/index.js';
import { resolveHref, relativeHref, basename } from '../editor/paths.js';

// Room for a common name: the confirm step throws the false hits away, but a hit list cut at
// the limit would silently lose real links.
const SEARCH_LIMIT = 5000;

const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * The name a link to `path` has to contain, in the two spellings the app writes: as typed,
 * and with the characters a markdown href cannot carry escaped (`%20` for a space; sidebar.js
 * linkUrl and editor/paths.js relativeHref agree on every character that matters here). A
 * page's `.md` is dropped so the name is a substring of both `Note.md` and `Note`.
 */
function needlesFor(path) {
  const base = basename(path).replace(/\.md$/i, '');
  const escaped = encodeURIComponent(base).replace(/%2F/gi, '/');
  return escaped === base ? [base] : [base, escaped];
}

/**
 * Every `](href)` in `text`: the href's start and end offsets, the href itself, and the
 * `#fragment` or `?query` tail resolveHref would drop. A destination in angle brackets is
 * read inside the brackets; a title after the destination is left where it is.
 */
function linkSpans(text) {
  const out = [];
  const re = /\]\(\s*(<[^>\n]*>|[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1];
    const angled = raw.startsWith('<');
    const start = m.index + m[0].length - raw.length + (angled ? 1 : 0);
    const href = angled ? raw.slice(1, -1) : raw;
    const tailAt = href.search(/[#?]/);
    out.push({
      start,
      end: start + href.length,
      href: tailAt < 0 ? href : href.slice(0, tailAt),
      tail: tailAt < 0 ? '' : href.slice(tailAt),
    });
  }
  return out;
}

/** The files (by their current path) that a search for any of `needles` turns up. */
async function candidates(needles) {
  const paths = new Set();
  for (const q of needles) {
    const hits = await bridge.search(q, { limit: SEARCH_LIMIT });
    for (const h of Array.isArray(hits) ? hits : []) if (h && h.path) paths.add(clean(h.path));
  }
  return [...paths];
}

/**
 * The pages that link to `targetPath`, with how many links each carries.
 * -> [{ path, count }], most links first. Throws only when the search itself fails.
 */
export async function findInbound(targetPath) {
  const target = clean(targetPath);
  const out = [];
  for (const path of await candidates(needlesFor(target))) {
    let text;
    try { text = await bridge.readText(path); } catch { continue; }
    let count = 0;
    for (const span of linkSpans(text)) if (resolveHref(path, span.href) === target) count++;
    if (count) out.push({ path, count });
  }
  out.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return out;
}

/**
 * Rewrite every link into any of `pairs` ([{ from, to }], vault paths, the files already
 * moved on disk) so it points at the new place. A folder move is passed one pair per file
 * under it, and a file that links to three of them is read and written once, not three times.
 *
 * A moved file is found at its new path, so its own hrefs are resolved against its old path
 * (that is what they were written against) and rewritten relative to the new one; a link
 * from one moved file to another, still right after the move, comes out unchanged and is not
 * counted. `bridge.writeText` failures are collected, not thrown.
 * -> { files, links, failed: [path] }
 */
export async function rewriteInboundMany(pairs) {
  const moves = (pairs || [])
    .map((p) => ({ from: clean(p.from), to: clean(p.to) }))
    .filter((p) => p.from && p.to && p.from !== p.to);
  const res = { files: 0, links: 0, failed: [] };
  if (!moves.length) return res;

  const toFor = new Map(moves.map((p) => [p.from, p.to]));
  const fromFor = new Map(moves.map((p) => [p.to, p.from]));
  const needles = [...new Set(moves.flatMap((p) => needlesFor(p.from)))];

  for (const path of await candidates(needles)) {
    let text;
    try { text = await bridge.readText(path); } catch { continue; }
    // The hrefs in a file were written relative to where it was; `was` is that place.
    const was = fromFor.get(path) || path;
    const edits = [];
    for (const span of linkSpans(text)) {
      const target = resolveHref(was, span.href);
      if (target === null) continue;
      const to = toFor.get(target);
      if (!to) continue;
      const next = relativeHref(path, to) + span.tail;
      if (next === span.href + span.tail) continue;
      edits.push({ start: span.start, end: span.end, next });
    }
    if (!edits.length) continue;
    // Splice from the end so earlier offsets stay valid; nothing outside the spans moves.
    let out = text;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.next + out.slice(e.end);
    try {
      await bridge.writeText(path, out);
      res.files++;
      res.links += edits.length;
    } catch (e) {
      console.error('[links] write', path, e);
      res.failed.push(path);
    }
  }
  return res;
}

/** One file, already moved from `from` to `to`. The editor's rename will call this. */
export function rewriteInbound(from, to) {
  return rewriteInboundMany([{ from, to }]);
}
