// Where the views read from. `src/lib/sources.js` is the shell's module: it owns the persisted
// `sources` state, the settings rows and the `sources` bus event. This is the views' thin
// adapter over it, and it exists for three reasons only:
//   - `setSourceOverride`, which points a key somewhere else for this session without touching
//     the persisted state, so the harness can run against copies under the scratch folder
//   - `resolvePlanPath`, the one derived path (a month's file inside the plans folder), which
//     needs a folder listing because plan file names are tolerant
//   - the batch-5 defaults, so a view is never left reading a path from the old vault layout
// Everything else is passed straight through.

import { bus } from '../registry.js';
import { getSource as shellSource } from '../lib/sources.js';
import {
  TIMETABLE, PLAN_DIR, SYSTEMS_LOG, TODO_PATH, JOURNAL_DIR, SCRATCH_DIR,
  planPath, planDir, pickDatedFile, ym,
} from '../lib/md.js';
import { bridge } from '../bridge/index.js';

/**
 * The six sources of CONTRACT.md batch 5, with the vault's current layout as the default.
 * The shell owns the same list; these are what the views use when it cannot answer.
 */
export const SOURCE_DEFAULTS = Object.freeze({
  timetable: TIMETABLE.PATH,          // 2-learning/1-school/0-index/Timetable.md
  plans: PLAN_DIR,                    // 1-personal/3-execution
  systemsLog: SYSTEMS_LOG,            // 1-personal/3-execution/systems.jsonl
  todo: TODO_PATH,                    // 0-tasks              (a folder, or a single .md file)
  journal: JOURNAL_DIR,               // 1-personal/4-journal
  scratch: SCRATCH_DIR,               // 7-scratchpad
});

/**
 * The defaults of the previous layout. The shell's `lib/sources.js` still answers with these
 * until its batch-5 rewrite lands; none of them exists in the vault any more, so a value equal
 * to one of them means "nobody has chosen anything" and the new default is used instead. A path
 * the user really picked is never one of these, so this is invisible once the shell is updated.
 */
const RETIRED = new Set([
  'Learning/School/0-index/Timetable.md',
  'Personal/3. Action',
  'Personal/3. Action/systems-log.jsonl',
  'Personal/1. Life/Todo.md',
  'Personal/4. Journal',
  'Todo.md',
  'Scratchpad',
]);

/** A vault path: forward slashes, no leading or trailing slash. */
const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

const override = new Map();     // harness / test overrides, ahead of everything

/** The vault path for a source key. Never empty: an unset key falls back to the default. */
export function getSource(key) {
  if (override.has(key)) return override.get(key);
  try {
    const p = clean(shellSource(key));
    if (p && !RETIRED.has(p)) return p;
  } catch (e) { console.warn('[views] getSource', key, e); }
  return SOURCE_DEFAULTS[key] || '';
}

/**
 * Point one key somewhere else for this session only, without touching the persisted state.
 * `null` gives the key back to settings. Emits `sources` exactly as `setSource` does, so the
 * views re-read the same way whether the change came from settings or from a test.
 */
export function setSourceOverride(key, path) {
  if (path == null) override.delete(key);
  else override.set(key, clean(path));
  bus.emit('sources', { key, path: getSource(key) });
}

/** Subscribe to source changes, from settings or from an override. -> unsubscribe */
export const onSources = (fn) => bus.on('sources', fn);

/**
 * The plan file for a date under the configured plans folder. Names are tolerant: the folder
 * `<plans>/2026` is listed and any `2026-09*.md` is September, the exact `2026-09.md` winning
 * when several match. When the year folder cannot be listed, or holds no file for that month,
 * the canonical `<plans>/2026/2026-09.md` is returned, so the view always has a path to name.
 * -> { path, dir, exists }
 */
export async function resolvePlanPath(d, dir = getSource('plans')) {
  const folder = planDir(d, dir);
  const fallback = planPath(d, dir);
  let names = null;
  try {
    names = (await bridge.list(folder)).filter((n) => n.kind === 'file').map((n) => n.name);
  } catch { /* the year folder is not there; the fallback path names what is missing */ }
  if (!names) return { path: fallback, dir: folder, exists: false };
  const hit = pickDatedFile(names, ym(d));
  return hit
    ? { path: `${folder}/${hit}`, dir: folder, exists: true }
    : { path: fallback, dir: folder, exists: false };
}

/** Just the path, for callers that only need something to print. */
export const sourcePlanPath = async (d) => (await resolvePlanPath(d)).path;
