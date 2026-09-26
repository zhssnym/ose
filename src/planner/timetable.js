// The calendar format: one H1 per weekday, one line per block. Day and Week both draw it.
// Pure: text in, data out; no DOM, no `ose:*`, no vault path (docs/FORMATS.md "Calendar").
//
//   # Lundi
//   - 17h30 à 19h30 Maths · salle 328 [maths] (Q1)
//
// What changed from the plugin (M33): an overnight block (`23h00 à 07h00`) wraps to the next
// morning instead of coming out negative; an English weekday heading and a heading with words
// after the weekday (`# Lundi · semaine A`) are days, not silently dropped; the type in brackets
// may be left out; and a line under a weekday that looks like a block but cannot be read is
// counted and handed back with its line number, so the view can say so.

import { blockMinutes } from './dates.js';

export const TIMETABLE = {
  START: 7,       // first hour drawn
  END: 23.5,      // last hour drawn
  HOUR_H: 48,     // px per hour
  /** which families count as personal work in the totals */
  WORK_KINDS: [['maths', 'Maths'], ['nsi', 'NSI'], ['philo', 'Philo'], ['hg', 'HG'], ['bilan', 'Bilan']],
};

// type keyword in the file -> colour family in the grid (--c-<family>); anything else is `rest`
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

const DAYKEY = {
  lundi: 0, mardi: 1, mercredi: 2, jeudi: 3, vendredi: 4, samedi: 5, dimanche: 6,
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
};

const stripAccents = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// A time: `8h`, `08h20`, `8:20`. Hours 0-24, minutes 00-59.
const TIME = String.raw`(\d{1,2})\s*[h:]\s*(\d{2})?`;
// `- 17h30 à 19h30 Maths · salle 328 [maths] (Q1)`: the marker may sit before or after the type,
// and the type may be absent.
const LINE = new RegExp(
  String.raw`^\s*[-*+]\s*${TIME}\s*(?:à|a|to|-|–|—)\s*${TIME}\s+(.+?)\s*(?:\(Q([12])\))?\s*(?:\[([^\]]+)\])?\s*(?:\(Q([12])\))?\s*$`,
  'i',
);
/** Under a weekday, a line that tries to be a block: a bullet, or a line opening on a time. */
const LOOKS_LIKE_BLOCK = new RegExp(String.raw`^\s*(?:[-*+]\s|${TIME}\b)`, 'i');

/** `# Lundi`, `# Jeudi · semaine A`, `# Monday` -> 0..6; any other H1 -> null. */
function dayOfHeading(text) {
  const first = stripAccents(text).split(/[^a-z]+/).filter(Boolean)[0] || '';
  return first in DAYKEY ? DAYKEY[first] : null;
}

const two = (n) => String(n).padStart(2, '0');

/**
 * The week, read from the calendar file. One weekday H1 per day; any other H1 (hours per week,
 * free windows, …) closes the current day so its prose is ignored, and prose anywhere is
 * ignored. A line under a weekday that looks like a block but does not parse is `unknown`.
 *
 * -> `{ events, unknown }`
 *   events  `[{ d, s:'17:30', e:'19:30', sm, em, t, sub?, type, kind, q, overnight?, line }]`,
 *           sorted by day then start. `sm`/`em` are minutes past midnight of day `d`; an
 *           overnight block has `em` past 24 h (sm + its length). `q` is null, 'Q1' or 'Q2'.
 *           `line` is 1-based.
 *   unknown `[{ line, text }]`, `line` 1-based.
 * @param {string} text
 * @returns {{events: object[], unknown: Array<{line: number, text: string}>}}
 */
export function parseTimetable(text) {
  const events = [], unknown = [];
  let day = null;
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.trim();
    if (/^#\s/.test(l)) { day = dayOfHeading(l.slice(2)); continue; }
    if (day === null || !l) continue;
    const m = l.match(LINE);
    const bad = () => { if (LOOKS_LIKE_BLOCK.test(l)) unknown.push({ line: i + 1, text: raw }); };
    if (!m) { bad(); continue; }
    const [, h1, m1 = '00', h2, m2 = '00', body, qBefore, typeRaw, qAfter] = m;
    if (+h1 > 24 || +h2 > 24 || +m1 > 59 || +m2 > 59) { bad(); continue; }
    const sm = +h1 * 60 + +m1;
    const endRaw = +h2 * 60 + +m2;
    const kind = typeRaw ? stripAccents(typeRaw) : '';
    const [title, ...rest] = body.split(/\s+·\s+/);
    const q = qBefore || qAfter;
    const ev = {
      d: day,
      s: `${two(h1)}:${m1}`, e: `${two(h2)}:${m2}`,
      sm, em: sm + blockMinutes(sm, endRaw),
      t: title.trim(), type: TYPES[kind] || 'rest', kind,
      q: q ? `Q${q}` : null,
      line: i + 1,
    };
    if (rest.length) ev.sub = rest.join(' · ').trim();
    if (endRaw < sm) ev.overnight = true;
    events.push(ev);
  }
  events.sort((a, b) => a.d - b.d || a.sm - b.sm || a.line - b.line);
  return { events, unknown };
}

/**
 * The blocks of one day placed in columns, so that two that share an hour sit side by side
 * instead of one over the other: the alternating (Q1) and (Q2) blocks, while the parity is
 * unknown, are that case. Blocks that touch in time form one cluster and split its width; a
 * cluster of one is lane 0 of 1, the whole column.
 * @param {object[]} list events of one day
 * @returns {Array<{e: object, lane: number, lanes: number}>} lane is 0-based
 */
export function lanes(list) {
  const out = [];
  let cluster = [], ends = [], clusterEnd = -1;
  const close = () => {
    for (const row of cluster) row.lanes = ends.length;
    out.push(...cluster);
    cluster = []; ends = [];
  };
  for (const e of [...list].sort((a, b) => a.sm - b.sm || a.em - b.em)) {
    if (cluster.length && e.sm >= clusterEnd) close();
    clusterEnd = cluster.length ? Math.max(clusterEnd, e.em) : e.em;
    let lane = ends.findIndex((end) => end <= e.sm);
    if (lane < 0) { lane = ends.length; ends.push(0); }
    ends[lane] = e.em;
    cluster.push({ e, lane, lanes: 1 });
  }
  close();
  return out;
}
