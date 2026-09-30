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

import { bridge } from './bridge/index.ts';
import { resolveHref, relativeHref, basename } from './href.ts';
import { logLine } from './log.ts';
import { pageHost } from './pagehost.ts';
import { isOutside, isMarkdownPath, isTextPath } from './paths.ts';
import { nfc } from './names.ts';

// A rename has to find *every* inbound link, so this pass is the one search that runs with no
// cap at all, hidden files included (N20; `limit: 0` means "no cap" in both bridges). The
// confirm step throws the false hits away; a hit list cut at a limit would silently lose real
// links and the toast would then report a count that is not the truth.
const SEARCH_LIMIT = 0;

const clean = (p: unknown) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * Two vault paths are one file when they are equal in Unicode form C (M49): a link typed on a
 * Mac may hold `é` decomposed, and the host names files in form C.
 */
const samePath = (a: string | null, b: string | null) => a !== null && b !== null && (a === b || nfc(a) === nfc(b));

/**
 * Keep the text a rewrite is about to replace (batch 12, "Versions"). This is the only write
 * in the app that edits files the user is not looking at, and a folder move can touch hundreds
 * of them at once: with no version kept, a rewrite that misfires misfires everywhere and
 * nothing can get any of it back. Forced, because the host's own keep on a save is tiered and
 * may skip a file it kept a minute ago. Same shape as `editor/versions.js keepVersion` — swallowed and
 * logged, never a precondition for the write — and inlined rather than imported, because
 * `lib/` does not depend on `editor/` for anything but the pure path helpers above.
 */
