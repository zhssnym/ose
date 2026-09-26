// `ose.watch` (docs/KERNEL.md): the vault watcher, with folder filters.
//
//   ose.watch(fn)             every change
//   ose.watch(folders, fn)    only changes under those vault folders
//
// `fn({ changes: [{ kind, path, to? }], lost?, rescan? })`. `lost` is the host saying the vault
// itself went away; `rescan` is the host saying it may have missed events (the OS watcher
// overflowed, or restarted after an error) and the caller should re-read what it shows rather
// than trust the list. One subscription to the bridge serves every caller; a subscriber that
// throws is logged and the others still run.

import { bridge } from './bridge/index.js';
import { clean } from './paths.js';

const subs = new Set();   // { folders: string[] | null, fn }
let wired = false;

const under = (path, folder) => {
  const p = clean(path);
  const f = clean(folder);
  return !f || p === f || p.startsWith(f + '/');
};

function wire() {
  if (wired) return;
  wired = true;
  bridge.on('fs', (data) => {
    const payload = normalize(data);
    for (const s of [...subs]) {
      const changes = s.folders
        ? payload.changes.filter((c) => s.folders.some((f) => under(c.path, f) || (c.to && under(c.to, f))))
        : payload.changes;
      // A `lost` or `rescan` notice reaches everybody: it is about the watcher, not about a
      // path, and a caller that filters folders still has to re-read its own.
      if (!changes.length && !payload.lost && !payload.rescan) continue;
      try { s.fn({ changes, lost: payload.lost, rescan: payload.rescan }); } catch (e) { console.error('[watch]', e); }
    }
  });
}

/**
 * The host's one shape, `{ changes, lost?, rescan? }` (docs/HOST.md "Events"). The host and
 * the kernel ship in the same executable, so the older shapes are not read any more (M47).
 */
function normalize(data) {
  const changes = data && Array.isArray(data.changes) ? data.changes.filter((c) => c && c.path) : [];
  return { changes, lost: !!(data && data.lost), rescan: !!(data && data.rescan) };
}

export function watch(a, b) {
  const folders = typeof a === 'function' ? null : (Array.isArray(a) ? a : [a]).map(clean).filter(Boolean);
  const fn = typeof a === 'function' ? a : b;
  if (typeof fn !== 'function') throw new Error('watch: a function is required');
  wire();
  const entry = { folders: folders && folders.length ? folders : null, fn };
  subs.add(entry);
  return () => subs.delete(entry);
}
