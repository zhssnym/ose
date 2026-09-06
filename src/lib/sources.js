// Where the views read their data from. One key per file the app depends on, so a note can be
// moved in the vault without a code change: the user repoints it in Settings and every view
// re-reads. Owned by the shell (it loads and persists them), read by everyone.
//
//   import { getSource } from '../lib/sources.js'
//   const path = getSource('timetable')
//   bus.on('sources', ({ key, path }) => { if (key === 'timetable') refresh(); })
//
// Persisted under state `sources` through patchState, never through bridge.setState.
import { bus } from '../registry.js';
import { patchState, stateCache } from '../shell/state.js';

export const SOURCE_DEFAULTS = Object.freeze({
  timetable: 'Learning/School/0-index/Timetable.md',
  plans: 'Personal/3. Action',
  systemsLog: 'Personal/3. Action/systems-log.jsonl',
  todo: 'Personal/1. Life/Todo.md',
});

/** What each key is, and what a picker may offer for it. `dir` keys are folders. */
export const SOURCE_INFO = Object.freeze({
  timetable: { title: 'Timetable', note: 'week view', ext: 'md' },
  plans: { title: 'Plans folder', note: 'month view', dir: true },
  systemsLog: { title: 'Systems log', note: 'month, day', ext: 'jsonl' },
  todo: { title: 'Todo', note: 'day view', ext: 'md' },
});

export const SOURCE_KEYS = Object.freeze(Object.keys(SOURCE_DEFAULTS));

const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

let current = { ...SOURCE_DEFAULTS };

/** The vault-relative path for a key. Unknown keys return '' rather than throwing. */
export function getSource(key) {
  return Object.prototype.hasOwnProperty.call(current, key) ? current[key] : '';
}

/** All of them, as a plain object. A copy: mutating it changes nothing. */
export function allSources() { return { ...current }; }

export function isDefaultSource(key) { return getSource(key) === SOURCE_DEFAULTS[key]; }

/**
 * Point a key at another path. Persists and emits `sources` so the views re-read.
 * `null` restores the default. No-ops when the value is unchanged.
 */
export function setSource(key, path) {
  if (!Object.prototype.hasOwnProperty.call(SOURCE_DEFAULTS, key)) return getSource(key);
  const next = path == null || path === '' ? SOURCE_DEFAULTS[key] : clean(path);
  if (next === current[key]) return next;
  current[key] = next;
  persist();
  bus.emit('sources', { key, path: next });
  return next;
}

/** Only the keys that differ from the defaults are written, so defaults can move later. */
function persist() {
  const diff = {};
  for (const k of SOURCE_KEYS) if (current[k] !== SOURCE_DEFAULTS[k]) diff[k] = current[k];
  patchState({ sources: Object.keys(diff).length ? diff : undefined });
}

/**
 * Read the saved overrides out of App/state.json. The shell calls this in initShell, before any
 * view mounts. Safe to call with nothing: falls back to the live state cache, then to defaults.
 */
export function loadSources(state) {
  const s = state === undefined ? stateCache() : state;
  const saved = s && typeof s === 'object' ? s.sources : null;
  current = { ...SOURCE_DEFAULTS };
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const k of SOURCE_KEYS) {
      const v = saved[k];
      if (typeof v === 'string' && clean(v)) current[k] = clean(v);
    }
  }
  return allSources();
}
