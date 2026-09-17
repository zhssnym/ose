// `ose:md` (docs/KERNEL.md): the generic helpers a plugin reading a file wants, so that two
// plugins reading the same file read it the same way. Dates, `firstH1`, `naturalCompare`, the
// dated-file rule, JSONL, frontmatter and the page split. Nothing here knows a particular file
// or folder of any vault: what a format means is the plugin's business (docs/PLUGINS.md).
// Nothing here touches the DOM or the bridge either; it is pure text in, data out.

/* ------------------------------------------------------------------ dates */

export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const ym = (d) => ymd(d).slice(0, 7);

/** '2026-09-06' (or any string starting with one) -> Date at local midnight, else null. */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? '').trim());
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => { const x = startOfDay(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const sameDay = (a, b) => !!a && !!b && ymd(a) === ymd(b);
/** 0 = Monday … 6 = Sunday. */
export const dayIdx = (d) => (d.getDay() + 6) % 7;
export const startOfWeek = (d) => addDays(d, -dayIdx(d));
export const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
export const endOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
/** Whole days from a to b (both normalised to midnight). */
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

export function monthDays(d) {
  const out = [], last = endOfMonth(d).getDate();
  for (let i = 1; i <= last; i++) out.push(new Date(d.getFullYear(), d.getMonth(), i));
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (d) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** 'Sunday 6 September' — the Day view title. */
export const dayTitle = (d) => `${DAY_LONG[dayIdx(d)]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
/** '06/09' — the short form used inside tooltips. */
export const ddmm = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;

/** minutes past midnight -> '19h30' (Hassan's own notation, kept from the files). */
export const hhmm = (m) => `${pad(Math.floor(m / 60))}h${pad(m % 60)}`;
/** a duration in minutes -> '1h30' / '2h' / '45m'. */
export function dur(m) {
  if (!m) return '0h';
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h${pad(m % 60)}` : `${m / 60}h`;
}
/** a countdown -> 'in 1h 15m' / 'in 4 min' / 'now'. */
export function until(m) {
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `in ${h}h ${r}m` : `in ${h}h`;
}

const stripAccents = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/**
 * Sidebar order, applied to file names: numeric-aware, case- and accent-insensitive.
 * `1-general-todo.md` before `2-legal-todo.md`, `2026-9.md` before `2026-10.md`.
 */
export const naturalCompare = (a, b) =>
  String(a).localeCompare(String(b), 'fr', { numeric: true, sensitivity: 'base' });

/** The text of the first H1 in a document, or '' when it has none. */
export function firstH1(text) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(raw);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * The file that stands for a date prefix in a folder listing, per the tolerant-names rule of
 * CONTRACT.md batch 5: any `<prefix>*.md` is that date's file, the exact `<prefix>.md` wins
 * when several match, natural order breaks what is left. -> the file name, or null.
 *   pickDatedFile(['2026-09.md', '2026-09 Monthly Plan.md'], '2026-09') -> '2026-09.md'
 *   pickDatedFile(['2026-09 Monthly Plan.md'], '2026-09')               -> '2026-09 Monthly Plan.md'
 * What follows the prefix may not be a digit, with or without a separator in front of it, so
 * `2026-09` matches `2026-09 Monthly Plan.md` but never `2026-09-12.md` or `2026-091.md`.
 */
export function pickDatedFile(names, prefix) {
  const p = String(prefix);
  const hits = [];
  for (const n of names || []) {
    const name = String(n);
    if (!/\.md$/i.test(name) || !name.startsWith(p)) continue;
    if (/^[-_.]?\d/.test(name.slice(p.length))) continue;
    if (name.length === p.length + 3) return name;      // exactly `<prefix>.md`
    hits.push(name);
  }
  hits.sort(naturalCompare);
  return hits[0] || null;
}

/* ------------------------------------------------------------------- jsonl */

/** One JSON object per line. A bad line is skipped, never fatal: the log is append-only. */
export function parseJsonl(text) {
  const out = [];
  for (const l of String(text ?? '').split(/\r?\n/)) {
    const t = l.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return out;
}

/* ------------------------------------------------------------------ the document split */

// Round four: `ose:md` carries the frontmatter and title split as well as the parsers, so a
// plugin reading a page reads it the way the editor does without importing `ose:editor`.
// `parseFrontmatter` is the editor's (src/editor/doc.js); `splitDoc` is the shape of a page
// the properties strip and the title bar are drawn from, and nothing more: no style detection,
// no line-ending bookkeeping. Round-tripping a file byte for byte stays the editor's job.

const FM_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const ATX_TITLE = /^#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/;
const FM_MAX_LINES = 64;
const FM_LINE = [
  /^\s*$/,                       // blank
  /^#/,                          // comment
  /^[^\s:#][^:]*:(?:[ \t].*)?$/, // key: value, or a bare `key:` opening a block
  /^\s+\S/,                      // an indented continuation or a nested key
  /^-(?:[ \t].*)?$/,             // a sequence item at column 0
];

// A `---` on line 1 opens frontmatter only when what follows looks like a YAML mapping and the
// block closes; otherwise it is a thematic break and the text under it is prose (M17).
function looksLikeFrontmatter(inner) {
  const lines = inner.split(/\r?\n/);
  if (lines.length > FM_MAX_LINES) return false;
  return lines.every((l) => FM_LINE.some((re) => re.test(l)));
}

/** Read `key: value` lines out of a raw frontmatter block. Never parsed as YAML. */
export function parseFrontmatter(raw) {
  const inner = String(raw ?? '').replace(/^---[ \t]*\r?\n/, '').replace(/\r?\n---[ \t]*(\r?\n|$)$/, '');
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

/**
 * A page as its three parts: `{ frontmatterRaw, frontmatter, title, titleLine, body }`.
 * The title is only taken when the H1 is the first block of the file; otherwise `title` is ''
 * and `body` keeps every line where it was, so a stray H1 further down is never moved.
 * `frontmatter` is the rows `parseFrontmatter` reads, or null when there is no block.
 */
export function splitDoc(text) {
  let src = String(text ?? '');
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);

  let frontmatterRaw = '';
  const fm = FM_BLOCK.exec(src);
  if (fm && looksLikeFrontmatter(fm[1])) {
    frontmatterRaw = fm[0];
    src = src.slice(fm[0].length);
  }

  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const m = i < lines.length ? ATX_TITLE.exec(lines[i]) : null;
  if (!m) {
    return { frontmatterRaw, frontmatter: frontmatterRaw ? parseFrontmatter(frontmatterRaw) : null,
      title: '', titleLine: null, body: src };
  }
  let j = i + 1;
  while (j < lines.length && !lines[j].trim()) j++;
  return {
    frontmatterRaw,
    frontmatter: frontmatterRaw ? parseFrontmatter(frontmatterRaw) : null,
    title: m[1].trim(),
    titleLine: lines[i],
    body: lines.slice(j).join('\n'),
  };
}

/** `readJsonl` under the name docs/KERNEL.md gives it. */
export { parseJsonl as readJsonl };
