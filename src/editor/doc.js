// The page document model: how a markdown file is split into frontmatter, title and body,
// and how those three are put back together byte-for-byte when nothing was edited.
//
// A file looks like this:
//
//   ---\nkey: value\n---\n     frontmatterRaw   preserved verbatim, never parsed for output
//   \n                         preTitle         blank lines before the title (rare)
//   # Shahir Household         titleLine        only when the H1 is the FIRST block
//   \n\n                       gap              raw newlines between the title and the body
//   ...                        body             everything else, this is what Crepe edits
//
// If the first block is not an H1 the title is not extracted at all: the body keeps every
// line in its original order (so a stray H1 further down stays exactly where it is) and the
// header shows the file name instead.

import { detectStyle } from './stringify.js';

const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
// The closing `#` sequence of an ATX heading is markup, not text: `# Title #` is titled
// `Title` (CommonMark 4.2). It only closes when a space separates it from the text, so
// `# C#` keeps its hash.
const ATX_H1 = /^#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

// A `---` on line 1 only opens frontmatter when what follows looks like a YAML mapping and
// the block closes. Otherwise it is a thematic break and the text under it is prose, which
// must reach the editor instead of being hidden in a read-only properties strip (M17).
const FM_MAX_LINES = 64;
const FM_LINE = [
  /^\s*$/,                       // blank
  /^#/,                          // comment
  /^[^\s:#][^:]*:(?:[ \t].*)?$/, // key: value, or a bare `key:` opening a block
  /^\s+\S/,                      // an indented continuation or nested key
  /^-(?:[ \t].*)?$/,             // a sequence item at column 0
];

function looksLikeFrontmatter(inner) {
  const lines = inner.split('\n');
  if (lines.length > FM_MAX_LINES) return false;
  return lines.every((l) => FM_LINE.some((re) => re.test(l)));
}

/**
 * @param {string} text raw file content
 * @returns {{eol:string, eols:string[], lines:string[], bom:boolean, endsWithNewline:boolean,
 *            style:object, frontmatterRaw:string, frontmatter:Array|null, preTitle:string,
 *            titleLine:string|null, title:string, gap:string, body:string}}
 * `style` is how this file spells its bullets, numbers, rules, fences and list indent (M12).
 */
export function parseDoc(text) {
  let src = String(text ?? '');
  // A UTF-8 BOM is a byte of the file, not a character of the document: it must not reach the
  // title regex or the editor, and it must be written back (M16). The bridge keeps it on read.
  const bom = src.charCodeAt(0) === 0xFEFF;
  if (bom) src = src.slice(1);

  // Line endings are recorded per line, not per file: a file with 99 CRLF lines and 8 LF ones
  // keeps all 107 as they are (M15). `eol` is only what a line the editor *adds* gets.
  const eols = src.split('\n').map((l) => (l.endsWith('\r') ? '\r\n' : '\n'));
  let crlf = 0;
  for (const e of eols) if (e === '\r\n') crlf++;
  const eol = crlf * 2 > eols.length ? '\r\n' : '\n';
  const lf = src.replace(/\r\n/g, '\n');
  const lines = lf.split('\n');
  const endsWithNewline = /\n$/.test(lf);

  let rest = lf;
  let frontmatterRaw = '';
  const fm = rest.match(FRONTMATTER);
  if (fm && fm.index === 0 && looksLikeFrontmatter(fm[1])) {
    frontmatterRaw = fm[0];
    rest = rest.slice(fm[0].length);
  }

  const preTitle = (rest.match(/^(?:[ \t]*\n)*/) || [''])[0];
  const after = rest.slice(preTitle.length);
  const firstLine = after.split('\n', 1)[0];
  const h1 = firstLine.match(ATX_H1);

  if (!h1 || !h1[1]) {
    return {
      eol, eols, lines, bom, endsWithNewline, frontmatterRaw, style: detectStyle(rest),
      frontmatter: frontmatterRaw ? parseFrontmatter(frontmatterRaw) : null,
      preTitle: '', titleLine: null, title: '', gap: '',
      body: rest,
    };
  }

  const afterTitle = after.slice(firstLine.length);
  // At most the newline that ends the title's line and the blank line under it. Anything beyond
  // those two is space the writer put there (space.js: a run of N blank lines is N minus 1
  // empty paragraphs), and space belongs to the body, where the editor can show it and the
  // caret can reach it. Taking the whole run into `gap` is what used to swallow it.
  const gap = (afterTitle.match(/^\n*/) || [''])[0].slice(0, 2);
  return {
    eol, eols, lines, bom, endsWithNewline, frontmatterRaw, style: detectStyle(rest),
    frontmatter: frontmatterRaw ? parseFrontmatter(frontmatterRaw) : null,
    preTitle, titleLine: firstLine, title: h1[1], gap,
    body: afterTitle.slice(gap.length),
  };
}

/**
 * Rebuild the file. `title` and `body` are the current values; when they equal what parseDoc
 * found, the output is identical to the input (minus trailing whitespace normalisation).
 */
export function composeDoc(doc, { title, body }) {
  const hasTitle = doc.titleLine !== null;
  const titleChanged = hasTitle && title !== doc.title;
  const titleLine = hasTitle ? (titleChanged ? '# ' + String(title).trim() : doc.titleLine) : null;

  let out = doc.frontmatterRaw + doc.preTitle;
  if (titleLine !== null) {
    out += titleLine;
    // The gap ends the title's line and leaves the blank line under it, and `parseDoc` keeps at
    // most those two. Everything past them is the body's own: a blank line at the top of the
    // body is an empty paragraph the user can see, reach and delete (space.js), so it is
    // written. Batch 12 trimmed it away here, which is what swallowed space at the top of a page.
    out += doc.gap || (body.trim() ? '\n\n' : '\n');
  }
  out += body;

  // Nothing is normalised but the final newline, and that follows the file: 96 of the vault's
  // 172 files have none, and adding one changes a file the user only looked at (M14). The
  // blank lines in front of it are the body's own — they are the space at the end of the page.
  if (doc.endsWithNewline) { if (!out.endsWith('\n')) out += '\n'; }
  else out = out.replace(/\n$/, '');

  return withBom(doc, restoreEols(out, doc));
}

const withBom = (doc, out) => (doc.bom ? '\uFEFF' + out : out);

/**
 * Give every line back the ending it had. The two texts are nearly identical, so the lines
 * that certainly still mean what they meant are the common prefix and the common suffix;
 * those keep their recorded ending and everything between them gets the file's usual one.
 * A file that was pure LF (all but ten in the vault) short-circuits.
 */
function restoreEols(out, doc) {
  const A = doc.lines;
  if (!A || !doc.eols || !doc.eols.includes('\r\n')) return out;
  const B = out.split('\n');
  const m = Math.min(A.length, B.length);
  let p = 0;
  while (p < m && A[p] === B[p]) p++;
  let s = 0;
  while (s < m - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;

  let r = '';
  for (let i = 0; i < B.length; i++) {
    r += B[i];
    if (i === B.length - 1) break;
    const j = i < p ? i : i >= B.length - s ? A.length - (B.length - i) : -1;
    r += (j >= 0 && doc.eols[j]) || doc.eol;
  }
  return r;
}

/** Read `key: value` lines out of a frontmatter block for the read-only properties strip. */
export function parseFrontmatter(raw) {
  const inner = raw.replace(/^---[ \t]*\r?\n/, '').replace(/\r?\n---[ \t]*(\r?\n|$)$/, '');
  const rows = [];
  let current = null;
  for (const line of inner.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z0-9_$.-][^:]*):[ \t]*(.*)$/);
    if (m && !/^\s/.test(line)) {
      current = { key: m[1].trim(), value: m[2].trim() };
      rows.push(current);
    } else if (current) {
      current.value = (current.value ? current.value + ' ' : '') + line.trim();
    } else {
      rows.push({ key: '', value: line.trim() });
    }
  }
  return rows;
}

