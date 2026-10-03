// Where the planner's files are: the year and month files of the planner folder, flat or in a
// year folder (`<planner>/2026/2026-10.md`), flat winning. What they hold is plan.ts.
// Pure: the resolvers take the lister as an argument, so this file imports nothing that
// touches a vault.

import { ym } from './dates.ts';

/* ------------------------------------------------------------------ small text helpers */

/** Numeric-aware, case- and accent-insensitive: `2026-9` before `2026-10`. */
export const naturalCompare = (a, b) =>
  String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

/**
 * The file that stands for a date prefix in a folder listing: any `<prefix>*.md`, the exact
 * `<prefix>.md` winning, natural order after that. A digit right after the prefix (with or
 * without a separator) is another date, so `2026-09` never matches `2026-09-12.md`.
 */
export function pickDatedFile(names: string[], prefix: string): string | null {
  const p = String(prefix);
  const hits: any[] = [];
  for (const n of names || []) {
    const name = String(n);
    if (!/\.md$/i.test(name) || !name.startsWith(p)) continue;
    if (/^[-_.]?\d/.test(name.slice(p.length))) continue;
    if (name.length === p.length + 3) return name;      // exactly `<prefix>.md`
    hits.push(name);
  }
  hits.sort(naturalCompare);
  return hits[0] || null;
}

/* ------------------------------------------------------------------ paths */

const trimSlash = (dir) => String(dir ?? '').replace(/\/+$/, '');
const join = (dir, name) => (trimSlash(dir) ? `${trimSlash(dir)}/${name}` : String(name));

/**
 * The year subfolder of the plannings folder: `<plannings>/2026`. Plans are found flat in the
 * plannings folder first, then here.
 */
export const planDir = (date: Date, dir: string): string => join(dir, String(date.getFullYear()));

/**
 * The canonical plan path for a date, flat: `<plannings>/2026-09.md`. The real file may be
 * named anything starting with `2026-09` and may sit in `<plannings>/2026/` (`resolvePlanPath`).
 */
export const planPath = (date: Date, dir: string): string => join(dir, `${ym(date)}.md`);

/**
 * The year file among a folder's names: `2026.md` wins, then a name that starts with the year
 * and a space (`2026 Yearly Plan.md`), or with the year, a dash or underscore and `year`
 * (`2026-yearly-plan.md`). `2026-09.md`, `2026-goals.md` and `2026-review.md` are not it.
 */
export function pickYearFile(names: string[], year: number | string): string | null {
  const y = String(year);
  const hits: string[] = [];
  for (const n of names || []) {
    const name = String(n);
    if (!/\.md$/i.test(name) || !name.startsWith(y)) continue;
    const rest = name.slice(y.length, -3);
    if (rest === '') return name;
    if (/^\s+\S/.test(rest) || /^[-_]\s*year/i.test(rest)) hits.push(name);
  }
  hits.sort(naturalCompare);
  return hits[0] || null;
}

/** What `listPlannings` answers: the files of the plannings folder and of its year folder. */
export type PlanListing = { dir: string; year: number; flat: string[]; inYear: string[] | null; };

type Lister = (folder: string) => Promise<Array<{ name: string; kind: string; }>>;

/**
 * List the plannings folder and its year folder (`null` when there is none). `list(folder)`
 * answers entries (`{name, kind}`) or throws.
 */
export async function listPlannings(list: Lister, dir: string, year: number): Promise<PlanListing> {
  const files = async (folder) => {
    try { return (await list(folder)).filter((n) => n.kind === 'file').map((n) => n.name); } catch { return null; }
  };
  const [flat, inYear] = await Promise.all([files(trimSlash(dir)), files(join(dir, String(year)))]);
  return { dir: trimSlash(dir), year, flat: flat || [], inYear };
}

/** One resolved planning file: where it is, whether it is there, and whether it is flat. */
export type PlanFile = { path: string; dir: string; exists: boolean; flat: boolean; };

/**
 * The month's plan in a listing: flat first, then the year folder. When nothing matches, the
 * canonical name comes back with `exists: false`, in the year folder when there is one.
 */
export function pickMonth(listing: PlanListing, date: Date): PlanFile {
  const yearDir = join(listing.dir, String(listing.year));
  const flat = pickDatedFile(listing.flat, ym(date));
  if (flat) return { path: join(listing.dir, flat), dir: listing.dir, exists: true, flat: true };
  const nested = listing.inYear ? pickDatedFile(listing.inYear, ym(date)) : null;
  if (nested) return { path: `${yearDir}/${nested}`, dir: yearDir, exists: true, flat: false };
  return listing.inYear
    ? { path: `${yearDir}/${ym(date)}.md`, dir: yearDir, exists: false, flat: false }
    : { path: join(listing.dir, `${ym(date)}.md`), dir: listing.dir, exists: false, flat: true };
}

/**
 * The year's file in a listing (`pickYearFile`): flat first, then the year folder; missing,
 * the canonical `<plannings>/2026.md`.
 */
export function pickYear(listing: PlanListing): PlanFile {
  const y = String(listing.year), yearDir = join(listing.dir, y);
  const flat = pickYearFile(listing.flat, y);
  if (flat) return { path: join(listing.dir, flat), dir: listing.dir, exists: true, flat: true };
  const nested = listing.inYear ? pickYearFile(listing.inYear, y) : null;
  if (nested) return { path: `${yearDir}/${nested}`, dir: yearDir, exists: true, flat: false };
  return { path: join(listing.dir, `${y}.md`), dir: listing.dir, exists: false, flat: true };
}

/**
 * The plan file of the month `date` falls in: `<plannings>/2026-09*.md`, else
 * `<plannings>/2026/2026-09*.md`.
 */
export async function resolvePlanPath(list: Lister, date: Date, dir: string): Promise<PlanFile> {
  return pickMonth(await listPlannings(list, dir, date.getFullYear()), date);
}

/**
 * The year file: `<plannings>/2026.md` (or `2026 Yearly Plan.md`), else the same in `2026/`.
 */
export async function resolveYearPath(list: Lister, year: number, dir: string): Promise<PlanFile> {
  return pickYear(await listPlannings(list, dir, year));
}

/**
 * A `_gap: what is missing_` line: the marker for a hole, never filled with a guess.
 */
export const isGapLine = (line: string): boolean => /^_gap:[\s\S]*_$/i.test(String(line ?? '').trim());

/**
 * The last month before `date` that has a file, looking back `back` months; null when none.
 * Each year folder is listed once.
 */
export async function previousMonthFile(list: Lister, date: Date, dir: string, back = 24): Promise<PlanFile | null> {
  const listings = new Map<number, PlanListing>();
  for (let k = 1; k <= back; k++) {
    const d = new Date(date.getFullYear(), date.getMonth() - k, 1);
    const y = d.getFullYear();
    if (!listings.has(y)) listings.set(y, await listPlannings(list, dir, y));
    const hit = pickMonth(listings.get(y) as PlanListing, d);
    if (hit.exists) return hit;
  }
  return null;
}
