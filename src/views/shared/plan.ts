// The planner's files, read: a year, a month, and how a day counts. Pure: text in, data out; no
// DOM, no `ose`, no vault path. The format is docs/FORMATS.md "The planner".
//
//   YYYY.md      # <title>, intro · # Goals · # Review
//   YYYY-MM.md   # <title>, intro · # Goals · # Week (and # Week from YYYY-MM-DD) · # Days · # Review
//
// A month's `# Days` is one table, a row per day and a column per system; a cell is `x` done,
// `.` due and not done, `-` dropped that day, empty nothing recorded. The word in brackets on a
// line of the week is that line's system. The app writes one row (`writeMark`) or one goal line
// (`writeGoal`) at a time, with `replaceLine`.

import { blockApplies } from './dates.ts';

/* ------------------------------------------------------------------ small helpers */

export const strip = (s: unknown): string => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export const two = (n: number): string => String(n).padStart(2, '0');
export const ymd = (d: Date): string => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
export const ymOf = (d: Date): string => `${d.getFullYear()}-${two(d.getMonth() + 1)}`;
export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Monday = 0 … Sunday = 6. */
export const dayIndex = (d: Date): number => (d.getDay() + 6) % 7;
/** Days in a month, `month` 1 to 12. */
export const daysIn = (year: number, month: number): number => new Date(year, month, 0).getDate();
export const hhmm = (min: number): string => `${two(Math.floor((min % 1440) / 60))}h${two(min % 60)}`;

const WEEKDAY: Record<string, number> = {
  lundi: 0, mardi: 1, mercredi: 2, jeudi: 3, vendredi: 4, samedi: 5, dimanche: 6,
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
};
const DAYTOK: Record<string, number> = {
  lun: 0, mar: 1, mer: 2, jeu: 3, ven: 4, sam: 5, dim: 6,
  mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6,
};
/** The weekday written in a day row, in the file's own language: `jeu`. */
export const DAY_FR = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
const EVERY_DAY = () => new Set([0, 1, 2, 3, 4, 5, 6]);

export const MONTH_GAP = '_gap: written at the end of the month_';
export const YEAR_GAP = '_gap: written at the end of the year_';

/* ------------------------------------------------------------------ types */

export type Goal = { line: number; raw: string; text: string; box: 'open' | 'done' | null; };
export type Area = { label: string; goals: Goal[]; };
export type WeekLine = {
  line: number; name: string; where: string; start: number | null; end: number | null;
  system: string | null; days: Set<number>; q: 'Q1' | 'Q2' | null;
};
export type Week = { from: string | null; head: string; line: number; lines: WeekLine[]; body: string[]; };
export type Mark = '' | 'x' | '.' | '-';
export type DayRow = { line: number; raw: string; day: string; marks: Record<string, Mark>; note: string; };
export type Days = {
  header: { line: number; raw: string; } | null; cols: string[]; systems: string[]; noteCol: number;
  widths: number[]; rows: Map<number, DayRow>;
};
export type Review = { text: string; gap: boolean; written: boolean; grades: Array<{ label: string | null; n: number; }>; overall: number | null; };
export type Month = {
  ym: string; year: number; month: number; title: string; intro: string; goals: Area[];
  weeks: Week[]; days: Days | null; review: Review; q1: string | null;
};
export type Year = { year: number; title: string; intro: string; goals: Area[]; review: Review; };
export type State = 'done' | 'skipped' | 'missed' | 'open' | 'planned' | 'idle' | null;
export type Write = { line: number; expected: string; next: string; };

/* ------------------------------------------------------------------ sections */

type Section = { head: string; line: number; body: Array<{ n: number; text: string; }>; };

