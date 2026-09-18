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

// "- 17h30 à 19h30 Maths · salle 328 [maths]", with an optional (Q1) or (Q2) on either side of
// the type for a block that is only there every other week. The marker is kept: two blocks of
// the same hour, one Q1 and one Q2, are the pair the views have to tell apart.
const LINE = /^\s*[-*]\s*(\d{1,2})h(\d{2})\s*(?:à|a|to)\s*(\d{1,2})h(\d{2})\s+(.+?)\s*(?:\(Q([12])\))?\s*\[([^\]]+)\]\s*(?:\(Q([12])\))?\s*$/i;

/**
 * The week, read from the calendar file. One `# Lundi`…`# Dimanche` heading per day; any other
 * H1 (hours per week, free windows, …) closes the current day so its prose is ignored.
 * -> [{ d, s:'17:30', e:'19:30', sm, em, t, sub?, type, kind, q? }]  sm/em = minutes past
 * midnight, q = 1 or 2 on an alternating-week block and absent on a block of every week
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
    const [, h1, m1, h2, m2, body, qBefore, typeRaw, qAfter] = m;
    const kind = stripAccents(typeRaw);
    const [title, sub] = body.split(/\s+·\s+/);
    const ev = {
      d: day,
      s: `${pad(h1)}:${m1}`, e: `${pad(h2)}:${m2}`,
      sm: +h1 * 60 + +m1, em: +h2 * 60 + +m2,
      t: title.trim(), type: TYPES[kind] || 'rest', kind,
    };
    if (sub) ev.sub = sub.trim();
    const q = qBefore || qAfter;
    if (q) ev.q = +q;
    out.push(ev);
  }
  out.sort((a, b) => a.d - b.d || a.sm - b.sm);
  return out;
}

/**
 * The blocks of one day placed in columns, so that two that share an hour sit side by side
 * instead of one over the other. The alternating (Q1) and (Q2) blocks of a Thursday are that
 * case: without this the second one is painted over the first and neither can be read.
 *
 * Blocks that touch in time form one cluster and split its width between them; a cluster of one
 * is lane 0 of 1, which is the whole column, so the caller has no special case to write.
 * -> [{ e, lane, lanes }], lane 0-based
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