const FM_KEY_LINE = /^([^\s:#-][^:]*):([ \t]*)(.*)$/;

/**
 * Find the one `key: value` line in a raw frontmatter block that the properties strip may
 * rewrite (batch 9, C6). The block is never parsed as YAML — it is preserved verbatim — so
 * the only edit allowed is a single-line replacement of a value whose line is unambiguous:
 * the key sits at column 0, appears exactly once, and the next line is not a continuation
 * (indented text, a `- item`, a `|`/`>` block). Anything else stays read-only rather than
 * risk truncating a multi-line value to its first line.
 * Returns {index, key, sep, value} into `raw.split('\n')`, or null.
 */
function locateFrontmatterLine(raw, key) {
  const lines = String(raw || '').split('\n');
  let found = null;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) break;            // the closing fence
    const m = FM_KEY_LINE.exec(lines[i]);
    if (!m || m[1].trim() !== key) continue;
    if (found) return null;                              // duplicate key: ambiguous
    const next = lines[i + 1] || '';
    const multi = (/^\s+\S/.test(next) || /^-\s/.test(next)) && !/^---[ \t]*$/.test(next);
    if (multi || /^[|>][-+]?\s*$/.test(m[3].trim())) return null;
    found = { index: i, key: m[1], sep: m[2], value: m[3] };
  }
  return found;
}

