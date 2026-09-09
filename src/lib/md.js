// Shared parsers and date helpers for the plain-text formats used in D:\os.
// Ported from legacy/js/md.js and legacy/js/schedule.js, which were in daily use and correct.
// Nothing here touches the DOM or the bridge; it is pure text in, data out.

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

/* -------------------------------------------------------------- timetable */

export const TIMETABLE = {
  PATH: '2-learning/1-school/0-index/Timetable.md',
  START: 7,       // first hour drawn
  END: 23.5,      // last hour drawn
  HOUR_H: 48,     // px per hour
  DAYS: DAY_SHORT,
  /** blocks Hassan owns: the grid prints their start and end times */
  STUDY: new Set(['maths', 'nsi', 'hum', 'bilan']),
  /** which families count as personal work in the totals */
  WORK_KINDS: [['maths', 'Maths'], ['nsi', 'NSI'], ['philo', 'Philo'], ['hg', 'HG'], ['bilan', 'Bilan']],
};

// type keyword in the file -> colour family in the grid (--c-<family>)
const TYPES = {
  cours: 'class', classe: 'class', class: 'class',
  maths: 'maths', math: 'maths',
  nsi: 'nsi',
  philo: 'hum', philosophie: 'hum', hg: 'hum', histoire: 'hum', 'histoire-geo': 'hum',
  bilan: 'bilan',
  dejeuner: 'lunch', repas: 'lunch', lunch: 'lunch',
  amazon: 'work', travail: 'work', work: 'work',
  off: 'rest', recup: 'rest', libre: 'rest', rest: 'rest',
  sommeil: 'sleep', dodo: 'sleep', sleep: 'sleep',
};

const DAYKEY = { lundi: 0, mardi: 1, mercredi: 2, jeudi: 3, vendredi: 4, samedi: 5, dimanche: 6 };

// "- 17h30 à 19h30 Maths · salle 328 [maths]". Timetable.md used to carry (Q1)/(Q2) markers
// for alternating weeks; they are gone from the file and from the UI, but a line that still
// has one on either side of [type] is parsed and the marker dropped rather than ignored.
const LINE = /^\s*[-*]\s*(\d{1,2})h(\d{2})\s*(?:à|a|to)\s*(\d{1,2})h(\d{2})\s+(.+?)\s*(?:\(Q[12]\))?\s*\[([^\]]+)\]\s*(?:\(Q[12]\))?\s*$/i;

/**
 * The week, read from Timetable.md. One `# Lundi`…`# Dimanche` heading per day; any other
 * H1 (hours per week, free windows, …) closes the current day so its prose is ignored.
 * -> [{ d, s:'17:30', e:'19:30', sm, em, t, sub?, type, kind }]  sm/em = minutes past midnight
 */
export function parseTimetable(text) {
  const out = [];
  let day = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('# ')) { const k = stripAccents(l.slice(2)); day = k in DAYKEY ? DAYKEY[k] : null; continue; }
    if (day === null) continue;
    const m = l.match(LINE);
    if (!m) continue;
    const [, h1, m1, h2, m2, body, typeRaw] = m;
    const kind = stripAccents(typeRaw);
    const [title, sub] = body.split(/\s+·\s+/);
    const ev = {
      d: day,
      s: `${pad(h1)}:${m1}`, e: `${pad(h2)}:${m2}`,
      sm: +h1 * 60 + +m1, em: +h2 * 60 + +m2,
      t: title.trim(), type: TYPES[kind] || 'rest', kind,
    };
    if (sub) ev.sub = sub.trim();
    out.push(ev);
  }
  out.sort((a, b) => a.d - b.d || a.sm - b.sm);
  return out;
}

/* ----------------------------------------------------------- monthly plan */

// Default source paths: the vault's layout as of batch 5. They are the fallbacks of
// `views/sources-compat.js`; a view asks that module for the current path and passes it in, so
// nothing here reads configuration.
/** The folder holding `<year>/<YYYY-MM>.md`. */
export const PLAN_DIR = '1-personal/3-execution';
/** One append-only check log for every month. */
export const SYSTEMS_LOG = `${PLAN_DIR}/systems.jsonl`;
/** The folder of task lists (one file per list); a single `.md` file works too. */
export const TODO_PATH = '0-tasks';
/** The folder of one journal file per day. */
export const JOURNAL_DIR = '1-personal/4-journal';
/** The folder the scratch section lists and new pages land in. */
export const SCRATCH_DIR = '7-scratchpad';

