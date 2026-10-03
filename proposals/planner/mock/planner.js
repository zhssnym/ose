/* The planner files' reader: text in, data out. No DOM, no file access, no dependency.
   The format is ../examples/plannings/README.md. This is the reference a real implementation
   would port into src/views/shared/ (dates on date-fns there); the mock draws from it.

   A month is five H1 sections: the title (intro under it), Goals, Week (and any
   `Week from YYYY-MM-DD`), Days, Review. Every function here is pure. */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ small helpers */

  const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const two = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const ymOf = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const parseYmd = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
  /** Monday = 0 … Sunday = 6. */
  const dayIndex = (d) => (d.getDay() + 6) % 7;
  const daysIn = (year, month) => new Date(year, month, 0).getDate();
  const hhmm = (min) => `${two(Math.floor((min % 1440) / 60))}h${two(min % 60)}`;

  const WEEKDAY = {
    lundi: 0, mardi: 1, mercredi: 2, jeudi: 3, vendredi: 4, samedi: 5, dimanche: 6,
    monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
  };
  const DAYTOK = {
    lun: 0, mar: 1, mer: 2, jeu: 3, ven: 4, sam: 5, dim: 6,
    mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6,
  };
  /** The weekday written in a day row, in the language of the file: `jeu`. */
  const DAY_FR = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
  const EVERY_DAY = () => new Set([0, 1, 2, 3, 4, 5, 6]);

  /* ------------------------------------------------------------------ sections */

  /**
   * A file cut on its H1 headings: `[{ head, line, body: [{ n, text }] }]`. `n` and `line` are
   * 0-based line indexes in the file, which is what `replaceLine` takes.
   */
  function sections(text) {
    const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
    const out = [];
    let cur = null;
    lines.forEach((t, n) => {
      const m = /^#\s+(.+?)\s*$/.exec(t);
      if (m) { cur = { head: m[1], line: n, body: [] }; out.push(cur); } else if (cur) cur.body.push({ n, text: t });
    });
    return out;
  }

  const BULLET = /^\s*[-*+]\s+(.*)$/;
  const BOX = /^\[([ xX])\]\s+(.*)$/;
  /** A label: a line holding one word and no bullet (`Educational`). */
  const isLabel = (t) => { const l = String(t).trim(); return l.length > 0 && l.length <= 32 && !/\s/.test(l) && /^[\p{L}\p{N}]/u.test(l); };

  /* ------------------------------------------------------------------ goals */

  /**
   * `# Goals`: label lines, each followed by its goals. A goal is a bullet, a checkbox when it
   * is to be ticked once met.
   * -> `[{ label, goals: [{ line, raw, text, box }] }]`, box "open" | "done" | null.
   */
  function parseGoals(body) {
    const areas = [];
    let cur = null;
    for (const { n, text } of body) {
      if (!text.trim()) continue;
      const b = BULLET.exec(text);
      if (!b) { if (isLabel(text)) { cur = { label: text.trim(), goals: [] }; areas.push(cur); } continue; }
      let rest = b[1], box = null;
      const bx = BOX.exec(rest);
      if (bx) { box = bx[1] === ' ' ? 'open' : 'done'; rest = bx[2]; }
      if (!cur) { cur = { label: '', goals: [] }; areas.push(cur); }
      cur.goals.push({ line: n, raw: text, text: rest.trim(), box });
    }
    return areas;
  }

  /* ------------------------------------------------------------------ the week */

  /** `(lun-ven)`, `(lun mer jeu)`, `(sam, dim)` -> a Set of 0..6, or null when it is not a day list. */
  function dayList(text) {
    const set = new Set();
    for (const tok of strip(text).split(/[\s,]+/).filter(Boolean)) {
      const r = /^([a-z]{3})-([a-z]{3})$/.exec(tok);
      if (r && r[1] in DAYTOK && r[2] in DAYTOK) {
        for (let i = DAYTOK[r[1]]; ; i = (i + 1) % 7) { set.add(i); if (i === DAYTOK[r[2]]) break; }
      } else if (tok in DAYTOK) set.add(DAYTOK[tok]);
      else return null;
    }
    return set.size ? set : null;
  }

  /**
   * A weekday label: `Lundi`, `Mardi, Jeudi`, `Lundi à Vendredi` (English names too).
   * -> a Set of 0..6, or null when the line is anything else (prose is ignored).
   */
  function weekdaysOfLabel(text) {
    const words = strip(text).split(/[\s,]+/).filter(Boolean);
    if (!words.length) return null;
    const out = new Set();
    let prev = null, range = false;
    for (const w of words) {
      if (w === 'a' || w === 'to' || w === '-') { if (prev === null || range) return null; range = true; continue; }
      if (w === 'et' || w === 'and') continue;
      if (!(w in WEEKDAY)) return null;
      const d = WEEKDAY[w];
      if (range) { for (let i = prev; ; i = (i + 1) % 7) { out.add(i); if (i === d) break; } range = false; } else out.add(d);
      prev = d;
    }
    return range ? null : out;
  }

  const TIME = String.raw`(\d{1,2})\s*[h:]\s*(\d{2})?`;
  const BLOCK = new RegExp(String.raw`^${TIME}\s*(?:à|a|to|-|–)\s*${TIME}\s+(.+)$`, 'i');

  /** One line of a week, from the text after its bullet. */
  function parseWeekLine(rest) {
    let t = rest.trim(), system = null, days = null, q = null;
    // the tail, in any order: [system], (Q1) or (Q2), a day list
    for (let i = 0; i < 3; i++) {
      let m = /\s*\[([^\]]+)\]\s*$/.exec(t);
      if (m && system === null) { system = strip(m[1]); t = t.slice(0, m.index); continue; }
      m = /\s*\(Q([12])\)\s*$/i.exec(t);
      if (m && q === null) { q = `Q${m[1]}`; t = t.slice(0, m.index); continue; }
      m = /\s*\(([^)]*)\)\s*$/.exec(t);
      const set = m ? dayList(m[1]) : null;
      if (set && days === null) { days = set; t = t.slice(0, m.index); continue; }
      break;
    }
    let start = null, end = null;
    const b = BLOCK.exec(t);
    if (b && +b[1] <= 24 && +b[3] <= 24) {
      start = +b[1] * 60 + +(b[2] || 0);
      end = +b[3] * 60 + +(b[4] || 0);
      if (end <= start) end += 1440;                    // overnight
      t = b[5];
    }
    const [name = '', ...where] = t.split(/\s+·\s+/);
    return { name: name.trim(), where: where.join(' · ').trim(), start, end, system, days, q };
  }

  /**
   * `# Week`, or `# Week from 2026-10-19`. Lines above the first weekday label are for every
   * day; lines under a label are for its days; a day may sit under several labels.
   * -> `{ from, head, line, lines: [{ line, name, where, start, end, system, days, q }] }`
   */
  function parseWeek(sec) {
    const m = /^week\s+from\s+(\d{4}-\d{2}-\d{2})$/i.exec(sec.head.trim());
    const lines = [];
    let scope = null;
    for (const { n, text } of sec.body) {
      if (!text.trim()) continue;
      const b = BULLET.exec(text);
      if (b) {
        const l = parseWeekLine(b[1]);
        lines.push({ ...l, line: n, days: l.days || scope || EVERY_DAY() });
        continue;
      }
      const set = weekdaysOfLabel(text);
      if (set) scope = set;
    }
    return { from: m ? m[1] : null, head: sec.head, line: sec.line, lines };
  }

  /* ------------------------------------------------------------------ the days */

  /** The cells of a table row, as written between the pipes (not trimmed). */
  function rawCells(row) {
    let t = String(row).trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/);
  }
  const isDelimiter = (row) => /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(row);

  /** What a cell says: "x" done, "." due and not done, "-" skipped on purpose, "" nothing. */
  function markOf(cell) {
    const t = String(cell ?? '').trim();
    if (!t) return '';
    if (t === '.') return '.';
    if (t === '-' || t === '–') return '-';
    return 'x';
  }

  /**
   * `# Days`: one table, a row per day. The header names the columns: `Day`, one per system,
   * and `Note`.
   * -> `{ header, delimiter, cols, systems, noteCol, widths, rows: Map(day -> { line, raw, day, marks, note }) }`
   */
  function parseDays(sec) {
    const t = { header: null, delimiter: null, cols: [], systems: [], noteCol: -1, widths: [], rows: new Map() };
    for (const { n, text } of sec.body) {
      if (!/^\s*\|/.test(text)) continue;
      const raw = rawCells(text);
      const c = raw.map((x) => x.trim());
      if (!t.header) {
        t.header = { line: n, raw: text };
        t.cols = c.map(strip);
        t.noteCol = t.cols.findIndex((h, i) => i > 0 && (h === 'note' || h === 'notes'));
        t.systems = t.cols.filter((h, i) => i > 0 && i !== t.noteCol && h);
        // the width each cell is padded to: the header's own, less the space on each side
        t.widths = raw.map((x) => Math.max(1, x.length - 2));
        continue;
      }
      if (isDelimiter(text)) { t.delimiter = { line: n, raw: text }; continue; }
      const day = parseInt(c[0], 10);
      if (!(day >= 1 && day <= 31)) continue;
      const marks = {};
      t.cols.forEach((h, i) => { if (i > 0 && i !== t.noteCol && h) marks[h] = markOf(c[i]); });
      const note = t.noteCol >= 0 ? String(c[t.noteCol] ?? '').replace(/\\\|/g, '|') : '';
      t.rows.set(day, { line: n, raw: text, day: c[0], marks, note });
    }
    return t;
  }

  /** A day row as the app writes it: every cell padded to its header's width. */
  function formatRow(t, dayCell, marks, note) {
    const cellsOut = t.cols.map((h, i) => {
      if (i === 0) return String(dayCell).padEnd(t.widths[0]);
      if (i === t.noteCol) return String(note ?? '').replace(/\|/g, '\\|').padEnd(t.widths[i]);
      return String(marks[h] ?? '').padEnd(t.widths[i]);
    });
    return `| ${cellsOut.join(' | ')} |`;
  }

  /** The header, the delimiter and one empty row per day: what "Start <month>" writes under `# Days`. */
  function emptyDays(year, month, systems) {
    const cols = ['Day', ...systems, 'Note'];
    const widths = cols.map((c, i) => (i === 0 ? 6 : Math.max(c.length, 1)));
    const t = { cols: cols.map(strip), noteCol: cols.length - 1, widths };
    const out = [
      `| ${cols.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`,
      `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`,
    ];
    for (let d = 1; d <= daysIn(year, month); d++) {
      out.push(formatRow(t, `${two(d)} ${DAY_FR[dayIndex(new Date(year, month - 1, d))]}`, {}, ''));
    }
    return out;
  }

  /* ------------------------------------------------------------------ the review */

  /**
   * `# Review`: prose. A `Grade: 7/10` line grades the area whose label is above it, and
   * `Overall: 6/10` the whole month or year. Until it is written the section holds a gap line.
   */
  function parseReview(sec) {
    const text = sec.body.map((l) => l.text).join('\n').trim();
    const gap = /^_gap:[\s\S]*_$/i.test(text);
    const grades = [];
    let overall = null, label = null;
    for (const { text: t } of sec.body) {
      const l = t.trim().replace(/^\*\*|\*\*$/g, '');
      if (isLabel(l)) { label = l; continue; }
      const g = /^(grade|overall)\s*:\s*(\d+(?:[.,]\d+)?)\s*\/\s*(\d+)/i.exec(l);
      if (!g || !+g[3]) continue;
      const n = Math.round((parseFloat(g[2].replace(',', '.')) / +g[3]) * 100) / 10;      // out of 10
      if (/overall/i.test(g[1])) overall = n; else grades.push({ label, n });
    }
    return { text, gap, written: !!text && !gap, grades, overall, line: sec.line };
  }

  const NO_REVIEW = { text: '', gap: false, written: false, grades: [], overall: null, line: -1 };

  /* ------------------------------------------------------------------ a month, a year */

  /**
   * A month file. `ym` is its name, `2026-10`.
   */
  function parseMonth(text, ym) {
    const secs = sections(text);
    const find = (re) => secs.find((s) => re.test(s.head.trim()));
    const title = secs[0] || { head: '', body: [] };
    const goals = find(/^goals$/i), days = find(/^days$/i), review = find(/^(?:monthly\s+)?review$/i);
    const weeks = secs.filter((s) => /^week(?:\s+from\s+\d{4}-\d{2}-\d{2})?$/i.test(s.head.trim())).map(parseWeek);
    weeks.sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
    const [year, month] = ym.split('-').map(Number);
    return {
      ym, year, month,
      title: title.head,
      intro: title.body.map((l) => l.text).join('\n').trim(),
      goals: goals ? parseGoals(goals.body) : [],
      weeks,
      days: days ? parseDays(days) : null,
      review: review ? parseReview(review) : NO_REVIEW,
    };
  }

  /** A year file: the title and its intro, Goals, Review. */
  function parseYear(text, year) {
    const secs = sections(text);
    const find = (re) => secs.find((s) => re.test(s.head.trim()));
    const title = secs[0] || { head: '', body: [] };
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

  const dateOf = (month, day) => new Date(month.year, month.month - 1, day);

  /** The week in force on a date: the last `Week from` that has begun, else `# Week`. */
  function weekFor(month, date) {
    const d = ymd(date);
    let cur = null;
    for (const w of month.weeks) if (!w.from || w.from <= d) cur = w;
    return cur;
  }

  /** The day's lines: the timed ones in the order of the day, then the others. */
  function linesFor(month, date) {
    const w = weekFor(month, date);
    if (!w) return [];
    const wd = dayIndex(date);
    const list = w.lines.filter((l) => l.days.has(wd));
    return [
      ...list.filter((l) => l.start !== null).sort((a, b) => a.start - b.start || a.line - b.line),
      ...list.filter((l) => l.start === null),
    ];
  }

  /** The systems planned on a date, in the order of the day. */
  function plannedSystems(month, date) {
    const out = [];
    for (const l of linesFor(month, date)) if (l.system && !out.includes(l.system)) out.push(l.system);
    return out;
  }

  /**
   * The columns a new month's table opens with: the systems in the order the week meets them,
   * Monday first, the lines with no time last.
   */
  function systemsOf(month) {
    const timed = [], untimed = [];
    for (const w of month.weeks) {
      for (let wd = 0; wd < 7; wd++) {
        const list = w.lines.filter((l) => l.days.has(wd) && l.system);
        for (const l of list.filter((x) => x.start !== null).sort((a, b) => a.start - b.start)) if (!timed.includes(l.system)) timed.push(l.system);
        for (const l of list.filter((x) => x.start === null)) if (!untimed.includes(l.system)) untimed.push(l.system);
      }
    }
    return [...timed, ...untimed.filter((s) => !timed.includes(s))];
  }

  /** Every system the month knows: the table's columns, then any the weeks add. */
  function allSystems(month) {
    const out = month.days ? [...month.days.systems] : [];
    for (const s of systemsOf(month)) if (!out.includes(s)) out.push(s);
    return out;
  }

  /**
   * The words a system is shown under: the name of its first line in the month's weeks, up to
   * the first comma (`Maths, semaine puis annales` -> `Maths`). A column no week has a line for
   * keeps its own word.
   */
  function nameOf(month, sys) {
    for (const w of month.weeks) {
      const l = w.lines.find((x) => x.system === sys);
      if (l) return l.name.split(',')[0].trim() || sys;
    }
    return sys;
  }

  /**
   * How one day went: `{ done, due, share, when }`. `share` is done over due, null when nothing
   * counts. `when` is "past", "today" (the open lines count as due, so the share is the day so
   * far), "future", or "idle" for a day before the month's first mark.
   */
  function dayShare(month, day, today) {
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

  /** The first day of the month that has a mark: the month counts from there. Null when none. */
  function firstMarked(month) {
    if (!month.days) return null;
    let first = null;
    for (const [day, row] of month.days.rows) {
      if (Object.values(row.marks).some(Boolean) && (first === null || day < first)) first = day;
    }
    return first;
  }

  /**
   * One system on one day.
   *   "done"     marked x
   *   "skipped"  marked -, dropped on purpose: it counts for nothing
   *   "missed"   due (marked . or planned), the day is over, not done
   *   "open"     due today, not done yet
   *   "planned"  due on a day to come
   *   "idle"     planned, but before the month's first marked day: it counts for nothing
   *   null       nothing planned, nothing marked
   */
  function stateOf(month, day, sys, today) {
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

  /** `done / due` for a set of (day, system) pairs. Today's open lines are not due yet. */
  function count(month, today, { days = null, systems = null } = {}) {
    const t = { done: 0, due: 0, skipped: 0 };
    const last = daysIn(month.year, month.month);
    const sys = systems || allSystems(month);
    for (let d = 1; d <= last; d++) {
      if (days && !days.includes(d)) continue;
      for (const s of sys) {
        const st = stateOf(month, d, s, today);
        if (st === 'done') { t.done++; t.due++; } else if (st === 'missed') t.due++;
        else if (st === 'skipped') t.skipped++;
      }
    }
    return t;
  }

  /** The month so far: the tally, the day it counts from, and the days left without a mark. */
  function monthTally(month, today) {
    const t = count(month, today);
    const first = firstMarked(month);
    const now = startOfDay(today);
    let blank = 0;
    if (first !== null) {
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
   * Days in a row a system was done, back from `from` (today when not given), across months
   * (`months` is a Map of `YYYY-MM` -> month). A day it was not due, a skipped day and today
   * still open do not break it; a missed day does, and so does the edge of what was recorded.
   */
  function streak(months, sys, today, from = today) {
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

  /** Minutes a week gives each system: `Map(system -> minutes)`. */
  function weekMinutes(week) {
    const out = new Map();
    for (const l of week.lines) {
      if (l.start === null || !l.system) continue;
      out.set(l.system, (out.get(l.system) || 0) + (l.end - l.start) * l.days.size);
    }
    return out;
  }

  /* ------------------------------------------------------------------ what the app writes */

  /**
   * The one line a tick changes: `{ line, expected, next }`, the arguments of `replaceLine`.
   * The first mark of a day also writes a `.` under everything planned that day, so the row
   * says on its own what was due, whatever the week becomes later.
   * @param mark "x" | "." | "-" | ""
   */
  function writeMark(month, day, sys, mark) {
    const t = month.days;
    const row = t.rows.get(day);
    if (!row) return null;
    const marks = { ...row.marks };
    if (!Object.values(marks).some(Boolean)) {
      for (const s of plannedSystems(month, dateOf(month, day))) if (t.systems.includes(s)) marks[s] = '.';
    }
    marks[sys] = mark;
    return { line: row.line, expected: row.raw, next: formatRow(t, row.day, marks, row.note) };
  }

  /** A goal's box, flipped: `{ line, expected, next }`. */
  function writeGoal(goal) {
    if (!goal.box) return null;
    const next = goal.box === 'done' ? goal.raw.replace(/\[[xX]\]/, '[ ]') : goal.raw.replace(/\[ \]/, '[x]');
    return { line: goal.line, expected: goal.raw, next };
  }

  const api = {
    strip, two, ymd, ymOf, parseYmd, startOfDay, addDays, dayIndex, daysIn, hhmm, DAY_FR,
    sections, parseGoals, parseWeek, parseWeekLine, weekdaysOfLabel, dayList, parseDays, markOf, formatRow,
    emptyDays, parseReview, parseMonth, parseYear,
    dateOf, weekFor, linesFor, plannedSystems, systemsOf, allSystems, nameOf, dayShare, firstMarked, stateOf, count,
    monthTally, streak, weekMinutes, writeMark, writeGoal,
  };
  root.Planner = api;
})(typeof window !== 'undefined' ? window : globalThis);
