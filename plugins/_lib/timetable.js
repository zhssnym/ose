// The timetable format: one H1 per weekday, one line per block. Day and Week both draw it, so
// it is one file here rather than a copy in each.
//
// It used to live in `ose:md`. With 1.0.0 the kernel keeps only helpers that know nothing about
// any particular file, and a format belongs to whatever reads it. The parser is unchanged:
// pure text in, data out, no DOM and no vault path.

import { pad, DAY_SHORT } from 'ose:md';

export const TIMETABLE = {
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

const stripAccents = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// "- 17h30 à 19h30 Maths · salle 328 [maths]". The file used to carry (Q1)/(Q2) markers for
// alternating weeks; they are gone from the file and from the UI, but a line that still has one
// on either side of [type] is parsed and the marker dropped rather than ignored.
const LINE = /^\s*[-*]\s*(\d{1,2})h(\d{2})\s*(?:à|a|to)\s*(\d{1,2})h(\d{2})\s+(.+?)\s*(?:\(Q[12]\))?\s*\[([^\]]+)\]\s*(?:\(Q[12]\))?\s*$/i;

/**
 * The week, read from the calendar file. One `# Lundi`…`# Dimanche` heading per day; any other
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