/** A file cut on its H1 headings. `n` and `line` are 0-based line indexes, as `replaceLine` takes. */
export function sections(text: string): Section[] {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const out: Section[] = [];
  let cur: Section | null = null;
  lines.forEach((t, n) => {
    const m = /^#\s+(.+?)\s*$/.exec(t);
    if (m) { cur = { head: m[1] ?? '', line: n, body: [] }; out.push(cur); } else if (cur) cur.body.push({ n, text: t });
  });
  return out;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const BOX = /^\[([ xX])\]\s+(.*)$/;
/** A label: a line holding one word and no bullet (`Educational`). */
export const isLabel = (t: string): boolean => { const l = String(t).trim(); return l.length > 0 && l.length <= 32 && !/\s/.test(l) && /^[\p{L}\p{N}]/u.test(l); };

/* ------------------------------------------------------------------ goals */

/** `# Goals`: label lines, each followed by its goals; a goal is a bullet, or a box to tick when met. */
export function parseGoals(body: Section['body']): Area[] {
  const areas: Area[] = [];
  let cur: Area | null = null;
  for (const { n, text } of body) {
    if (!text.trim()) continue;
    const b = BULLET.exec(text);
    if (!b) { if (isLabel(text)) { cur = { label: text.trim(), goals: [] }; areas.push(cur); } continue; }
    let rest = b[1] ?? '';
    let box: Goal['box'] = null;
    const bx = BOX.exec(rest);
    if (bx) { box = bx[1] === ' ' ? 'open' : 'done'; rest = bx[2] ?? ''; }
    if (!cur) { cur = { label: '', goals: [] }; areas.push(cur); }
    cur.goals.push({ line: n, raw: text, text: rest.trim(), box });
  }
  return areas;
}

/* ------------------------------------------------------------------ the week */

/** `(lun-ven)`, `(lun mer jeu)`, `(sam, dim)` -> a Set of 0..6, or null when it is not a day list. */
export function dayList(text: string): Set<number> | null {
  const set = new Set<number>();
  for (const tok of strip(text).split(/[\s,]+/).filter(Boolean)) {
    const r = /^([a-z]{3})-([a-z]{3})$/.exec(tok);
    const a = r ? DAYTOK[r[1] ?? ''] : undefined, z = r ? DAYTOK[r[2] ?? ''] : undefined;
    if (a !== undefined && z !== undefined) {
      for (let i = a; ; i = (i + 1) % 7) { set.add(i); if (i === z) break; }
    } else if (tok in DAYTOK) set.add(DAYTOK[tok] as number);
    else return null;
  }
  return set.size ? set : null;
}

/** A weekday label: `Lundi`, `Mardi, Jeudi`, `Lundi à Vendredi` (English too) -> 0..6, else null. */
export function weekdaysOfLabel(text: string): Set<number> | null {
  const words = strip(text).split(/[\s,]+/).filter(Boolean);
  if (!words.length) return null;
  const out = new Set<number>();
  let prev: number | null = null, range = false;
  for (const w of words) {
    if (w === 'a' || w === 'to' || w === '-') { if (prev === null || range) return null; range = true; continue; }
    if (w === 'et' || w === 'and') continue;
    const d = WEEKDAY[w];
    if (d === undefined) return null;
    if (range && prev !== null) { for (let i = prev; ; i = (i + 1) % 7) { out.add(i); if (i === d) break; } range = false; } else out.add(d);
    prev = d;
  }
  return range ? null : out;
}

const TIME = String.raw`(\d{1,2})\s*[h:]\s*(\d{2})?`;
const BLOCK = new RegExp(String.raw`^${TIME}\s*(?:à|a|to|-|–)\s*${TIME}\s+(.+)$`, 'i');

/** One line of a week, from the text after its bullet: name, place, optional times, tail. */
export function parseWeekLine(rest: string): Omit<WeekLine, 'line' | 'days'> & { days: Set<number> | null; } {
  let t = rest.trim();
  let system: string | null = null, days: Set<number> | null = null, q: WeekLine['q'] = null;
  // the tail, in any order: [system], (Q1) or (Q2), a day list
  for (let i = 0; i < 3; i++) {
    let m = /\s*\[([^\]]+)\]\s*$/.exec(t);
    if (m && system === null) { system = strip(m[1]); t = t.slice(0, m.index); continue; }
    m = /\s*\(Q([12])\)\s*$/i.exec(t);
    if (m && q === null) { q = m[1] === '1' ? 'Q1' : 'Q2'; t = t.slice(0, m.index); continue; }
    m = /\s*\(([^)]*)\)\s*$/.exec(t);
    const set = m ? dayList(m[1] ?? '') : null;
    if (m && set && days === null) { days = set; t = t.slice(0, m.index); continue; }
    break;
  }
  let start: number | null = null, end: number | null = null;
  const b = BLOCK.exec(t);
  if (b && Number(b[1]) <= 24 && Number(b[3]) <= 24) {
    start = Number(b[1]) * 60 + Number(b[2] || 0);
    end = Number(b[3]) * 60 + Number(b[4] || 0);
    if (end <= start) end += 1440;                    // overnight
    t = b[5] ?? '';
  }
  const [name = '', ...where] = t.split(/\s+·\s+/);
  return { name: name.trim(), where: where.join(' · ').trim(), start, end, system, days, q };
}