async function keep(path, previous) {
  if (!path || !previous) return;
  try {
    await bridge.versionKeep(path, previous, { force: true, reason: 'save' });
  } catch (err) {
    const e = (err as { code?: string, message?: string });
    // A full disk has no room for it, a locked history folder no way in: neither stops the rewrite.
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

/** The parser (./mdparse.js), loaded the first time a link is looked for. */
let parserP: any = null;
const parser = () => (parserP ||= import('./mdparse.ts'));

/** Index of the `]` that closes the label opening at `open` (a `[`), or -1. */
function labelEnd(text, open, limit) {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The destination that starts at or after `from` (spaces, tabs and at most one line ending may
 * come first): `{ start, raw }` with `raw` inside the angle brackets when it has them, or null.
 * The rules are CommonMark's link destination: `<…>` with no line ending, or a run with no
 * space or control character whose parentheses balance.
 */
function destinationAt(text, from, limit) {
  let i = from;
  let newlines = 0;
  while (i < limit && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) {
    if (text[i] === '\n' && ++newlines > 1) return null;
    i++;
  }
  if (i >= limit) return null;
  if (text[i] === '<') {
    for (let j = i + 1; j < limit; j++) {
      const ch = text[j];
      if (ch === '\\') { j++; continue; }
      if (ch === '\n' || ch === '\r' || ch === '<') return null;
      if (ch === '>') return { start: i + 1, raw: text.slice(i + 1, j) };
    }
    return null;
  }
  let depth = 0;
  let j = i;
  for (; j < limit; j++) {
    const ch = text[j];
    if (ch === '\\') { j++; continue; }
    if (ch <= ' ') break;
    if (ch === '(') depth++;
    else if (ch === ')') { if (depth === 0) break; depth--; }
  }
  return j > i ? { start: i, raw: text.slice(i, j) } : null;
}

/**
 * Every link destination in `text` (H6): the href's start and end offsets, the href itself,
 * and the `#fragment` or `?query` tail resolveHref would drop. A destination in angle brackets
 * is read inside the brackets; a title after the destination is left where it is.
 *
 * The file is parsed with the parser the editor uses, and only three kinds of node are read:
 * an inline link `[text](dest)`, an image `![alt](src)` and a reference definition
 * `[ref]: dest`. So a link written inside inline code, an indented or fenced code block, an
 * HTML comment or a maths span is text, as the reader of the page sees it, and is never
 * rewritten; the regex this replaces edited all of them in files nobody was looking at. Each
 * destination is found inside its node's own source span, by position, and nothing outside
 * those spans is ever touched. An autolink (`<https://…>`, a bare URL) has no `](` and no
 * destination to rewrite.
 */
export async function linkSpans(text) {
  const { parse, visit } = await parser();
  const out: any[] = [];
  const push = (start, href) => {
    const tailAt = href.search(/[#?]/);
    out.push({
      start,
      end: start + href.length,
      href: tailAt < 0 ? href : href.slice(0, tailAt),
      tail: tailAt < 0 ? '' : href.slice(tailAt),
    });
  };
  // A leading byte order mark is not part of the document the parser sees: its offsets start
  // after it. Parse without it and shift every offset back by one, or every span is off by one
  // and the checks below drop them all (a BOM file's links were never found, never rewritten).
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const body = bom ? text.slice(bom) : text;
  let tree;
  try { tree = parse(body); } catch (err) {
    const e = (err as { code?: string, message?: string });
    // A parser that throws rewrites nothing: better a link left stale than a file edited blind.
    console.warn('[links] parse', e && e.message ? e.message : e);
    return out;
  }
  visit(tree, (node) => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return;
    const pos = node.position;
    if (!pos || !pos.start || !pos.end || typeof pos.start.offset !== 'number') return;
    const a = pos.start.offset + bom;
    const b = pos.end.offset + bom;
    if (node.type === 'definition') {
      // `[label]: dest "title"`, possibly indented: the label, its `:`, then the destination.
      const open = text.indexOf('[', a);
      const close = open < 0 ? -1 : labelEnd(text, open, b);
      if (close < 0 || text[close + 1] !== ':') return;
      const d = destinationAt(text, close + 2, b);
      if (d) push(d.start, d.raw);
      return;
    }
    // `[text](dest)` or `![alt](src)`. A link's label ends where its last child does (that
    // keeps a `]` inside code in the label from being read as the end); an image's alt is
    // not a child, so its label is scanned.
    let close;
    if (node.type === 'link' && Array.isArray(node.children) && node.children.length) {
      const last = node.children[node.children.length - 1];
      close = last.position && typeof last.position.end.offset === 'number' ? last.position.end.offset + bom : -1;
    } else {
      const open = node.type === 'image' ? a + 1 : a;
      close = text[open] === '[' ? labelEnd(text, open, b) : -1;
    }
    if (close < 0 || text[close] !== ']' || text[close + 1] !== '(') return;
    const d = destinationAt(text, close + 2, b);
    if (d) push(d.start, d.raw);
  });
  out.sort((x, y) => x.start - y.start);
  return out;
}

/** The search's `{ hits }` (docs/HOST.md `search`); the host and the core ship together (M47). */
const hitsOf = (r) => (r && Array.isArray(r.hits) ? r.hits : []);

/**
 * The files (by their current path) that a search for any of `needles` turns up. Backlinks read
 * only the text files among them (`isTextPath`, the one list in ./paths.js): a hit in a PDF or
 * an image holds no markdown link. The rewrite edits only markdown files (`isMarkdownPath`).
 */
async function candidates(needles, seed: any[] = []) {
  const paths = new Set<string>(seed.map(clean).filter(Boolean));
  for (const q of needles) {
    for (const h of hitsOf(await bridge.search(q, { limit: SEARCH_LIMIT, hidden: true }))) {
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
  const out: { path: string; count: number; lines: { line: number; text: string; }[]; }[] = [];
  // A file outside the vault has no inbound links: no vault page can link out of the vault.
  if (!target || isOutside(target)) return out;
  for (const path of (await candidates(needlesFor(target))).filter(isTextPath)) {
    if (samePath(path, target) || isOutside(path)) continue;
    let text;
    try { text = await bridge.readText(path); } catch { continue; }
    const starts = lineStarts(text);
    const lines: any[] = [];
    for (const span of await linkSpans(text)) {
      if (!samePath(resolveHref(path, span.href), target)) continue;
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
/** `pairs` cleaned: vault paths, the files already moved, no pair that goes nowhere. */
function cleanMoves(pairs) {
  return (pairs || [])
    .map((p) => ({ from: clean(p && p.from), to: clean(p && p.to) }))
    .filter((p) => p.from && p.to && p.from !== p.to && !isOutside(p.from) && !isOutside(p.to));
}

/**
 * The splices that bring the links of `text` (the file at `path`) up to date with `moves`, in
 * ascending order: `[{ start, end, next }]`, UTF-16 offsets into `text`. The one rule, shared by
 * the disk rewrite and by the editor's rewrite of an open page (`planRewrite`), so both make
 * exactly the same edit.
 *
 * A file that is one of the moves' `to` is a file that moved (unless `settledSelf`: its own
 * hrefs were already rewritten by an earlier pass): its hrefs were written against where it
 * was, so they are resolved from there and every one of them is written relative to the new
 * place (N16). Any other file only has its links into a `from` rewritten.
 * @param moves  cleaned
 */
async function editsFor(text: string, path: string, moves: Array<{ from: string; to: string; }>, { settledSelf = false }: { settledSelf?: boolean; } = {}) {
  // Keyed in form C, so a link that spells the name in the other Unicode form still follows.
  const toFor = new Map(moves.map((p) => [nfc(p.from), p.to]));
  const self = settledSelf ? null : moves.find((p) => p.to === path);
  // The hrefs in a file were written relative to where it was; `was` is that place.
  const was = self ? self.from : path;
  const moved = was !== path;
  const edits: any[] = [];
  for (const span of await linkSpans(text)) {
    const target = resolveHref(was, span.href);
    if (target === null) continue;
    // An href with no scheme that starts with `/` is vault-root-relative: it means the same
    // file wherever the page lands, so moving the page must not rewrite it.
    if (!moved && span.href.trim().startsWith('/')) continue;
    const to = toFor.get(nfc(target));
    // Outside the move set: only a file that moved needs its own hrefs rewritten, and only
    // to say the same thing from the new folder.
    if (!to && !moved) continue;
    if (!to && span.href.trim().startsWith('/')) continue;
    const next = relativeHref(path, to || target) + span.tail;
    if (next === span.href + span.tail) continue;
    edits.push({ start: span.start, end: span.end, next });
  }
  return edits.sort((a, b) => a.start - b.start);
}

/**
 * `ose.links.planRewrite(text, filePath, pairs, opts?)` -> Promise<Array<{ from, to, insert }>>: the
 * splices the disk rewrite would make in `text`, the file at `filePath`, for the moves `pairs`,
 * as UTF-16 offsets into `text`, ascending and never overlapping. Pure: nothing is read or
 * written. The editor applies them to a Source buffer as one transaction (H5). Async only
 * because the markdown parser is loaded the first time it is needed. `opts.settled`: this
 * file's own hrefs were already rewritten for the move (the second pass), so it is not
 * treated as a file that moved.
 */
export async function planRewrite(text: string, filePath: string, pairs: Array<{ from: string; to: string; }>, opts: { settled?: boolean; } = {}) {
  const moves = cleanMoves(pairs);
  if (!moves.length || typeof text !== 'string') return [];
  const edits = await editsFor(text, clean(filePath), moves, { settledSelf: !!(opts && opts.settled) });
  return edits.map((e) => ({ from: e.start, to: e.end, insert: e.next }));
}

/**
 * Rewrite every link into any of `pairs` ([{ from, to }], vault paths, the files already
 * moved on disk) so it points at the new place. A folder move is passed one pair per file
 * under it, and a file that links to three of them is read and written once, not three times.
 *
 * A moved file is found at its new path, so its own hrefs are resolved against its old path
 * (that is what they were written against) and rewritten relative to the new one; a link
 * from one moved file to another, still right after the move, comes out unchanged and is not
 * counted. Only markdown files are rewritten; a link in any other text file is not a markdown
 * link.
 *
 * A file that is open in the editor (on screen or parked in a background tab) is not touched on
 * disk: the page host is asked first (`rewriteLinksIn`, H5) and rewrites the buffer as one
 * undoable edit, which the editor's autosave then writes; its `failed` joins this call's. Every
 * other file has its current text kept as a version first (`keep` above), and is written with
 * `saveFile` against the hash it was read with: a file that changed between the read and the
 * write (the open page's own save, a sync client) is not written over, and lands in `failed`.
 *
 * N16: a moved file's hrefs that point *outside* the move set are rewritten too. Those files are
 * read whether or not the name search turned them up, because a page need not mention its own
 * name to hold links written from where it used to be.
 *
 * Two options split the pass in two, so the moved files can be done while the pages showing
 * them are still frozen (fileops.ts movePath) and everything else after:
 * - `only: 'moved'`: rewrite only the moved files' own hrefs, on disk; no search, no other file
 *   read, and the page host is not asked (the page is frozen and saved, and takes the new disk
 *   text as its baseline from `afterPathChange`).
 * - `settled: paths`: files (at their new paths) whose own hrefs an earlier `only: 'moved'`
 *   pass already rewrote. They are read as files that did not move: their hrefs now say where
 *   they are, and only a link into this batch's `from`s is still rewritten.
 * -> { files, links, failed: [path], rewritten: { [path]: hash } }; `rewritten` is the new hash
 *    of every file this call wrote, so a page showing one can take it as its own.
 */
export async function rewriteInboundMany(pairs: { from: string; to: string; }[], { only = null, settled = null }: { only?: 'moved' | null; settled?: Iterable<string> | null; } = {}): Promise<{ files: number; links: number; failed: string[]; rewritten: Record<string, string>; }> {
  const moves = cleanMoves(pairs);
  const res: { files: number; links: number; failed: string[]; rewritten: Record<string, string>; } = { files: 0, links: 0, failed: [], rewritten: {} };
  if (!moves.length) return res;

  const done = new Set([...(settled || [])].map(clean));
  const needles = [...new Set(moves.flatMap((p) => needlesFor(p.from)))];
  const files: string[] = only === 'moved'
    ? [...new Set<string>(moves.map((m) => m.to).filter((to) => !done.has(to)))]
    : await candidates(needles, moves.map((m) => m.to));

  for (const path of files) {
    if (!isMarkdownPath(path) || isOutside(path)) continue;
    const settledSelf = done.has(path);

    if (only !== 'moved') {
      // The open page's buffer is the truth, not the disk: the editor makes the edit (H5).
      const own = settledSelf ? moves.filter((p) => p.to !== path) : moves;
      let asked: { handled: boolean; changed?: number; failed?: string; } | null | undefined = null;
      try {
        const host = pageHost();
        asked = host && typeof host.rewriteLinksIn === 'function' ? await host.rewriteLinksIn(path, own, { settled: settledSelf }) : null;
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        console.error('[links] rewriteLinksIn', path, e);
        asked = { handled: true, changed: 0, failed: String((e && e.message) || e) };
      }
      if (asked && asked.handled) {
        const n = Number(asked.changed) || 0;
        if (n) { res.files++; res.links += n; }
        if (asked.failed) {
          logLine(`links rewrite in open page failed ${path}: ${asked.failed}`, 'warn');
          if (!res.failed.includes(path)) res.failed.push(path);
        }
        continue;
      }
    }

    let read: import('./bridge/commands.ts').ReadFile;
    try { read = await bridge.readFile(path); } catch { continue; }
    const { text, hash } = read;
    if (typeof text !== 'string') continue;
    const edits = await editsFor(text, path, moves, { settledSelf });
    if (!edits.length) continue;
    // Only a file that reads as UTF-8, whole, is rewritten. The save writes UTF-8 and the kept
    // version is the decoded text, so a windows-1252 or UTF-16 page would be converted with no
    // copy of its bytes, and a lossy decode would write U+FFFD over what it could not read.
    // Such a page keeps its old links and is listed as failed, for the user to fix by hand.
    if (read.lossy || !/^utf-?8$/i.test(String(read.encoding || 'UTF-8'))) {
      logLine(`links rewrite skipped ${path}: ${read.lossy ? 'bytes that do not decode' : `encoded as ${read.encoding}`}`, 'warn');
      res.failed.push(path);
      continue;
    }
    // Splice from the end so earlier offsets stay valid; nothing outside the spans moves.
    let out = text;
    for (const e of [...edits].reverse()) out = out.slice(0, e.start) + e.next + out.slice(e.end);
    try {
      await keep(path, text);
      const r = await bridge.saveFile(path, out, { expectedHash: hash, version: 'none' });
      if (!r || r.status !== 'saved') {
        logLine(`links rewrite conflict ${path}: changed since it was read`, 'warn');
        res.failed.push(path);
        continue;
      }
      res.files++;
      res.links += edits.length;
      if (r.hash) res.rewritten[path] = r.hash;
    } catch (err) {
      const e = (err as { code?: string, message?: string });
      console.error('[links] write', path, e);
      logLine(`links rewrite failed ${path}: ${e && e.code} ${e && e.message}`, 'warn');
      res.failed.push(path);
    }
  }
  return res;
}

/** One file, already moved from `from` to `to`. */
export function rewriteInbound(from, to) {
  return rewriteInboundMany([{ from, to }]);
}
