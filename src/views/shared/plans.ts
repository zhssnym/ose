// The monthly plan and the systems check log. Day and Month both read them. Pure: text in,
// data out; no DOM, no `ose` (docs/FORMATS.md "Monthly plan" and "systems.jsonl").
//
//   <reports>/<year>/<YYYY-MM>*.md   the plan: title section (goals), `# Systems`, `# Monthly Review`
//   <reports>/systems.jsonl          one JSON record per check, appended, never rewritten
//
// `resolvePlanPath` is the one function that needs a listing; it takes the lister as an
// argument, so this file still imports nothing that touches a vault.

import { dayIndex, isSameDay, monthDays, parseYmd, startOfDay, startOfMonth, ym, ymd } from './dates.ts';

/* ------------------------------------------------------------------ small text helpers */

/** Numeric-aware, case- and accent-insensitive: `2026-9` before `2026-10`. */
export const naturalCompare = (a, b) =>
  String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

/**
 * One JSON object per line. A bad line is skipped, never fatal: the log is append-only.
 */
export function parseJsonl(text: string): any[] {
  const out: any[] = [];
  for (const l of String(text ?? '').split(/\r?\n/)) {
    const t = l.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* a torn or foreign line: skipped */ }
  }
  return out;
}

/**
 * The file that stands for a date prefix in a folder listing: any `<prefix>*.md`, the exact
 * `<prefix>.md` winning, natural order after that. A digit right after the prefix (with or
 * without a separator) is another date, so `2026-09` never matches `2026-09-12.md`.
 */