/**
 * `# Week`, or `# Week from 2026-10-19`. Lines above the first weekday label are for every day;
 * lines under a label are for its days; a day may sit under several labels.
 */
export function parseWeek(sec: Section): Week {
  const m = /^week\s+from\s+(\d{4}-\d{2}-\d{2})$/i.exec(sec.head.trim());
  const lines: WeekLine[] = [];
  let scope: Set<number> | null = null;
  for (const { n, text } of sec.body) {
    if (!text.trim()) continue;
    const b = BULLET.exec(text);
    if (b) {
      const l = parseWeekLine(b[1] ?? '');
      lines.push({ ...l, line: n, days: l.days || scope || EVERY_DAY() });
      continue;
    }
    const set = weekdaysOfLabel(text);
    if (set) scope = set;
  }
  return { from: m ? (m[1] ?? null) : null, head: sec.head, line: sec.line, lines, body: sec.body.map((x) => x.text) };
}

/* ------------------------------------------------------------------ the days */

/** The cells of a table row, as written between the pipes (not trimmed). */
function rawCells(row: string): string[] {
  let t = String(row).trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/);
}
const isDelimiter = (row: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(row);

/** What a cell says: `x` done, `.` due and not done, `-` dropped that day, `` nothing. */
export function markOf(cell: unknown): Mark {
  const t = String(cell ?? '').trim();
  if (!t) return '';
  if (t === '.') return '.';
  if (t === '-' || t === '–') return '-';
  return 'x';
}

/** `# Days`: one table, a row per day; the header names the columns: `Day`, one per system, `Note`. */
export function parseDays(sec: { body: Section['body']; }): Days {
  const t: Days = { header: null, cols: [], systems: [], noteCol: -1, widths: [], rows: new Map() };
  for (const { n, text } of sec.body) {
    if (!/^\s*\|/.test(text)) continue;
    const raw = rawCells(text);
    const c = raw.map((x) => x.trim());
    if (!t.header) {
      t.header = { line: n, raw: text };
      t.cols = c.map(strip);
      t.noteCol = t.cols.findIndex((h, i) => i > 0 && (h === 'note' || h === 'notes'));
      t.systems = t.cols.filter((h, i) => i > 0 && i !== t.noteCol && !!h);
      // the width each cell is padded to: the header's own, less the space on each side
      t.widths = raw.map((x) => Math.max(1, x.length - 2));
      continue;
    }
    if (isDelimiter(text)) continue;
    const day = Number.parseInt(c[0] ?? '', 10);
    if (!(day >= 1 && day <= 31)) continue;
    const marks: Record<string, Mark> = {};
    t.cols.forEach((h, i) => { if (i > 0 && i !== t.noteCol && h) marks[h] = markOf(c[i]); });
    const note = t.noteCol >= 0 ? String(c[t.noteCol] ?? '').replace(/\\\|/g, '|') : '';
    t.rows.set(day, { line: n, raw: text, day: c[0] ?? '', marks, note });
  }
  return t;
}

/** A day row as the app writes it: every cell padded to its header's width. */
export function formatRow(t: Pick<Days, 'cols' | 'noteCol' | 'widths'>, dayCell: string, marks: Record<string, string>, note: string): string {
  const cells = t.cols.map((h, i) => {
    const w = t.widths[i] ?? 1;
    if (i === 0) return String(dayCell).padEnd(w);
    if (i === t.noteCol) return String(note ?? '').replace(/\|/g, '\\|').padEnd(w);
    return String(marks[h] ?? '').padEnd(w);
  });
  return `| ${cells.join(' | ')} |`;
}

/** The header, the delimiter and one empty row per day: what a new month writes under `# Days`. */
export function emptyDays(year: number, month: number, systems: string[]): string[] {
  const cols = ['Day', ...systems, 'Note'];
  const widths = cols.map((c, i) => (i === 0 ? 6 : Math.max(c.length, 1)));
  const t = { cols: cols.map(strip), noteCol: cols.length - 1, widths };
  const out = [
    `| ${cols.map((c, i) => c.padEnd(widths[i] ?? 1)).join(' | ')} |`,
    `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`,
  ];
  for (let d = 1; d <= daysIn(year, month); d++) {
    out.push(formatRow(t, `${two(d)} ${DAY_FR[dayIndex(new Date(year, month - 1, d))]}`, {}, ''));
  }
  return out;
}

/* ------------------------------------------------------------------ the review */

/** `# Review`: prose; `Grade: 7/10` grades the area labelled above it, `Overall: 6/10` the whole. */
export function parseReview(sec: { body: Section['body']; }): Review {
  const text = sec.body.map((l) => l.text).join('\n').trim();
  const gap = /^_gap:[\s\S]*_$/i.test(text);
  const grades: Review['grades'] = [];
  let overall: number | null = null, label: string | null = null;
  for (const { text: t } of sec.body) {
    const l = t.trim().replace(/^\*\*|\*\*$/g, '');
    if (isLabel(l)) { label = l; continue; }
    const g = /^(grade|overall)\s*:\s*(\d+(?:[.,]\d+)?)\s*\/\s*(\d+)/i.exec(l);
    if (!g || !Number(g[3])) continue;
    const n = Math.round((Number.parseFloat((g[2] ?? '0').replace(',', '.')) / Number(g[3])) * 100) / 10;   // out of 10
    if (/overall/i.test(g[1] ?? '')) overall = n; else grades.push({ label, n });
  }
  return { text, gap, written: !!text && !gap, grades, overall };
}

const NO_REVIEW: Review = { text: '', gap: false, written: false, grades: [], overall: null };

/* ------------------------------------------------------------------ a month, a year */

/**
 * A month file. `ym` is its date, `2026-10`; `q1` the Monday a Q1 week starts on (Settings),
 * for the lines marked (Q1) or (Q2).
 */
export function parseMonth(text: string, ym: string, q1: string | null = null): Month {
  const secs = sections(text);
  const find = (re: RegExp) => secs.find((s) => re.test(s.head.trim()));
  const title = secs[0] || { head: '', line: 0, body: [] };
  const goals = find(/^goals$/i), days = find(/^days$/i), review = find(/^(?:monthly\s+)?review$/i);
  const weeks = secs.filter((s) => /^week(?:\s+from\s+\d{4}-\d{2}-\d{2})?$/i.test(s.head.trim())).map(parseWeek);
  weeks.sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
  const [year = 0, month = 1] = ym.split('-').map(Number);
  return {
    ym, year, month, q1,
    title: title.head,
    intro: title.body.map((l) => l.text).join('\n').trim(),
    goals: goals ? parseGoals(goals.body) : [],
    weeks,
    days: days ? parseDays(days) : null,
    review: review ? parseReview(review) : NO_REVIEW,
  };
}

/** A month kept before the planner had days: goals and a review, no week, no table. */
export const isOldMonth = (m: Month): boolean => !m.days && !m.weeks.length;

/** A year file: the title and its intro, Goals, Review. */
export function parseYear(text: string, year: number): Year {
  const secs = sections(text);
  const find = (re: RegExp) => secs.find((s) => re.test(s.head.trim()));
  const title = secs[0] || { head: '', line: 0, body: [] };
  const goals = find(/^goals$/i), review = find(/^(?:yearly\s+)?review$/i);
  return {
    year,
    title: title.head,
    intro: title.body.map((l) => l.text).join('\n').trim(),
    goals: goals ? parseGoals(goals.body) : [],
    review: review ? parseReview(review) : NO_REVIEW,
  };
}

/* ------------------------------------------------------------------ what a day holds */

export const dateOf = (month: Month, day: number): Date => new Date(month.year, month.month - 1, day);

/** The week in force on a date: the last `Week from` that has begun, else `# Week`. */
export function weekFor(month: Month, date: Date): Week | null {
  const d = ymd(date);
  let cur: Week | null = null;
  for (const w of month.weeks) if (!w.from || w.from <= d) cur = w;
  return cur;
}

/** The day's lines: the timed ones in the order of the day, then the others. */
export function linesFor(month: Month, date: Date): WeekLine[] {
  const w = weekFor(month, date);
  if (!w) return [];
  const wd = dayIndex(date);
  const list = w.lines.filter((l) => l.days.has(wd) && blockApplies({ q: l.q }, date, month.q1));
  return [
    ...list.filter((l) => l.start !== null).sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.line - b.line),
    ...list.filter((l) => l.start === null),
  ];
}

