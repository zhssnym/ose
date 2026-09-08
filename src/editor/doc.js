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

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const ATX_H1 = /^#[ \t]+(.*?)[ \t]*$/;

/**
 * @param {string} text raw file content
 * @returns {{eol:string, endsWithNewline:boolean, frontmatterRaw:string, frontmatter:Array|null,
 *            preTitle:string, titleLine:string|null, title:string, gap:string, body:string}}
 */
export function parseDoc(text) {
  const src = String(text ?? '');
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const lf = src.replace(/\r\n/g, '\n');
  const endsWithNewline = /\n$/.test(lf);

  let rest = lf;
  let frontmatterRaw = '';
  const fm = rest.match(FRONTMATTER);
  if (fm && fm.index === 0) {
    frontmatterRaw = fm[0];
    rest = rest.slice(fm[0].length);
  }

  const preTitle = (rest.match(/^(?:[ \t]*\n)*/) || [''])[0];
  const after = rest.slice(preTitle.length);
  const firstLine = after.split('\n', 1)[0];
  const h1 = firstLine.match(ATX_H1);

  if (!h1 || !h1[1]) {
    return {
      eol, endsWithNewline, frontmatterRaw,
      frontmatter: frontmatterRaw ? parseFrontmatter(frontmatterRaw) : null,
      preTitle: '', titleLine: null, title: '', gap: '',
      body: rest,
    };
  }

  const afterTitle = after.slice(firstLine.length);
  const gap = (afterTitle.match(/^\n*/) || [''])[0];
  return {
    eol, endsWithNewline, frontmatterRaw,
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
    let gap = doc.gap;
    if (!gap) gap = body.trim() ? '\n\n' : '\n';
    out += gap;
  }
  out += body;

  // Only the very end is normalised. Nothing else is touched: stripping trailing spaces or
  // collapsing blank lines globally would corrupt fenced code blocks.
  out = out.replace(/\n+$/, '');
  if (doc.endsWithNewline || titleLine === null || body.trim()) out += '\n';
  return doc.eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
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