/** The folder a month's plan lives in: `<dir>/2026`. */
export const planDir = (d, dir = PLAN_DIR) =>
  `${String(dir ?? PLAN_DIR).replace(/\/+$/, '')}/${d.getFullYear()}`;

/**
 * The canonical monthly plan path for a date: `<dir>/2026/2026-09.md`. The real file may be
 * named anything starting with `2026-09` (see `pickDatedFile`); this is what the views fall
 * back to when the folder cannot be listed, and what they print when nothing matches.
 */
export const planPath = (d, dir = PLAN_DIR) => `${planDir(d, dir)}/${ym(d)}.md`;

/** The name a new journal entry is written under. Existing entries may be named anything. */
export const journalFileName = (d) => `${ymd(d)}.md`;
/** The H1 a new journal entry opens with. */
export const journalHeading = (d) => `# ${ymd(d)} - Journal`;

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
 * A goal label, per `Personal/3. Action/CLAUDE.md`: a line with a single word and no bullet.
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
 * A monthly plan file, exactly as `<plans>/CLAUDE.md` defines it. Three H1 sections in this
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

/* ------------------------------------------------------------------ tasks */

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

/**
 * One markdown line -> a task, or null. `text` keeps the wording without any marker.
 */
export function parseTaskLine(raw) {
  const m = RE_TASK.exec(raw);
  if (!m) return null;
  const [, indent, box, body] = m;
  const t = {
    done: box.toLowerCase() === 'x',
    indent: indent.length,
    text: body.trim(),
    due: null, scheduled: null, start: null, doneDate: null, created: null,
    priority: 'none', recurrence: null,
  };
  const first = body.search(RE_FIRST_MARK);
  if (first >= 0) {
    t.text = body.slice(0, first).trim();
    for (const [, mark, payload] of body.slice(first).matchAll(RE_SCAN)) {
      const val = payload.trim();
      if (mark in PRIORITY) { t.priority = PRIORITY[mark]; if (val) t.text = (t.text + ' ' + val).trim(); continue; }
      switch (mark) {
        case TASK_MARK.due: t.due = val.slice(0, 10) || null; break;
        case TASK_MARK.scheduled: t.scheduled = val.slice(0, 10) || null; break;
        case TASK_MARK.start: t.start = val.slice(0, 10) || null; break;
        case TASK_MARK.done: t.doneDate = val.slice(0, 10) || null; break;
        case TASK_MARK.created: t.created = val.slice(0, 10) || null; break;
        case TASK_MARK.recur: t.recurrence = val || null; break;
      }
    }
  }
  if (!t.text) t.text = body.trim();
  return t;
}

/** Every task line in a file. `line` is the 0-based index and `raw` the exact source line. */
export function parseTasks(text, path = '') {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = parseTaskLine(lines[i]);
    if (t) out.push({ ...t, path, line: i, raw: lines[i], id: `${path}:${i}` });
  }
  return out;
}

/** Flip `[ ]` <-> `[x]` on the exact source line, keeping every other marker in place. */
export function toggleTaskLine(raw, done, today) {
  if (done) {
    let out = raw.replace(/\[ \]/, '[x]');
    if (!out.includes(TASK_MARK.done)) out = out.replace(/\s*$/, '') + ` ${TASK_MARK.done} ${today}`;
    return out;
  }
  let out = raw.replace(/\[[xX]\]/, '[ ]');
  out = out.replace(new RegExp(`\\s*${TASK_MARK.done}\\uFE0F?\\s*\\d{4}-\\d{2}-\\d{2}`, 'u'), '');
  out = out.replace(new RegExp(`\\s*${TASK_MARK.done}\\uFE0F?`, 'u'), '');
  return out.replace(/\s+$/, '');
}
