// Where the views read from. `src/lib/sources.js` is the shell's module: it owns the persisted
// `sources` state, the settings rows and the `sources` bus event. This is the views' thin
// adapter over it, and it exists for two reasons only:
//   - `setSourceOverride`, which points a key somewhere else for this session without touching
//     the persisted state, so the harness can run against copies under Scratchpad/
//   - `sourcePlanPath`, the one derived path (a plan file inside the plans folder)
// Everything else is passed straight through. A key the shell cannot answer falls back to the
// contract default rather than to an empty path.

import { bus } from '../registry.js';
import { getSource as shellSource, SOURCE_DEFAULTS } from '../lib/sources.js';
import { planPath } from '../lib/md.js';

export { SOURCE_DEFAULTS };

/** A vault path: forward slashes, no leading or trailing slash. */
const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

const override = new Map();     // harness / test overrides, ahead of everything

/** The vault path for a source key. Never empty: an unset key falls back to the default. */
export function getSource(key) {
  if (override.has(key)) return override.get(key);
  try {
    const p = clean(shellSource(key));
    if (p) return p;
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

/** `<plans>/2026/2026-09 Monthly Plan.md` for a date, under whatever folder is configured. */
export const sourcePlanPath = (d) => planPath(d, getSource('plans'));
