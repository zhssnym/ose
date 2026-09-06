// Where the app reads its data from. One key per file or folder the app depends on, so a note
// can be moved in the vault without a code change: the user repoints it in Settings and every
// view re-reads. Owned by the shell (it loads and persists them), read by everyone.
//
//   import { getSource } from '../lib/sources.js'
//   const path = getSource('timetable')
//   bus.on('sources', ({ key, path }) => { if (key === 'timetable') refresh(); })
//
// Persisted under state `sources` through patchState, never through bridge.setState.
// Nothing that used to be hard-coded (the scratch folder, the journal folder, the plans folder)
// may be spelled out anywhere else: it comes from here (CONTRACT.md batch 5).
import { bus } from '../registry.js';
import { patchState, stateCache } from '../shell/state.js';

export const SOURCE_DEFAULTS = Object.freeze({
  timetable: '2-learning/1-school/0-index/Timetable.md',
  plans: '1-personal/3-execution',
  systemsLog: '1-personal/3-execution/systems.jsonl',
  todo: '0-tasks',
  journal: '1-personal/4-journal',
  scratch: '7-scratchpad',
});

/**
 * What each key is, in the words settings shows.
 *   label     the row's name
 *   kind      'file' | 'folder' | 'either' — which picker the `choose…` control opens
 *   ext       extensions the file picker offers ('md', 'jsonl'), null for folder-only keys
 *   sentence  one sentence describing the shape of the thing, shown under the label
 */
export const SOURCE_INFO = Object.freeze({
  timetable: {
    label: 'Timetable', kind: 'file', ext: 'md',
    sentence: 'A markdown file with one H1 per weekday (Lundi … Dimanche) and one line per block: - 08h20 à 09h15 Maths · salle 333 [maths].',
  },
  plans: {
    label: 'Plans', kind: 'folder', ext: null,
    sentence: 'A folder with one subfolder per year, holding one file per month named YYYY-MM.md (anything after the date is ignored) with the sections Goals, # Systems, # Monthly Review.',
  },
  systemsLog: {
    label: 'Systems log', kind: 'file', ext: 'jsonl',
    sentence: 'An append-only JSON-lines file; the app adds one line per system check and never edits it.',
  },
  todo: {
    label: 'Todo', kind: 'either', ext: 'md',
    sentence: 'A folder (every markdown file in it is one task list) or a single markdown file, with - [ ] items and optional 📅 due dates.',
  },
  journal: {
    label: 'Journal', kind: 'folder', ext: null,
    sentence: 'A folder of one file per day named YYYY-MM-DD.md (anything after the date is ignored); the app appends, never edits.',
  },
  scratch: {
    label: 'Scratch', kind: 'folder', ext: null,
    sentence: 'The folder shown as the scratch section; new pages land here unless a folder is focused.',
  },
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

/** 'file' | 'folder' | 'either' — what the settings row may point this key at. */
export function sourceKind(key) { return (SOURCE_INFO[key] && SOURCE_INFO[key].kind) || 'file'; }

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
 *
 * A state file written before the vault was renumbered holds paths that no longer exist; they
 * load as they are and every row that points at nothing says `missing`, which is the truth.
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