/** The systems planned on a date, in the order of the day. */
export function plannedSystems(month: Month, date: Date): string[] {
  const out: string[] = [];
  for (const l of linesFor(month, date)) if (l.system && !out.includes(l.system)) out.push(l.system);
  return out;
}

/** The systems in the order the week meets them, Monday first, lines with no time last. */
export function systemsOf(month: Month): string[] {
  const timed: string[] = [], untimed: string[] = [];
  for (const w of month.weeks) {
    for (let wd = 0; wd < 7; wd++) {
      const list = w.lines.filter((l) => l.days.has(wd) && l.system);
      for (const l of list.filter((x) => x.start !== null).sort((a, b) => (a.start ?? 0) - (b.start ?? 0))) if (l.system && !timed.includes(l.system)) timed.push(l.system);
      for (const l of list.filter((x) => x.start === null)) if (l.system && !untimed.includes(l.system)) untimed.push(l.system);
    }
  }
  return [...timed, ...untimed.filter((s) => !timed.includes(s))];
}

/** Every system the month knows: the table's columns, then any the weeks add. */
export function allSystems(month: Month): string[] {
  const out = month.days ? [...month.days.systems] : [];
  for (const s of systemsOf(month)) if (!out.includes(s)) out.push(s);
  return out;
}

/** The words a system is shown under: its first line's name, up to the first comma. */
export function nameOf(month: Month | null, sys: string): string {
  for (const w of month ? month.weeks : []) {
    const l = w.lines.find((x) => x.system === sys);
    if (l) return l.name.split(',')[0]?.trim() || sys;
  }
  return sys;
}

