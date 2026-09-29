// The planner's date logic, on date-fns (L10). Pure: no DOM, no `ose:*`, no vault path, so the
// tests import it as it is. Every date here is a local `Date`; a day is its calendar date in
// the machine's time zone, exactly as the file names are written (`2026-09-26.md`).
//
// Two notations are Hassan's own and stay: a time of day is `17h30`, and a week starts on
// Monday. The calendar's (Q1)/(Q2) markers alternate week by week from an anchor, a Monday
// that starts a Q1 week, and never by the ISO week number: a year of 53 ISO weeks (2020, 2026)
// ends odd and the next one starts odd, which would swap Q1 and Q2 every January after one.

import {
  addDays, addMonths, differenceInCalendarDays, differenceInCalendarWeeks, eachDayOfInterval,
  endOfMonth, format, getISODay, getISOWeek, isSameDay, isValid, startOfDay, startOfISOWeek,
  startOfMonth,
} from 'date-fns';

export { addDays, addMonths, isSameDay, startOfDay, startOfMonth };

/** Short month names as the app writes them elsewhere: British, `Sept` rather than `Sep`. */
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

/** Monday first, the order the calendar's headings and the week grid use. */
export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ------------------------------------------------------------------ names */

/**
 * `2026-09-26`.
 */
export const ymd = (d: Date): string => format(d, 'yyyy-MM-dd');

/**
 * `2026-09`.
 */
export const ym = (d: Date): string => format(d, 'yyyy-MM');

/**
 * `2026-09-26` -> a local Date at midnight, or null when the text is not a real date.
 */
