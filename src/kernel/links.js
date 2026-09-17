// Inbound links: which pages link to a file, and rewriting those links when the file moves. A
// rename or a move in the tree used to leave every `](href)` pointing at the old path; the
// page column then opened "page not found" from a link that was right a minute ago. Finding
// them is a vault search on the file's name; each hit is confirmed by parsing the linking file
// and resolving the href the way the editor does (editor/paths.js resolveHref), so a page that
// merely mentions the name is left alone.
//
// Fidelity: only the bytes of a confirmed href change. The rest of the file, its line endings
// and its trailing newline are untouched, because the text is spliced in place, never split
// and rejoined. Nothing here touches the DOM.

import { bridge } from './bridge/index.js';
import { resolveHref, relativeHref, basename } from './href.js';

// A rename has to find *every* inbound link, so this pass is the one search that runs with no
// cap at all (N20; `limit: 0` means "no cap" in both bridges). The confirm step throws the
// false hits away; a hit list cut at a limit would silently lose real links and the toast
// would then report a count that is not the truth.
const SEARCH_LIMIT = 0;

const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * Keep the text a rewrite is about to replace (batch 12, "Versions"). This is the only write
 * in the app that edits files the user is not looking at, and a folder move can touch hundreds
 * of them at once: with no version kept, a regex that misfires misfires everywhere and nothing
 * can get any of it back. Same shape as `editor/versions.js keepVersion` — swallowed and
 * logged, never a precondition for the write — and inlined rather than imported, because
 * `lib/` does not depend on `editor/` for anything but the pure path helpers above.
 */
