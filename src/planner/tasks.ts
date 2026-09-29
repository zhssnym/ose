// Task lines: the Obsidian Tasks syntax the todo files are written in (docs/FORMATS.md "Todo
// lines"). Pure: text in, data out; `toggleTaskLine` rewrites one line and returns it, it never
// touches a file. The Day view writes that one line back with `ose.files.replaceLine` (M31).

import { ymd } from './dates.ts';

// Obsidian Tasks markers. Written as escapes so the file survives any encoding.
export const TASK_MARK = {
  due: '\u{1F4C5}',        // calendar
  scheduled: '\u{23F3}',   // hourglass
  start: '\u{1F6EB}',      // departure
  done: '\u{2705}',        // check
  created: '\u{2795}',     // plus
  recur: '\u{1F501}',      // repeat
};
const PRIORITY = {
  '\u{1F53A}': 'highest',
  '\u{23EB}': 'high',
  '\u{1F53C}': 'medium',
  '\u{1F53D}': 'low',
  '\u{23EC}': 'lowest',
};
export const PRIORITY_RANK = { highest: 0, high: 1, medium: 2, none: 3, low: 4, lowest: 5 };

const MARK_CHARS = [...Object.values(TASK_MARK), ...Object.keys(PRIORITY)].join('');
const RE_FIRST_MARK = new RegExp(`[${MARK_CHARS}]`, 'u');
const RE_SCAN = new RegExp(`([${MARK_CHARS}])\\uFE0F?\\s*([^${MARK_CHARS}]*)`, 'gu');
const RE_TASK = /^(\s*)[-*]\s\[([ xX])\]\s+(.*)$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A marker's date, or null: `_gap: not set_` and other words after a marker are not a date. */
const dateOf = (val) => { const d = val.slice(0, 10); return RE_DATE.test(d) ? d : null; };

/**
 * One markdown line -> a task, or null. `text` keeps the wording without any marker.
 */
export function parseTaskLine(raw: string | null | undefined): any | null {
  const m = RE_TASK.exec(String(raw ?? '').replace(/^﻿/, ''));
  if (!m) return null;
  const [, indent = '', box = '', body = ''] = m;
  const t: { done: boolean; indent: number; text: string; due: string | null; scheduled: string | null; start: string | null; doneDate: string | null; created: string | null; priority: string; recurrence: string | null; } = {
    done: box.toLowerCase() === 'x',
    indent: indent.length,
    text: body.trim(),
    due: null, scheduled: null, start: null, doneDate: null, created: null,
    priority: 'none', recurrence: null,
  };
  const first = body.search(RE_FIRST_MARK);
  if (first >= 0) {
    t.text = body.slice(0, first).trim();
    for (const [, mark = '', payload = ''] of body.slice(first).matchAll(RE_SCAN)) {
      const val = payload.trim();
      if (mark in PRIORITY) { t.priority = PRIORITY[mark]; if (val) t.text = `${t.text} ${val}`.trim(); continue; }
      switch (mark) {
        case TASK_MARK.due: t.due = dateOf(val); break;
        case TASK_MARK.scheduled: t.scheduled = dateOf(val); break;
        case TASK_MARK.start: t.start = dateOf(val); break;
        case TASK_MARK.done: t.doneDate = dateOf(val); break;
        case TASK_MARK.created: t.created = dateOf(val); break;
        case TASK_MARK.recur: t.recurrence = val || null; break;
      }
    }
  }
  if (!t.text) t.text = body.trim();
  return t;
}

/**
 * Every task line in a file. `line` is the 0-based index `replaceLine` takes, and `raw` the
 * exact source line, which is what it must still read before it is replaced. A byte-order mark
 * before the first line is not part of it: it is a byte of the file, not a character of the
 * line, and the host's `replaceLine` compares line 0 without it and keeps it (wave 3).
 */
export function parseTasks(text: string, path: string = ''): any[] {
  const out: any[] = [];
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = parseTaskLine(lines[i]);
    if (t) out.push({ ...t, path, line: i, raw: lines[i], id: `${path}:${i}` });
  }
  return out;
}

/**
 * Flip `[ ]` <-> `[x]` on the exact source line, keeping every other marker in place. Done
 * adds `✅ <today>` when the line has no done marker; undone takes it away.
 * @param today `YYYY-MM-DD`
 */
export function toggleTaskLine(raw: string, done: boolean, today: string): string {
  if (done) {
    let out = raw.replace(/\[ \]/, '[x]');
    if (!out.includes(TASK_MARK.done)) out = `${out.replace(/\s*$/, '')} ${TASK_MARK.done} ${today}`;
    return out;
  }
  let out = raw.replace(/\[[xX]\]/, '[ ]');
  out = out.replace(new RegExp(`\\s*${TASK_MARK.done}\\uFE0F?\\s*\\d{4}-\\d{2}-\\d{2}`, 'u'), '');
  out = out.replace(new RegExp(`\\s*${TASK_MARK.done}\\uFE0F?`, 'u'), '');
  return out.replace(/\s+$/, '');
}

/* ---------------------------------------------------------------- buckets */

/**
 * The date a task belongs on: due, else scheduled.
 */
export const whenOf = (t: any): string | null => t.due || t.scheduled || null;

/** Late or due first by date, then priority, then file order. */
export const byDate = (a, b) => String(whenOf(a)).localeCompare(String(whenOf(b)))
  || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  || a.line - b.line;
/** Undated: priority, then file order. */
export const byPriority = (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  || a.line - b.line;

/**
 * The open tasks that belong on one day: late, due that day, and undated.
 */
export function tasksForDay(date: Date, list: any[]): { overdue: any[]; due: any[]; undated: any[]; } {
  const day = ymd(date);
  const overdue: any[] = [], due: any[] = [], undated: any[] = [];
  for (const t of list || []) {
    if (t.done) continue;
    const w = whenOf(t);
    if (!w) { undated.push(t); continue; }
    if (w < day) overdue.push(t);
    else if (w === day) due.push(t);
  }
  overdue.sort(byDate);
  due.sort(byDate);
  undated.sort(byPriority);
  return { overdue, due, undated };
}

/**
 * The same split per todo file (M34), in the order the files were given. A file with nothing
 * on that day is kept with `count: 0`, so the view can still name it.
 */
export function groupsForDay(date: Date, files: Array<{ path: string; tasks: any[]; }>): Array<{ path: string; overdue: any[]; due: any[]; undated: any[]; count: number; }> {
  return (files || []).map((g) => {
    const b = tasksForDay(date, g.tasks);
    return { path: g.path, ...b, count: b.overdue.length + b.due.length + b.undated.length };
  });
}

const INDENT_UNIT = 2;     // spaces per nesting level in the file
const MAX_DEPTH = 4;       // deeper nesting still renders, it just stops moving right

/**
 * Nesting level of a task line: a tab is one level, two spaces are one.
 */
export function taskDepth(t: { raw?: string; }): number {
  // `[\t ]*` matches every string, if only with ''.
  const lead = (/^[\t ]*/.exec(String(t.raw ?? '').replace(/^﻿/, '')) as RegExpExecArray)[0];
  const tabs = (lead.match(/\t/g) || []).length;
  const spaces = lead.length - tabs;
  return Math.min(MAX_DEPTH, tabs + Math.floor(spaces / INDENT_UNIT));
}

/**
 * The line a new task is appended as: `- [ ] <text>`, as typed, markers and all.
 * @returns '' when there is nothing to add
 */
export function newTaskLine(text: string): string {
  const t = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
  return t ? `- [ ] ${t}` : '';
}