/** The first day of the month that has a mark: the month counts from there. */
export function firstMarked(month: Month): number | null {
  if (!month.days) return null;
  let first: number | null = null;
  for (const [day, row] of month.days.rows) {
    if (Object.values(row.marks).some(Boolean) && (first === null || day < first)) first = day;
  }
  return first;
}

/**
 * One system on one day: "done" (x), "skipped" (-, counts for nothing), "missed" (due, the day
 * over, not done), "open" (due today), "planned" (a day to come), "idle" (planned, before the
 * month's first mark: counts for nothing), null (nothing planned, nothing marked).
 */
export function stateOf(month: Month, day: number, sys: string, today: Date): State {
  const row = month.days ? month.days.rows.get(day) : null;
  const mark = row ? row.marks[sys] || '' : '';
  if (mark === 'x') return 'done';
  if (mark === '-') return 'skipped';
  const date = dateOf(month, day);
  if (mark !== '.' && !plannedSystems(month, date).includes(sys)) return null;
  const now = startOfDay(today);
  if (date > now) return 'planned';
  if (+date === +now) return 'open';
  const first = firstMarked(month);
  if (mark !== '.' && (first === null || day < first)) return 'idle';
  return 'missed';
}

/** Done over due for a set of days and systems; today's open lines are not due yet. */
export function count(month: Month, today: Date, { days = null, systems = null }: { days?: number[] | null; systems?: string[] | null; } = {}): { done: number; due: number; skipped: number; } {
  const t = { done: 0, due: 0, skipped: 0 };
  const sys = systems || allSystems(month);
  for (let d = 1; d <= daysIn(month.year, month.month); d++) {
    if (days && !days.includes(d)) continue;
    for (const s of sys) {
      const st = stateOf(month, d, s, today);
      if (st === 'done') { t.done++; t.due++; } else if (st === 'missed') t.due++;
      else if (st === 'skipped') t.skipped++;
    }
  }
  return t;
}

/** The month so far: the tally, the day it counts from, and the past days left with no mark. */
export function monthTally(month: Month, today: Date): { done: number; due: number; skipped: number; from: number | null; blank: number; } {
  const t = count(month, today);
  const first = firstMarked(month);
  const now = startOfDay(today);
  let blank = 0;
  if (first !== null && month.days) {
    for (let d = first; d <= daysIn(month.year, month.month); d++) {
      const date = dateOf(month, d);
      if (date >= now) break;
      const row = month.days.rows.get(d);
      const marked = row && Object.values(row.marks).some(Boolean);
      if (!marked && plannedSystems(month, date).length) blank++;
    }
  }
  return { ...t, from: first, blank };
}

/**
 * How one day went: done over due. `when` is "past", "today" (open lines count as due, so the
 * share is the day so far), "future", or "idle" for a day before the month's first mark.
 */
