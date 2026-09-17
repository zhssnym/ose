// The monthly plan and the systems check log. Day and Month both read them, so the parsers and
// the one derived path they need live here rather than twice.
//
// They used to live in `ose:md`. With 1.0.0 the kernel keeps only helpers that know nothing
// about any particular file, and a format belongs to whatever reads it. The parsers are
// unchanged: pure text in, data out. The two path helpers take the reports folder the caller
// resolved through `ose.paths`; nothing here spells a vault path.
//
// The schema is the reports folder's own README: `<reports>/<year>/<YYYY-MM>.md`, with a title
// section, `# Systems` and `# Monthly Review`. The check log is `<reports>/systems.jsonl`.

import { ym, dayIdx, parseJsonl, pickDatedFile } from 'ose:md';

/* ------------------------------------------------------------------ paths */

/** The folder a month's plan lives in: `<reports>/2026`. */
export const planDir = (d, dir) => `${String(dir ?? '').replace(/\/+$/, '')}/${d.getFullYear()}`;

/**
 * The canonical monthly plan path for a date: `<reports>/2026/2026-09.md`. The real file may be
 * named anything starting with `2026-09` (see `pickDatedFile`); this is what the views fall
 * back to when the folder cannot be listed, and what they print when nothing matches.
 */
export const planPath = (d, dir) => `${planDir(d, dir)}/${ym(d)}.md`;

/**
 * `resolvePlanPath(files, date, dir)` -> `{ path, dir, exists }`. Names are tolerant: the year
 * folder is listed and any `2026-09*.md` is September, the exact `2026-09.md` winning when
 * several match, so this needs a folder listing and cannot be a pure string helper.
 *
 * When the year folder cannot be listed, or holds no file for that month, the canonical
 * `<reports>/2026/2026-09.md` is answered with `exists: false`, so the view always has a path to
 * name in its "missing" line.
 */
export async function resolvePlanPath(files, d, dir) {
  const folder = planDir(d, dir);
  const fallback = planPath(d, dir);
  let names = null;
  try {
    names = (await files.list(folder)).filter((n) => n.kind === 'file').map((n) => n.name);
  } catch { /* the year folder is not there; the fallback path names what is missing */ }
  if (!names) return { path: fallback, dir: folder, exists: false };
  const hit = pickDatedFile(names, ym(d));
  return hit
    ? { path: `${folder}/${hit}`, dir: folder, exists: true }
    : { path: fallback, dir: folder, exists: false };
}

/* ----------------------------------------------------------- monthly plan */

/** Split a document on its H1 headings. The text before the first H1 has `head: null`. */
function h1Sections(text) {
  const out = [{ head: null, body: [] }];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(raw);
    if (m) out.push({ head: m[1].trim(), body: [] });
    else out[out.length - 1].body.push(raw);
  }
  return out;
}

/**
 * A goal label, per the reports README: a line with a single word and no bullet.
 * `Educational`, `Financial`, `Personal` are the convention; any single word works. Markdown
 * syntax is never a label, so a rule, a quote or an `_gap:_` line stays prose.
 */
export function isGoalLabel(line) {
  const l = String(line ?? '').trim();
  return l.length > 0 && l.length <= 32 && !/\s/.test(l) && /^[\p{L}\p{N}]/u.test(l);
}

/** A `_gap: what is missing_` line: the marker for a hole, never filled with a guess. */
export const isGapLine = (line) => /^_gap:[\s\S]*_$/i.test(String(line ?? '').trim());

/**
 * The body of the title H1: intro paragraphs, then label lines each followed by their bullets.
 *   - bullets under a label are that label's goals until the next label or the next H1
 *   - anything that is not a bullet and not a label is prose; prose before the first label is
 *     the intro, and prose after one is kept there too rather than invented into a goal
 *   - a bullet before any label has no label of its own; it is collected under `Notes`
 * -> { sections: [{label, items}], intro: 'paragraph\n\nparagraph' }
 */
function goalSections(lines) {
  const sections = [], paras = [];
  let cur = null, para = [];
  const flush = () => { if (para.length) { paras.push(para.join(' ')); para = []; } };

  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    if (/^[-*]\s+/.test(l)) {
      flush();
      if (!cur) { cur = { label: 'Notes', items: [] }; sections.push(cur); }
      cur.items.push(l.replace(/^[-*]\s+/, ''));
      continue;
    }
    if (isGoalLabel(l)) { flush(); cur = { label: l, items: [] }; sections.push(cur); continue; }
    para.push(l);
  }
  flush();
  return { sections, intro: paras.join('\n\n') };
}

