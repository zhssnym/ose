// `ose.schedule(id, spec, fn)` (docs/PLUGINS.md): run something while the app is open, and
// catch up once at boot when a run was missed. Nothing runs when Ose is closed; this is a
// reminder loop, not cron.
//
//   spec: { every: 'day' | 'hour' | 'week', at: '07:00', weekday?: 0-6 }
//         or { everyMs: 900000 }
//
// The last run of each id is kept in `.ose/state.json` under `schedules`, so the catch-up
// survives a restart and a run that already happened today does not happen twice.

import { patchState, stateCache } from './state.js';

const timers = new Map();   // id -> timeout handle

const HOUR = 3600000;
const DAY = 24 * HOUR;

function lastRun(id) {
  const all = stateCache().schedules || {};
  const t = all[id];
  return Number.isFinite(t) ? t : 0;
}

function markRun(id, when) {
  const all = { ...(stateCache().schedules || {}) };
  all[id] = when;
  patchState({ schedules: all });
}

/** The next moment `spec` is due after `from`, as a timestamp. */
export function nextAfter(spec, from) {
  const d = new Date(from);
  if (Number.isFinite(spec.everyMs)) return from + Math.max(1000, spec.everyMs);
  const [h, m] = String(spec.at || '00:00').split(':').map((n) => parseInt(n, 10) || 0);
  if (spec.every === 'hour') {
    const next = new Date(d);
    next.setMinutes(m, 0, 0);
    if (next.getTime() <= from) next.setTime(next.getTime() + HOUR);
    return next.getTime();
  }
  const next = new Date(d);
  next.setHours(h, m, 0, 0);
  if (spec.every === 'week') {
    const want = Number.isInteger(spec.weekday) ? spec.weekday : 1;
    let ahead = (want - next.getDay() + 7) % 7;
    if (ahead === 0 && next.getTime() <= from) ahead = 7;
    next.setDate(next.getDate() + ahead);
    return next.getTime();
  }
  if (next.getTime() <= from) next.setTime(next.getTime() + DAY);
  return next.getTime();
}

/** True when the last run is older than the most recent moment `spec` was due. */
export function isOverdue(spec, last, now) {
  if (!last) return false;                      // never run: the first run is the next due one
  const dueBefore = nextAfter(spec, now - (Number.isFinite(spec.everyMs) ? spec.everyMs : DAY) - 1000);
  return dueBefore <= now && last < dueBefore;
}

export function schedule(id, spec, fn) {
  if (!id || typeof fn !== 'function') throw new Error('schedule: id and fn required');
  const key = String(id);
  cancel(key);

  const fire = (when) => {
    markRun(key, when);
    try { fn(); } catch (e) { console.error(`[schedule:${key}]`, e); }
  };

  const arm = () => {
    const now = Date.now();
    const at = nextAfter(spec || {}, now);
    // setTimeout tops out near 24.8 days; a weekly schedule is armed in steps under that.
    const wait = Math.min(Math.max(at - now, 1000), 20 * DAY);
    timers.set(key, setTimeout(() => {
      if (Date.now() + 1000 >= at) fire(Date.now());
      arm();
    }, wait));
  };

  // The catch-up: one run at boot when the app was closed over a due moment.
  if (isOverdue(spec || {}, lastRun(key), Date.now())) fire(Date.now());
  arm();

  return () => cancel(key);
}

export function cancel(id) {
  const t = timers.get(String(id));
  if (t) { clearTimeout(t); timers.delete(String(id)); }
}

export function cancelAll() {
  for (const id of [...timers.keys()]) cancel(id);
}