export function dayShare(month: Month, day: number, today: Date): { done: number; due: number; share: number | null; when: 'past' | 'today' | 'future' | 'idle'; } {
  const date = dateOf(month, day), now = startOfDay(today);
  const when = date > now ? 'future' : +date === +now ? 'today' : 'past';
  let done = 0, due = 0, idle = 0;
  for (const s of allSystems(month)) {
    const st = stateOf(month, day, s, today);
    if (st === 'done') { done++; due++; } else if (st === 'missed' || st === 'open') due++;
    else if (st === 'idle') idle++;
  }
  if (when === 'past' && !due && idle) return { done, due, share: null, when: 'idle' };
  return { done, due, share: when !== 'future' && due ? done / due : null, when };
}

/**
 * Days in a row a system was done, back from `from`, across months (`months` by `YYYY-MM`). A day
 * it was not due, a skipped day and today still open do not break it; a missed day does.
 */
export function streak(months: Map<string, Month>, sys: string, today: Date, from: Date = today): number {
  let n = 0;
  let d = startOfDay(from);
  for (let k = 0; k < 800; k++, d = addDays(d, -1)) {
    const month = months.get(ymOf(d));
    if (!month || !month.days) break;
    const st = stateOf(month, d.getDate(), sys, today);
    if (st === 'done') n++;
    else if (st === 'missed' || st === 'idle') break;
  }
  return n;
}

/* ------------------------------------------------------------------ what the app writes */

/**
 * The one row a mark changes, for `replaceLine`. The first mark of a day also writes `.` under
 * everything planned that day, so the row says by itself what was due. Null when the table has
 * no row for that day or no column for that system.
 * @param mark "x" | "." | "-" | ""
 */
export function writeMark(month: Month, day: number, sys: string, mark: Mark): Write | null {
  const t = month.days;
  const row = t ? t.rows.get(day) : null;
  if (!t || !row || !t.systems.includes(sys)) return null;
  const marks: Record<string, string> = { ...row.marks };
  if (!Object.values(marks).some(Boolean)) {
    for (const s of plannedSystems(month, dateOf(month, day))) if (t.systems.includes(s)) marks[s] = '.';
  }
  marks[sys] = mark;
  return { line: row.line, expected: row.raw, next: formatRow(t, row.day, marks, row.note) };
}

/** A goal's box, flipped. */
export function writeGoal(goal: Goal): Write | null {
  if (!goal.box) return null;
  const next = goal.box === 'done' ? goal.raw.replace(/\[[xX]\]/, '[ ]') : goal.raw.replace(/\[ \]/, '[x]');
  return { line: goal.line, expected: goal.raw, next };
}

/* ------------------------------------------------------------------ a new month, a new year */

const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A new month's text, from the month before it when there is one: its goals unticked, the week
 * in force on its last day as `# Week`, an empty table of days, the review's gap line.
 * @param month 1 to 12
 */
export function newMonthText(year: number, month: number, prev: { text: string; ym: string; } | null): string {
  const out = [`# ${MONTH_NAME[month - 1]} ${year}`, '', '# Goals', ''];
  const p = prev ? parseMonth(prev.text, prev.ym) : null;
  if (p && p.goals.length) {
    for (const a of p.goals) {
      if (a.label) out.push(a.label, '');
      for (const g of a.goals) out.push(g.raw.replace(/\[[xX]\]/, '[ ]'));
      out.push('');
    }
  } else out.push('Educational', '', 'Financial', '', 'Personal', '');
  out.push('# Week', '');
  const week = p ? weekFor(p, dateOf(p, daysIn(p.year, p.month))) : null;
  const body = week ? [...week.body] : [];
  while (body.length && !(body[0] ?? '').trim()) body.shift();
  while (body.length && !(body[body.length - 1] ?? '').trim()) body.pop();
  if (body.length) out.push(...body, '');
  const systems = p ? systemsOf({ ...p, weeks: week ? [week] : [] }) : [];
  out.push('# Days', '', ...emptyDays(year, month, systems), '', '# Review', '', MONTH_GAP, '');
  return out.join('\n');
}

/** A new year's text: the title, the previous year's areas (labels alone), the review's gap line. */
export function newYearText(year: number, prev: string | null): string {
  const labels = prev ? parseYear(prev, year - 1).goals.map((a) => a.label).filter(Boolean) : [];
  const out = [`# ${year}`, '', '# Goals', ''];
  for (const l of labels.length ? [...new Set(labels)] : ['Educational', 'Financial', 'Personal']) out.push(l, '');
  out.push('# Review', '', YEAR_GAP, '');
  return out.join('\n');
}
