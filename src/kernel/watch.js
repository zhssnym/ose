// `ose.watch` (docs/KERNEL.md): the vault watcher, with folder filters.
//
//   ose.watch(fn)             every change
//   ose.watch(folders, fn)    only changes under those vault folders
//
// `fn({ changes: [{ kind, path, to? }], lost? })`. `lost` is the host saying it dropped events
// and the caller should re-read rather than trust the list. One subscription to the bridge
// serves every caller; a subscriber that throws is logged and the others still run.

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
      // A `lost` notice reaches everybody: it is about the watcher, not about a path, and a
      // caller that filters folders still has to re-read its own.
      if (!changes.length && !payload.lost) continue;
      try { s.fn({ changes, lost: payload.lost }); } catch (e) { console.error('[watch]', e); }
    }
  });
}

/** The host has spoken several shapes over the batches; every one becomes {changes, lost}. */
function normalize(data) {
  if (!data) return { changes: [], lost: false };
  if (Array.isArray(data)) return { changes: data.filter(Boolean), lost: false };
  const changes = Array.isArray(data.changes) ? data.changes.filter(Boolean)
    : (data.path ? [{ kind: data.kind || 'change', path: data.path, to: data.to }] : []);
  return { changes, lost: !!data.lost };
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