/**
 * A monthly plan file, exactly as the reports README defines it. Three H1 sections in this
 * order; earlier months have only the first, and a file that does not follow the schema renders
 * as plain text rather than as invented goals.
 *   "# YYYY-MM Monthly Plan"  intro prose, then label lines with bullets  -> title, intro, sections
 *   "# Systems"               prose, then one bullet per system            -> systems, hasSystems
 *   "# Monthly Review"        Hassan's prose, never written by the app     -> review
 *                             (`# Review` is the same section: the view calls it that, and a
 *                             plan written to match the view must not lose its review)
 * The heads are matched exactly: `# 2026-01 Monthly Review` is not `# Monthly Review`, and a
 * file that names it that way keeps its review out of the view until the file is fixed.
 * One tolerance, because the vault uses it: a `# Goals` section is read as more of the title
 * section's body, so `2026-09.md` (title, `# Goals`, `# Systems`, `# Monthly Review`) and a
 * file with its labels directly under the title both give the same goals.
 */
export function parseMonthlyPlan(text) {
  const secs = h1Sections(text);
  const heads = secs.filter((s) => s.head);
  const titleSec = heads[0] || { head: null, body: [] };
  const find = (re) => heads.find((s) => re.test(s.head));
  const goalSec = heads.indexOf(titleSec) === 0 ? find(/^goals$/i) : null;
  const sysSec = find(/^systems$/i);
  const revSec = find(/^(?:monthly\s+)?review$/i);
  const head = goalSections(titleSec.body);
  const extra = goalSec ? goalSections(goalSec.body) : { sections: [], intro: '' };
  const sections = [...head.sections, ...extra.sections];
  const intro = [head.intro, extra.intro].filter(Boolean).join('\n\n');
  return {
    title: titleSec.head,
    intro,
    sections,
    hasSystems: !!sysSec,
    systems: sysSec ? parseHabits(sysSec.body.join('\n')) : [],
    review: revSec ? revSec.body.join('\n').trim() : '',
  };
}

/* ---------------------------------------------------------------- systems */

const DAYTOK = { lun: 0, mar: 1, mer: 2, jeu: 3, ven: 4, sam: 5, dim: 6 };

/**
 * One bullet per system. Optional day list in parentheses: (lun-ven), (lun mer jeu), (sam, dim).
 * No parentheses means every day. -> [{ name, days:Set<0..6> }]
 * The name is historical: this is the syntax the retired Habits.md used and the `# Systems`
 * section of the monthly plan kept.
 */
export function parseHabits(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const l = raw.trim();
    if (!/^[-*]\s+/.test(l)) continue;
    let name = l.replace(/^[-*]\s+/, '');
    let days = new Set([0, 1, 2, 3, 4, 5, 6]);
    const m = name.match(/\(([^)]*)\)\s*$/);
    if (m) {
      const set = new Set();
      for (const tok of m[1].toLowerCase().split(/[\s,]+/).filter(Boolean)) {
        const r = tok.match(/^([a-z]{3})-([a-z]{3})$/);
        if (r && r[1] in DAYTOK && r[2] in DAYTOK) {
          const a = DAYTOK[r[1]], b = DAYTOK[r[2]];
          for (let i = a; ; i = (i + 1) % 7) { set.add(i); if (i === b) break; }
        } else if (tok in DAYTOK) set.add(DAYTOK[tok]);
      }
      if (set.size) { days = set; name = name.slice(0, m.index).trim(); }
    }
    if (name) out.push({ name, days });
  }
  return out;
}

/** Whether a system applies on a given date. */
export const applies = (sys, d) => !!sys && sys.days.has(dayIdx(d));

/**
 * The systems check log. Lines are `{date, system, done, at}`; lines written before the Habits
 * folder was retired say `habit` instead of `system` and mean the same thing. The last line for
 * a (date, system) pair wins, so nothing already written is ever rewritten.
 * -> { done: Map<'date|system', boolean>, first: Map<system, 'YYYY-MM-DD'>, names: string[] }
 */
export function parseSystemsLog(text) {
  const done = new Map(), first = new Map();
  for (const e of parseJsonl(text)) {
    const name = e && (e.system ?? e.habit);
    if (!name || !e.date) continue;
    done.set(`${e.date}|${name}`, !!e.done);
    const at = first.get(name);
    if (!at || e.date < at) first.set(name, e.date);
  }
  return { done, first, names: [...first.keys()] };
}

/** Key for the maps `parseSystemsLog` returns. */
export const logKey = (date, name) => `${date}|${name}`;

/**
 * The systems of the month `date` falls in: the plan's `# Systems` section when it has one,
 * otherwise whatever was checked that month, so an older month still shows its history.
 */
export function systemsFor(plan, log, date) {
  if (plan && plan.hasSystems && plan.systems.length) return plan.systems;
  const prefix = ym(date), names = new Set();
  for (const k of log.done.keys()) if (k.slice(0, 7) === prefix) names.add(k.slice(k.indexOf('|') + 1));
  return [...names].sort().map((name) => ({ name, days: new Set([0, 1, 2, 3, 4, 5, 6]) }));
}

/** `parseSystems` under the name docs/KERNEL.md gave it. */
export { parseSystemsLog as parseSystems };