/** True when `key` has a value the strip may edit in place. */
export const frontmatterEditable = (raw, key) => !!locateFrontmatterLine(raw, key);

/**
 * `raw` with the value of `key` replaced, every other byte untouched (fences, unknown keys,
 * comments, blank lines, the trailing newline). Null when the line cannot be located; the
 * caller then leaves the row read-only. Newlines in `value` become spaces: the strip edits
 * one line, never adds one.
 */
export function setFrontmatterValue(raw, key, value) {
  const loc = locateFrontmatterLine(raw, key);
  if (!loc) return null;
  const lines = String(raw).split('\n');
  const v = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  // Keep the spacing after the colon as written; a value that was empty (`key:`) gets one space.
  const sep = loc.sep || (v ? ' ' : '');
  lines[loc.index] = `${loc.key}:${v ? sep : ''}${v}`;
  return lines.join('\n');
}

/**
 * Word count over markdown source. Fences, inline code, link targets and markup punctuation
 * are dropped so the number matches what a reader would count on the page.
 */
export function countWords(md) {
  const text = String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/^[ \t]*[|:-]+[ \t]*$/gm, ' ')
    .replace(/[#>*_~`|[\]()]/g, ' ');
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu);
  return m ? m.length : 0;
}

// Spellcheck language. The vault is French and English mixed, often in the same folder, so
// the language is a property of the document, not of the app. Counting a handful of function
// words is enough: they are frequent, short, and disjoint between the two languages. French
// wins ties because the paperwork, the school notes and the family files are French.
const FR_WORDS = ['le', 'la', 'les', 'des', 'et', 'est', 'une', 'pour', 'dans', 'du', 'que', 'qui', 'pas', 'sur'];
const EN_WORDS = ['the', 'and', 'of', 'to', 'is', 'for', 'with', 'that', 'this', 'are', 'it', 'in'];

function countHits(words, list) {
  let n = 0;
  for (const w of words) if (list.includes(w)) n++;
  return n;
}

/** 'fr' | 'en' for a markdown body. Default 'fr'. */
export function detectLang(md) {
  const words = String(md || '')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .match(/[a-zà-ÿ']+/g) || [];
  const sample = words.slice(0, 4000);
  const en = countHits(sample, EN_WORDS);
  const fr = countHits(sample, FR_WORDS);
  return en > fr ? 'en' : 'fr';
}
