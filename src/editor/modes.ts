// Which mode a page opens in (wave 3, X1, contract §4.5).
//
// Three modes edit a markdown file: Rich (Crepe), Live (CodeMirror with the markup drawn) and
// Source (CodeMirror, plain). A file that is not markdown has one, Source. Two things decide
// which one a markdown file opens in:
//
//   - the file's own memory: the mode it was last left in, per machine and per vault, in
//     `ose.local('pageModes')` as `{ [vaultPath]: mode }`. Insertion order is recency, and the
//     oldest entries go past MAX. A forced mode (a plain file, a page the rich view could not
//     hold) is never remembered, and neither is a file outside the vault;
//   - the machine setting `editorMode` (default 'rich'), for a file that remembers nothing.
//
// This replaces `sourcePages` in `.ose/state.json`, the list of paths left in source mode that
// source.ts kept until wave 2. That list is read once, the first time a vault has no
// `pageModes` yet, and its paths come over as 'source'. It is never written again and it is not
// deleted: a copy of the vault opened by an older Ose still finds it.

import { editorModeSetting, localSlot } from './host.ts';
import { readState } from './deps.ts';
import { isOutside } from '../core/paths.ts';

export type PageMode = 'rich' | 'live' | 'source';

/** The public words, in the order the switch shows them. */
export const MODES = (['rich', 'live', 'source'] as const);

/** How many files remember a mode. Past it the least recently left go first. */
export const MAX = 300;

const KEY = 'pageModes';

export const isMode = (m: unknown): m is PageMode => m === 'rich' || m === 'live' || m === 'source';

/** The machine's default for a markdown file that remembers nothing (`editorMode`). */
export function defaultMode() {
  let m;
  try { m = editorModeSetting(); } catch { m = null; }
  return isMode(m) ? m : 'rich';
}

/**
 * The stored map, migrated from `sourcePages` the first time a vault has none. Always a fresh
 * object the caller may change; never throws.
 */
async function load(): Promise<Record<string, PageMode>> {
  const out: Record<string, PageMode> = {};
  let slot;
  try { slot = localSlot(KEY); } catch { return out; }
  const stored = slot.get();
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [path, mode] of Object.entries(stored)) if (isMode(mode)) out[path] = mode;
    return out;
  }
  // Never written in this vault on this machine: the legacy list, once.
  let state: Record<string, any> = {};
  try { state = await readState(); } catch { state = {}; }
  const legacy = Array.isArray((state as any).sourcePages) ? ((state as any).sourcePages as unknown[]) : [];
  for (const p of legacy.slice(-MAX)) if (typeof p === 'string' && p) out[p] = 'source';
  try { slot.set({ ...out }); } catch { /* kept in memory by the core, or not at all */ }
  return out;
}

function store(map: Record<string, PageMode>) {
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete map[k];
  try { localSlot(KEY).set({ ...map }); } catch { /* the next open falls back to the default */ }
}

/**
 * The mode `path` opens in: 'source' for a file that is not markdown, the machine default for a
 * file outside the vault, else what the file remembers, else the machine default.
 */
export async function modeFor(path: string, o: { plain?: boolean; outside?: boolean; } = {}): Promise<PageMode> {
  if (o.plain) return 'source';
  if (o.outside || isOutside(path) || !path) return defaultMode();
  const map = await load();
  return map[path] ?? defaultMode();
}

/**
 * A mode the user chose for `path`: it moves to the recent end. Forced modes are the caller's
 * to keep out; a path outside the vault is never remembered.
 */
export async function rememberMode(path: string, mode: PageMode): Promise<void> {
  if (!path || !isMode(mode) || isOutside(path)) return;
  const map = await load();
  if (map[path] === mode && Object.keys(map).pop() === path) return;
  delete map[path];
  map[path] = mode;
  store(map);
}

/**
 * A file, or a folder of files, moved from `from` to `to`: the memory follows it, in its place
 * in the recency order.
 */
export async function renameMode(from: string, to: string): Promise<void> {
  if (!from || !to || from === to) return;
  const map = await load();
  let changed = false;
  const next: Record<string, PageMode> = {};
  for (const [path, mode] of Object.entries(map)) {
    if (path === from || path.startsWith(from + '/')) {
      const moved = to + path.slice(from.length);
      if (!isOutside(moved)) next[moved] = mode;
      changed = true;
    } else if (!(path in next)) {
      next[path] = mode;
    }
  }
  if (changed) store(next);
}