export function pickDatedFile(names: string[], prefix: string): string | null {
  const p = String(prefix);
  const hits: any[] = [];
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

/* ------------------------------------------------------------------ paths */

const trimSlash = (dir) => String(dir ?? '').replace(/\/+$/, '');

/**
 * The folder a month's plan lives in: `<reports>/2026`.
 */
export const planDir = (date: Date, reportsDir: string): string => {
  const dir = trimSlash(reportsDir);
  return dir ? `${dir}/${date.getFullYear()}` : String(date.getFullYear());
};

/**
 * The canonical plan path for a date: `<reports>/2026/2026-09.md`. The real file may be named
 * anything starting with `2026-09` (`resolvePlanPath`); this is the name a view prints when
 * nothing matches.
 */
export const planPath = (date: Date, reportsDir: string): string => `${planDir(date, reportsDir)}/${ym(date)}.md`;

/**
 * The check log's path: `<reports>/systems.jsonl`.
 */
export const logPath = (reportsDir: string): string => (trimSlash(reportsDir) ? `${trimSlash(reportsDir)}/systems.jsonl` : 'systems.jsonl');

/**
 * The plan file of the month `date` falls in. `list(folder)` answers entries (`{name, kind}`)
 * or throws; the year folder is listed and `pickDatedFile` picks. When nothing matches, the
 * canonical path comes back with `exists: false`.
 */
export async function resolvePlanPath(list: (folder: string) => Promise<Array<{ name: string; kind: string; }>>, date: Date, reportsDir: string): Promise<{ path: string; dir: string; exists: boolean; }> {
  const folder = planDir(date, reportsDir);
  const fallback = planPath(date, reportsDir);
  let names: string[] | null = null;
  try {
    names = (await list(folder)).filter((n) => n.kind === 'file').map((n) => n.name);
  } catch { /* no year folder: the canonical path names what is missing */ }
  const hit = names ? pickDatedFile(names, ym(date)) : null;
  return hit ? { path: `${folder}/${hit}`, dir: folder, exists: true } : { path: fallback, dir: folder, exists: false };
}

/* ----------------------------------------------------------- monthly plan */

/** Split a document on its H1 headings. The text before the first H1 has `head: null`. */
function h1Sections(text) {
  let cur: { head: string | null; body: string[]; } = { head: null, body: [] };
  const out = [cur];
  for (const raw of String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(raw);
    if (m) { cur = { head: (m[1] ?? '').trim(), body: [] }; out.push(cur); }
    else cur.body.push(raw);
  }
  return out;
}

/**
 * A goal label: a line with a single word and no bullet (`Educational`, `Financial`). Markdown
 * syntax is never a label, so a rule, a quote or an `_gap:_` line stays prose.
 */
export function isGoalLabel(line: string): boolean {
  const l = String(line ?? '').trim();
  return l.length > 0 && l.length <= 32 && !/\s/.test(l) && /^[\p{L}\p{N}]/u.test(l);
}

/**
 * A `_gap: what is missing_` line: the marker for a hole, never filled with a guess.
 */
export const isGapLine = (line: string): boolean => /^_gap:[\s\S]*_$/i.test(String(line ?? '').trim());

/**
 * The body of the title H1: intro paragraphs, then label lines each followed by their bullets.
 * A bullet before any label goes under `Notes`; prose after a label stays prose (the intro).
 */
function goalSections(lines) {
  const sections: any[] = [], paras: any[] = [];
  let cur: { label: string; items: string[]; } | null = null;
  let para: any[] = [];
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
 * A monthly plan file. Three H1 sections in this order; earlier months have only the first:
 *   `# YYYY-MM Monthly Plan`  intro prose, then label lines with bullets  -> title, intro, sections
 *   `# Goals`                 optional: read as more of the title section's body
 *   `# Systems`               one bullet per system                        -> systems, hasSystems
 *   `# Monthly Review`        Hassan's prose, never written by the app     -> review (`# Review` too)
 */
export function parseMonthlyPlan(text: string): { title: string | null; intro: string; sections: Array<{ label: string; items: string[]; }>; hasSystems: boolean; systems: Array<{ name: string; days: Set<number>; }>; review: string; } {
  const secs = h1Sections(text);
  const heads = secs.filter((s) => s.head);
  const titleSec = heads[0] || { head: null, body: [] };
  const find = (re) => heads.find((s) => re.test(s.head));
  const goalSec = heads.indexOf(titleSec) === 0 ? find(/^goals$/i) : null;
  const sysSec = find(/^systems$/i);
  const revSec = find(/^(?:monthly\s+)?review$/i);
  const head = goalSections(titleSec.body);
  const extra = goalSec ? goalSections(goalSec.body) : { sections: [], intro: '' };
  return {
    title: titleSec.head,
    intro: [head.intro, extra.intro].filter(Boolean).join('\n\n'),
    sections: [...head.sections, ...extra.sections],
    hasSystems: !!sysSec,
    systems: sysSec ? parseSystems(sysSec.body.join('\n')) : [],
    review: revSec ? revSec.body.join('\n').trim() : '',
  };
}

/* ---------------------------------------------------------------- systems */

const DAYTOK = {
  lun: 0, mar: 1, mer: 2, jeu: 3, ven: 4, sam: 5, dim: 6,
  mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6,
};
const EVERY_DAY = () => new Set([0, 1, 2, 3, 4, 5, 6]);

/**
 * One bullet per system, an optional day list in parentheses at the end: `(lun-ven)`,
 * `(lun mer jeu)`, `(sam, dim)`; English three-letter days too. None means every day.
 * @returns days: Monday = 0
 */
export function parseSystems(text: string): Array<{ name: string; days: Set<number>; }> {
  const out: any[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const l = raw.trim();
    if (!/^[-*]\s+/.test(l)) continue;
    let name = l.replace(/^[-*]\s+/, '');
    let days = EVERY_DAY();
    const m = name.match(/\(([^)]*)\)\s*$/);
    if (m) {
      const set = new Set<any>();
      for (const tok of (m[1] ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean)) {
        const r = tok.match(/^([a-z]{3})-([a-z]{3})$/);
        const from = r?.[1] ?? '', to = r?.[2] ?? '';
        if (r && from in DAYTOK && to in DAYTOK) {
          const a = DAYTOK[from], b = DAYTOK[to];
          for (let i = a; ; i = (i + 1) % 7) { set.add(i); if (i === b) break; }
        } else if (tok in DAYTOK) set.add(DAYTOK[tok]);
      }
      if (set.size) { days = set; name = name.slice(0, m.index).trim(); }
    }
    if (name) out.push({ name, days });
  }
  return out;
}

/**
 * Whether a system is due on a date (its day list).
 */
export const applies = (system: { days: Set<number>; }, date: Date): boolean => !!system && system.days.has(dayIndex(date));

/**
 * The check log. Records are `{date, system, done, at}`; older ones say `habit` for `system`.
 * The last record for a (date, system) pair wins, so nothing already written is rewritten.
 */
export function parseSystemsLog(text: string): { done: Map<string, boolean>; first: Map<string, string>; names: string[]; } {
  const done = new Map(), first = new Map();
  for (const e of parseJsonl(text)) {
    const name = e && (e.system ?? e.habit);
    if (!name || !e.date) continue;
    done.set(logKey(e.date, name), !!e.done);
    const at = first.get(name);
    if (!at || e.date < at) first.set(name, e.date);
  }
  return { done, first, names: [...first.keys()] };
}

/**
 * The key of the maps `parseSystemsLog` answers.
 * @param date `YYYY-MM-DD`
 */
export const logKey = (date: string, name: string): string => `${date}|${name}`;

/**
 * One line of `systems.jsonl` for a check, as the Day view appends it.
 */
export const checkRecord = (date: Date, name: string, done: boolean, now: Date = new Date()): { date: string; system: string; done: boolean; at: string; } => ({ date: ymd(date), system: name, done: !!done, at: now.toISOString() });

/**
 * The systems of the month `date` falls in: the plan's `# Systems` when it has one, otherwise
 * whatever was checked that month, so an older month still shows its history.
 */
export function systemsFor(plan: any | null, log: { done: Map<string, boolean>; }, date: Date): Array<{ name: string; days: Set<number>; }> {
  if (plan && plan.hasSystems && plan.systems.length) return plan.systems;
  const prefix = ym(date), names = new Set<any>();
  for (const k of log.done.keys()) if (k.slice(0, 7) === prefix) names.add(k.slice(k.indexOf('|') + 1));
  return [...names].sort().map((name) => ({ name, days: EVERY_DAY() }));
}

/* ------------------------------------------------------------------ the verdict of a day */

/**
 * The first day of the month that counts for a system (L16): its first log record, when that
 * falls inside the month, or the 1st when it came earlier. A system that has never been
 * checked has not started, and answers null: no day of it counts as lost.
 * @param monthDate any day of the month
 */
export function startOf(system: { name: string; }, monthDate: Date, log: { first: Map<string, string>; }): Date | null {
  const first = log && log.first ? parseYmd(log.first.get(system.name)) : null;
  if (!first) return null;
  const start = startOfMonth(monthDate);
  return first > start ? first : start;
}

/**
 * One day of one system, from the one verdict the matrix cells and the numbers share:
 *   cls    'on' (done) | 'skip' (due, not done, not today) | 'off' (not due, not started, to come)
 *   tally  'done' | 'lost' | 'open' | null (not counted)
 *   state  words for the tooltip
 * A day before the system's start counts as nothing (L16); today unchecked is open, not lost.
 */
export function dayVerdict(system: { name: string; days: Set<number>; }, date: Date, log: { done: Map<string, boolean>; first: Map<string, string>; }, today: Date): { cls: string; tally: string | null; state: string; } {
  const d = startOfDay(date), now = startOfDay(today);
  const done = log.done.get(logKey(ymd(d), system.name)) === true;
  const floor = startOf(system, d, log);
  const isToday = isSameDay(d, now), future = d > now;
  const due = applies(system, d) && !!floor && d >= floor;
  const cls = done ? 'on' : (!due || future) ? 'off' : 'skip';
  const tally = !due ? null : done ? 'done' : (future || isToday) ? 'open' : 'lost';
  const state = done ? 'done'
    : future ? 'upcoming'
    : !applies(system, d) ? 'not due'
    : !floor ? 'not started'
    : d < floor ? 'before it started'
    : isToday ? 'open'
    : 'not done';
  return { cls, tally, state };
}

/**
 * The days of the month a system has lost so far: due, on or after its first log record,
 * before today, and not checked. Days before the first record are not losses (L16); a system
 * never checked has lost nothing.
 * @param monthDate any day of the month
 */
export function lossDays(system: { name: string; days: Set<number>; }, monthDate: Date, log: { done: Map<string, boolean>; first: Map<string, string>; }, today: Date): Date[] {
  return monthDays(monthDate).filter((d) => dayVerdict(system, d, log, today).tally === 'lost');
}

/**
 * Three integers that always sum to 100: `done` and `lost` round on their own and `open` takes
 * the drift; with nothing open the drift goes to `lost`, so a month never reads "-1% open".
 */
export function percentages(t: { done: number; lost: number; open: number; }): { done: number; lost: number; open: number; } {
  const all = t.done + t.lost + t.open;
  if (!all) return { done: 0, lost: 0, open: 0 };
  const done = Math.round((100 * t.done) / all);
  if (!t.open) return { done, lost: 100 - done, open: 0 };
  const lost = Math.round((100 * t.lost) / all);
  return { done, lost, open: 100 - done - lost };
}