export function parseYmd(s: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // 2026-02-31 rolls into March in the constructor; a date that rolled is not the one written
  return isValid(d) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

/**
 * The date a journal file stands for, from its name: `2026-09-06.md`,
 * `2026-09-06 - Journal.md`. A digit right after the date means it is not one
 * (`2026-09-061.md`). -> a local Date, or null.
 */
export function dateFromName(name: string): Date | null {
  const n = String(name ?? '');
  if (!/^\d{4}-\d{2}-\d{2}(?!\d)/.test(n)) return null;
  return parseYmd(n);
}

/**
 * The Day view's title, with the year (L16): `Saturday 26 September 2026`.
 */
export const dayTitle = (date: Date): string => format(date, 'EEEE d MMMM yyyy');

/**
 * The Month view's title: `September 2026`.
 */
export const monthTitle = (date: Date): string => format(date, 'MMMM yyyy');

/**
 * `Saturday`.
 */
export const weekdayName = (date: Date): string => format(date, 'EEEE');

/**
 * `26 Sept`, the journal's margin date and the week's range.
 */
export const shortDate = (date: Date): string => `${format(date, 'dd')} ${MONTH_SHORT[date.getMonth()]}`;

/**
 * `26/09`, the systems box and the matrix tooltips.
 */
export const ddmm = (date: Date): string => format(date, 'dd/MM');

/**
 * The name a new journal entry is written under: `2026-09-26.md`.
 */
export const journalFileName = (date: Date): string => `${ymd(date)}.md`;

/**
 * The H1 a new journal entry opens with: `# 2026-09-26 - Journal`.
 */
export const journalHeading = (date: Date): string => `# ${ymd(date)} - Journal`;

/* ------------------------------------------------------------------ days */

/**
 * Monday = 0 … Sunday = 6, the calendar's order.
 */
export const dayIndex = (date: Date): number => getISODay(date) - 1;

/**
 * The seven days of the ISO week `date` falls in, Monday first.
 */
export function weekDays(date: Date): Date[] {
  const monday = startOfISOWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/**
 * Every day of the month `date` falls in.
 */
export const monthDays = (date: Date): Date[] => eachDayOfInterval({ start: startOfMonth(date), end: endOfMonth(date) });

/**
 * Whole calendar days from `a` to `b` (positive when `b` is later).
 */
export const daysBetween = (a: Date, b: Date): number => differenceInCalendarDays(b, a);

/* ----------------------------------------------------------- alternating weeks */

/**
 * The parity of the ISO week `date` falls in (date-fns `getISOWeek`). Only the input of the
 * old `q1Parity` setting: two weeks in a row share a parity after a 53-week year.
 */
export const isoWeekParity = (date: Date): 'odd' | 'even' => (getISOWeek(date) % 2 ? 'odd' : 'even');

/**
 * The anchor for "the week of `date` is a Q1 week" (or a Q2 week when `q1` is false): the Monday
 * of that week, or the Monday before it. -> `YYYY-MM-DD`.
 */
export function q1AnchorFor(date: Date, q1: boolean = true): string {
  const monday = startOfISOWeek(date);
  return ymd(q1 ? monday : addDays(monday, -7));
}

/**
 * The old `q1Parity` ('odd' | 'even') read as an anchor on `now`: the weeks keep the Q1/Q2 they
 * had that week, and alternate from there. -> `YYYY-MM-DD`, or null for no parity.
 */
export function anchorFromParity(parity: 'odd' | 'even' | null, now: Date = new Date()): string | null {
  if (parity !== 'odd' && parity !== 'even') return null;
  return q1AnchorFor(now, isoWeekParity(now) === parity);
}

/**
 * Whether the week `date` falls in is a Q1 week. `q1` is an anchor (`YYYY-MM-DD`, any day of a
 * Q1 week) counted in whole weeks either way, or, from the old setting, an ISO week parity.
 * -> null when it is not known.
 */
export function isQ1Week(date: Date, q1: string | null): boolean | null {
  if (q1 === 'odd' || q1 === 'even') return isoWeekParity(date) === q1;
  const anchor = parseYmd(q1);
  if (!anchor) return null;
  const n = differenceInCalendarWeeks(startOfISOWeek(date), startOfISOWeek(anchor), { weekStartsOn: 1 });
  return ((n % 2) + 2) % 2 === 0;
}

/** `1`, `'1'`, `'Q1'`, `'q1'` -> 1; anything else -> null (a block of every week). */
function weekMark(q) {
  const m = /^q?([12])$/i.exec(String(q ?? '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * Whether a timetable block is on the calendar on `date`. A block with no marker is there every
 * week. With Q1 unknown (null) both (Q1) and (Q2) blocks apply and are drawn side by side, as
 * before: guessing would be wrong half the time (M33). Otherwise a (Q1) block applies in Q1
 * weeks and a (Q2) block in the others.
 * @param q1 the Q1 anchor (`YYYY-MM-DD`), an old parity ('odd' | 'even'), or null
 */
export function blockApplies(block: { q?: null | 'Q1' | 'Q2' | 1 | 2; }, date: Date, q1: string | null): boolean {
  const q = weekMark(block && block.q);
  if (!q) return true;
  const inQ1 = isQ1Week(date, q1);
  if (inQ1 === null) return true;
  return q === 1 ? inQ1 : !inQ1;
}

/* ------------------------------------------------------------------ times */

/**
 * The length of a block in minutes. An end before its start is the next morning: the block
 * wraps overnight (+24 h) and is never negative (M33). `(22*60, 1*60)` -> 180.
 * @param startMin minutes past midnight
 * @param endMin minutes past midnight
 */
export function blockMinutes(startMin: number, endMin: number): number {
  const s = Number(startMin) || 0, e = Number(endMin) || 0;
  return e >= s ? e - s : e + 24 * 60 - s;
}

const two = (n) => String(n).padStart(2, '0');

/**
 * Minutes past midnight -> `19h30`, Hassan's notation. Past midnight (an overnight block's
 * end) it wraps: 25 * 60 -> `01h00`.
 */
export const hhmm = (m: number): string => { const x = ((m % 1440) + 1440) % 1440; return `${two(Math.floor(x / 60))}h${two(x % 60)}`; };

/**
 * A duration in minutes -> `1h30`, `2h`, `45m`.
 */
export function dur(m: number): string {
  if (!m) return '0h';
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h${two(m % 60)}` : `${m / 60}h`;
}

/**
 * A countdown -> `in 1h 15m`, `in 4 min`, `now`.
 */
export function until(m: number): string {
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `in ${h}h ${r}m` : `in ${h}h`;
}

/**
 * Minutes past midnight of `date`'s time of day.
 */
export const minutesOf = (date: Date = new Date()): number => date.getHours() * 60 + date.getMinutes();

/**
 * `14:02`, the journal header's clock.
 */
export const clock = (date: Date): string => format(date, 'HH:mm');