async function keep(path, previous) {
  if (!path || !previous) return;
  try {
    await bridge.versionKeep(path, previous, true);
  } catch (e) {
    // An old host has no `versionKeep`; a full disk has no room. Neither stops the rewrite.
    console.warn('[links] version not kept', path, e && e.message ? e.message : e);
  }
}

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
  const push = (start, href) => {
    const tailAt = href.search(/[#?]/);
    out.push({
      start,
      end: start + href.length,
      href: tailAt < 0 ? href : href.slice(0, tailAt),
      tail: tailAt < 0 ? '' : href.slice(tailAt),
    });
  };
  // One pass over the lines does two things: it marks the fenced code blocks, and it takes the
  // reference definitions (N18) — `[ref]: path "optional title"`, at the start of a line, up to
  // three spaces of indent. Only the destination is a span; the label and the title are not
  // touched. Nothing inside a fence is a link at all: a path in a code sample is documentation
  // (QA F15 — the inline scan below used to be the one half of this function that ignored that,
  // so a rename rewrote `[a](old.md)` inside a ``` block).
  const lines = text.split('\n');
  const fenced = [];                                  // [start, end) offsets of fenced blocks
  let at = 0;
  let fence = null;
  let fenceFrom = 0;
  for (const line of lines) {
    const f = /^[ \t]{0,3}(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) { fence = f[1][0]; fenceFrom = at; }
      else if (line.trim().startsWith(fence)) { fence = null; fenced.push([fenceFrom, at + line.length + 1]); }
    } else if (!fence) {
      const d = /^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)/.exec(line);
      if (d) {
        const angled = d[2].startsWith('<');
        push(at + d[1].length + (angled ? 1 : 0), angled ? d[2].slice(1, -1) : d[2]);
      }
    }
    at += line.length + 1;
  }
  // An unclosed fence runs to the end of the file, which is how a renderer reads it too.
  if (fence) fenced.push([fenceFrom, text.length]);
  const inFence = (i) => fenced.some(([a, b]) => i >= a && i < b);

  // The inline scan stays one regex over the whole text rather than line by line, because a
  // destination may sit on the line after `](`; the fence ranges above are what keeps it out
  // of code samples.
  const re = /\]\(\s*(<[^>\n]*>|[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)/g;
  let m;
  while ((m = re.exec(text))) {
    if (inFence(m.index)) continue;
    const raw = m[1];
    const angled = raw.startsWith('<');
    push(m.index + m[0].length - raw.length + (angled ? 1 : 0), angled ? raw.slice(1, -1) : raw);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Both search answers: the array older hosts return, and the `{hits}` object of batch 12. */
const hitsOf = (r) => (Array.isArray(r) ? r : Array.isArray(r && r.hits) ? r.hits : []);

/** The files (by their current path) that a search for any of `needles` turns up. */
async function candidates(needles, seed = []) {
  const paths = new Set(seed.map(clean).filter(Boolean));
  for (const q of needles) {
    for (const h of hitsOf(await bridge.search(q, { limit: SEARCH_LIMIT }))) {
      if (h && h.path) paths.add(clean(h.path));
    }
  }
  return [...paths];
}

/**
 * The pages that link to `targetPath`, with how many links each carries and where.
 * -> [{ path, count, lines: [{ line, text }] }], most links first; `lines` is 1-based and
 * carries the trimmed source line, which is what the backlinks list shows (N6). Throws only
 * when the search itself fails. A page never counts as linking to itself.
 */
export async function findInbound(targetPath) {
  const target = clean(targetPath);
  const out = [];
  for (const path of await candidates(needlesFor(target))) {
    if (path === target) continue;
    let text;
    try { text = await bridge.readText(path); } catch { continue; }
    const starts = lineStarts(text);
    const lines = [];
    for (const span of linkSpans(text)) {
      if (resolveHref(path, span.href) !== target) continue;
      const n = lineAt(starts, span.start);
      const last = lines[lines.length - 1];
      if (last && last.line === n) continue;   // two links on one line are one row
      lines.push({ line: n, text: (text.split('\n')[n - 1] || '').trim().slice(0, 240) });
    }
    if (lines.length) out.push({ path, count: lines.length, lines });
  }
  out.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return out;
}

/** Offsets every line of `text` starts at, so a span offset can be turned into a line number. */
function lineStarts(text) {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1);
  return out;
}

/** 1-based line holding `offset`, by binary search over `lineStarts`. */
function lineAt(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Rewrite every link into any of `pairs` ([{ from, to }], vault paths, the files already
 * moved on disk) so it points at the new place. A folder move is passed one pair per file
 * under it, and a file that links to three of them is read and written once, not three times.
 *
 * A moved file is found at its new path, so its own hrefs are resolved against its old path
 * (that is what they were written against) and rewritten relative to the new one; a link
 * from one moved file to another, still right after the move, comes out unchanged and is not
 * counted. `bridge.writeText` failures are collected, not thrown. Every file that is about to
 * be rewritten has its current text kept as a version first (`keep` above): this is the one
 * write with no undo, no dirty flag and no baseline check.
 *
 * N16: a moved file's hrefs that point *outside* the move set are rewritten too. `[x](other.md)`
 * in a page moved from a subfolder to the root used to be left as written and then resolved
 * against the root, where `other.md` is not; an `attachments/` image src broke the same way.
 * Those files are read whether or not the name search turned them up, because a page need not
 * mention its own name to hold links written from where it used to be.
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

  for (const path of await candidates(needles, moves.map((m) => m.to))) {
    let text;
    try { text = await bridge.readText(path); } catch { continue; }
    // The hrefs in a file were written relative to where it was; `was` is that place.
    const was = fromFor.get(path) || path;
    const moved = was !== path;
    const edits = [];
    for (const span of linkSpans(text)) {
      const target = resolveHref(was, span.href);
      if (target === null) continue;
      // An href with no scheme that starts with `/` is vault-root-relative: it means the same
      // file wherever the page lands, so moving the page must not rewrite it.
      if (!moved && span.href.trim().startsWith('/')) continue;
      const to = toFor.get(target);
      // Outside the move set: only a file that moved needs its own hrefs rewritten, and only
      // to say the same thing from the new folder.
      if (!to && !moved) continue;
      if (!to && span.href.trim().startsWith('/')) continue;
      const next = relativeHref(path, to || target) + span.tail;
      if (next === span.href + span.tail) continue;
      edits.push({ start: span.start, end: span.end, next });
    }
    if (!edits.length) continue;
    // Splice from the end so earlier offsets stay valid; nothing outside the spans moves.
    let out = text;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.next + out.slice(e.end);
    try {
      await keep(path, text);
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
