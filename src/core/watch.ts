// `ose.watch` (docs/CORE.md): the vault watcher, with folder filters.
//
//   ose.watch(fn)             every change in the vault
//   ose.watch(folders, fn)    only changes under those vault folders
//
// `fn({ changes: [{ kind, path, to?, dir?, hidden? }], lost?, rescan? })`: every change the
// host's one hide rule does not exclude (`.ose` and `.git` never reach here). `dir` and `hidden`
// say what the path is, so a tree can patch one row instead of walking again (M16). `lost` is
// the host saying the vault itself went away; `rescan` is the host saying it may have missed
// events (the OS watcher overflowed, or restarted after an error) and the caller should re-read
// what it shows rather than trust the list. One subscription to the bridge serves every caller;
// a subscriber that throws is logged and the others still run.
//
// A file outside the vault that this window opened (X7) is watched too, and its changes arrive
// with its `abs:` path. They are for the page that shows it (the editor hears every change on
// the bus), never for the tree: `ose.watch(fn)` leaves them out, and only a caller that names
// an `abs:` folder hears the ones under it.

import { bridge } from './bridge/index.ts';
import { clean, isOutside } from './paths.ts';

export type FsChange = import('./types.ts').FsChange;
export type FsEvent = import('./types.ts').FsEvent;

const subs: Set<{ folders: string[] | null; fn: (e: FsEvent) => void; }> = new Set();
let wired = false;

const under = (path: string, folder: string) => {
  const p = clean(path);
  const f = clean(folder);
  return !f || p === f || p.startsWith(f + '/');
};

/** A change inside the vault: neither its path nor where it went is an `abs:` path. */
const inVault = (c: FsChange) => !isOutside(c.path) && !(c.to && isOutside(c.to));

function wire() {
  if (wired) return;
  wired = true;
  bridge.on('fs', (data) => {
    const payload = normalize(data);
    for (const s of [...subs]) {
      const folders = s.folders;
      const changes = folders
        ? payload.changes.filter((c) => folders.some((f) => (isOutside(f) || inVault(c)) && (under(c.path, f) || (!!c.to && under(c.to, f)))))
        : payload.changes.filter(inVault);
      // A `lost` or `rescan` notice reaches everybody: it is about the watcher, not about a
      // path, and a caller that filters folders still has to re-read its own.
      if (!changes.length && !payload.lost && !payload.rescan) continue;
      try { s.fn({ changes, lost: payload.lost, rescan: payload.rescan }); } catch (e) { console.error('[watch]', e); }
    }
  });
}

/**
 * The host's one shape, `{ changes, lost?, rescan? }` (docs/HOST.md "Events"). The host and
 * the core ship in the same executable, so the older shapes are not read any more (M47).
 */
function normalize(data: unknown): { changes: FsChange[]; lost: boolean; rescan: boolean; } {
  const d = (data as Partial<FsEvent> | null | undefined);
  const changes = d && Array.isArray(d.changes) ? d.changes.filter((c) => c && c.path) : [];
  return { changes, lost: !!(d && d.lost), rescan: !!(d && d.rescan) };
}

export function watch(a: string | string[] | ((e: FsEvent) => void), b?: (e: FsEvent) => void): () => boolean {
  const folders = typeof a === 'function' ? null : (Array.isArray(a) ? a : [a]).map(clean).filter(Boolean);
  const fn = typeof a === 'function' ? a : b;
  if (typeof fn !== 'function') throw new Error('watch: a function is required');
  wire();
  const entry = { folders: folders && folders.length ? folders : null, fn };
  subs.add(entry);
  return () => subs.delete(entry);
}
