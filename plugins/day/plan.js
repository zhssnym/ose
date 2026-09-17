// The one derived path either chronological view needs: the plan file for a month inside the
// plans folder. Names are tolerant (docs/CONTRACT.md batch 5) — the year folder is listed and
// any `2026-09*.md` is September, the exact `2026-09.md` winning when several match — so this
// needs a folder listing and cannot be a pure string helper in `ose:md`.
//
// The month module carries the same twenty lines: a module never imports another module.

import { planDir, planPath, pickDatedFile, ym } from 'ose:md';

/**
 * `resolvePlanPath(files, date, dir)` -> `{ path, dir, exists }`. When the year folder cannot
 * be listed, or holds no file for that month, the canonical `<plans>/2026/2026-09.md` is
 * answered with `exists: false`, so the view always has a path to name in its "missing" line.
 */
export async function resolvePlanPath(files, d, dir) {
  const folder = planDir(d, dir);
  const fallback = planPath(d, dir);
  let names = null;
  try {
    names = (await files.list(folder)).filter((n) => n.kind === 'file').map((n) => n.name);
  } catch { /* the year folder is not there; the fallback path names what is missing */ }
  if (!names) return { path: fallback, dir: folder, exists: false };
  const hit = pickDatedFile(names, ym(d));
  return hit
    ? { path: `${folder}/${hit}`, dir: folder, exists: true }
    : { path: fallback, dir: folder, exists: false };
}
