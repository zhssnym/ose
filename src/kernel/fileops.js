// File operations (docs/KERNEL.md `ose.fileops`, H12, H13, C6). The one implementation of
// create, rename, move, trash and duplicate. The tree, the palette, the router's "Create it"
// and the editor all call these; the prompts that ask for a name are the shell's.
//
// Every operation that moves or removes a path asks the page first. The page host's
// `beforePathChange` saves every open buffer at or under the path, or refuses; a refusal
// touches nothing on disk. The host call comes next, and only after it has succeeded is anyone
// told: the router's history is re-pointed, the moved files' own links are rewritten while the
// page is still frozen, the page follows its file, the bus says so, and the links into it are
// rewritten. Renaming the open page used to close it, and closing threw
// the unsaved buffer away (C6). Nothing here navigates: the caller decides where to land.
//
// Errors are `Error`s with `.code`: 'bad_name', 'exists', 'not_saved', or the host's own code.

import { bridge } from './bridge/index.js';
import { bus } from './registry.js';
import { pageHost } from './pagehost.js';
import { repoint } from './router.js';
import { rewriteInboundMany } from './links.js';
import { check, split, free } from './names.js';
import { clean, dirName, baseName, join } from './paths.js';
import { trashMode } from './settings-core.js';
import { logLine } from './log.js';

/** An Error with a code, the shape every refusal here takes. */
function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

const NO_LINKS = () => ({ files: 0, links: 0, failed: [] });

/** `path` is `from`, or inside the folder `from`. */
const under = (path, from) => path === from || path.startsWith(from + '/');

/** Ask the page host before a change; a missing host or method is a yes. */
async function askPage(change) {
  const host = pageHost();
  if (!host || typeof host.beforePathChange !== 'function') return { ok: true };
  let g;
  try { g = await host.beforePathChange(change); } catch (e) {
    return { ok: false, reason: `the page could not be saved first: ${e && e.message ? e.message : e}` };
  }
  return g && g.ok === false ? g : { ok: true };
}

/** Tell the page host how it went. Never throws: the host call has already happened. */
async function tellPage(change) {
  const host = pageHost();
  if (!host || typeof host.afterPathChange !== 'function') return;
  try { await host.afterPathChange(change); } catch (e) { console.error('[fileops] afterPathChange', e); }
}

/**
 * Every file under `from` paired with where it lands under `to`, for the link rewrite. Listed
 * before the host call, while the files are still where the pairs say they were. A file is
 * one pair of itself.
 */
async function filePairs(from, to) {
  let st = null;
  try { st = await bridge.stat(from); } catch { /* the rename will say what is wrong */ }
  if (!st || st.kind !== 'dir') return [{ from, to }];
  const out = [];
  const walk = (n) => {
    if (!n || !Array.isArray(n.children)) return;
    for (const c of n.children) {
      if (c.kind === 'dir') walk(c);
      else if (c.path && under(clean(c.path), from)) out.push({ from: clean(c.path), to: to + clean(c.path).slice(from.length) });
    }
  };
  try {
    const find = (n) => {
      if (!n) return null;
      if (clean(n.path) === from) return n;
      for (const c of n.children || []) {
        if (c.kind === 'dir' && under(from, clean(c.path))) { const hit = find(c); if (hit) return hit; }
      }
      return null;
    };
    walk(find(await bridge.tree()));
  } catch (e) { console.warn('[fileops] listing', from, e); }
  return out;
}

/**
 * The link rewrite after a move; its failure is reported, never thrown. `own` is what the
 * moved files' own pass (`rewriteOwn`) answered for the same pairs: those files are settled,
 * and its counts are added in, so the caller sees one result for the whole move.
 */
async function rewrite(pairs, own = []) {
  const sum = NO_LINKS();
  const settled = new Set();
  for (const o of own) {
    sum.files += o.files;
    sum.links += o.links;
    sum.failed.push(...o.failed);
    for (const p of o.settled) settled.add(p);
    if (o.error) sum.error = o.error;
  }
  if (!pairs.length) return sum;
  try {
    const r = await rewriteInboundMany(pairs, { settled });
    sum.files += r.files;
    sum.links += r.links;
    for (const f of r.failed) if (!sum.failed.includes(f)) sum.failed.push(f);
  } catch (e) {
    console.error('[fileops] links', e);
    sum.error = String((e && e.message) || e);
  }
  return sum;
}

/**
 * The moved files' own hrefs (links.js N16), rewritten while the pages that show them are still
 * frozen and marked as moving: before `afterPathChange`, not after it. Done later, the rewrite
 * edited the open page's file behind a page that had already thawed, and the page saw its own
 * file change on disk: a remount that threw the undo history away, or a conflict it had caused
 * itself. `rewritten` (path -> new hash) goes to the page with `ok:true`, so it can take the new
 * text as its clean baseline. `settled` is every moved file whose hrefs now say where it is,
 * for the inbound pass that follows. Never throws.
 */
async function rewriteOwn(pairs) {
  const out = { files: 0, links: 0, failed: [], rewritten: {}, settled: [] };
  if (!pairs.length) return out;
  try {
    const r = await rewriteInboundMany(pairs, { only: 'moved' });
    Object.assign(out, { files: r.files, links: r.links, failed: r.failed, rewritten: r.rewritten || {} });
  } catch (e) {
    console.error('[fileops] own links', e);
    out.error = String((e && e.message) || e);
    return out;
  }
  // A file whose write failed still holds the hrefs of where it was: the inbound pass reads it
  // as moved, and tries again from its old place.
  out.settled = pairs.map((p) => clean(p.to)).filter((p) => !out.failed.includes(p));
  return out;
}

/** The text a new file gets when the caller names none: an H1 for markdown, nothing otherwise. */
function defaultText(path) {
  const { stem, ext } = split(baseName(path));
  return ext.toLowerCase() === 'md' ? `# ${stem}\n` : '';
}

/**
 * Create a file. `name` may hold `/`: the folders are created. Any extension, or none; the
 * text defaults to `# <stem>\n` for `.md` and to nothing otherwise. Never overwrites: on an
 * existing name it fails with `exists`, or with `unique` takes the next free name.
 * @param {string} folder  vault-relative, '' for the root
 * @param {string} name
 * @param {{text?: string, unique?: boolean}} [opts]
 * @returns {Promise<{path: string}>}
 */
export async function create(folder, name, { text, unique = false } = {}) {
  const c = check(name, { folders: true });
  if (!c.ok) throw fail('bad_name', c.reason);
  let path = join(folder, c.name);
  const body = typeof text === 'string' ? text : defaultText(path);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await bridge.createNew(path, body);
      logLine(`fileops create ${path}`);
      return { path: clean((r && r.path) || path) };
    } catch (e) {
      if (e && e.code === 'exists' && unique) { path = await free(dirName(path), baseName(path)); continue; }
      logLine(`fileops create failed ${path}: ${e && e.code} ${e && e.message}`, 'warn');
      throw e;
    }
  }
  throw fail('exists', `${path} already exists`);
}

/**
 * Rename in place: `to` is `dirname(path)/name`, literally. The name has no `/`. A case-only
 * rename is allowed; any other existing name is refused with `exists`.
 * @param {string} path
 * @param {string} name
 * @returns {Promise<{from: string, to: string, links: object}>}
 */
export async function rename(path, name) {
  const c = check(name);
  if (!c.ok) throw fail('bad_name', c.reason);
  const from = clean(path);
  const to = join(dirName(from), c.name);
  if (to === from) return { from, to, links: NO_LINKS() };
  const caseOnly = to.toLowerCase() === from.toLowerCase();
  if (!caseOnly && (await bridge.exists(to))) throw fail('exists', `${baseName(to)} already exists`);
  const moved = await movePath('rename', from, to);
  bus.emit('paths:moved', { moves: [{ from, to }] });
  return { from, to, links: await rewrite(moved.pairs, [moved.own]) };
}

/**
 * The one move: ask the page, list the pairs, call the host, rewrite the moved files' own
 * hrefs, then tell everyone. Answers the pairs for the inbound link rewrite, which the caller
 * runs once for the whole batch, and `own`, what the moved files' pass did.
 */
async function movePath(kind, from, to) {
  const g = await askPage({ kind, from, to });
  if (!g.ok) throw fail('not_saved', g.reason || `${baseName(from)} has unsaved changes that could not be saved`);
  const pairs = await filePairs(from, to);
  try {
    await bridge.rename(from, to);
  } catch (e) {
    await tellPage({ kind, from, to, ok: false });
    logLine(`fileops ${kind} failed ${from} -> ${to}: ${e && e.code} ${e && e.message}`, 'warn');
    throw e;
  }
  logLine(`fileops ${kind} ${from} -> ${to}`);
  repoint([{ from, to }]);
  const own = await rewriteOwn(pairs);
  const done = { kind, from, to, ok: true };
  if (Object.keys(own.rewritten).length) done.rewritten = own.rewritten;
  await tellPage(done);
  return { pairs, own };
}

/**
 * Move each path into `folder` under its own name. A path that cannot go (a name taken, a
 * folder into itself, a page that could not be saved, a host refusal) is skipped with its
 * error; the others still move. One `paths:moved` and one link rewrite for the whole batch.
 * @param {string[]} paths
 * @param {string} folder
 * @returns {Promise<{moved: {from: string, to: string}[], skipped: {path: string, error: Error}[], links: object}>}
 */
export async function move(paths, folder) {
  const dest = clean(folder);
  const moved = [];
  const skipped = [];
  const pairs = [];
  const own = [];
  for (const p of paths || []) {
    const from = clean(p);
    const to = join(dest, baseName(from));
    try {
      if (!from) throw fail('bad_arg', 'nothing to move');
      if (to === from) continue;
      if (under(dest, from)) throw fail('bad_arg', `${baseName(from)} cannot go inside itself`);
      if (await bridge.exists(to)) throw fail('exists', `${baseName(to)} already exists in ${dest || 'the vault root'}`);
      const r = await movePath('move', from, to);
      moved.push({ from, to });
      pairs.push(...r.pairs);
      own.push(r.own);
    } catch (e) {
      skipped.push({ path: from, error: e });
    }
  }
  if (moved.length) bus.emit('paths:moved', { moves: moved });
  return { moved, skipped, links: await rewrite(pairs, own) };
}

/**
 * Move each path to the trash the user chose in Settings (the system bin, or `.trash` in the
 * vault). The page is asked first; the path is trashed; only then is the page told, so a
 * trash that fails leaves the page exactly as it was (C6). History and drafts stay.
 * @param {string[]} paths
 * @returns {Promise<{trashed: string[], failed: {path: string, error: Error}[]}>}
 */
export async function trash(paths) {
  const trashed = [];
  const failed = [];
  for (const p of paths || []) {
    const from = clean(p);
    if (!from) continue;
    const change = { kind: 'trash', from, to: null };
    const g = await askPage(change);
    if (!g.ok) { failed.push({ path: from, error: fail('not_saved', g.reason || `${baseName(from)} could not be saved`) }); continue; }
    try {
      await bridge.trash(from, { mode: trashMode() });
    } catch (e) {
      await tellPage({ ...change, ok: false });
      logLine(`fileops trash failed ${from}: ${e && e.code} ${e && e.message}`, 'warn');
      failed.push({ path: from, error: e });
      continue;
    }
    logLine(`fileops trash ${from}`);
    await tellPage({ ...change, ok: true });
    trashed.push(from);
  }
  if (trashed.length) bus.emit('paths:trashed', { paths: trashed });
  return { trashed, failed };
}

/**
 * A byte copy beside the file, `stem 2.ext` (the next free name), whatever its type. The page
 * is asked first so the copy holds what is on screen, not what was last saved.
 * @param {string} path
 * @returns {Promise<{path: string}>}
 */
export async function duplicate(path) {
  const from = clean(path);
  let st = null;
  try { st = await bridge.stat(from); } catch { /* copyFile will say */ }
  if (st && st.kind === 'dir') throw fail('bad_arg', 'a folder cannot be duplicated');
  let to = await free(dirName(from), baseName(from));
  const g = await askPage({ kind: 'copy', from, to });
  if (!g.ok) throw fail('not_saved', g.reason || `${baseName(from)} has unsaved changes that could not be saved`);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await bridge.copyFile(from, to);
      await tellPage({ kind: 'copy', from, to, ok: true });
      logLine(`fileops duplicate ${from} -> ${to}`);
      return { path: clean((r && r.path) || to) };
    } catch (e) {
      if (e && e.code === 'exists') { to = await free(dirName(from), baseName(from)); continue; }
      await tellPage({ kind: 'copy', from, to, ok: false });
      logLine(`fileops duplicate failed ${from}: ${e && e.code} ${e && e.message}`, 'warn');
      throw e;
    }
  }
  await tellPage({ kind: 'copy', from, to, ok: false });
  throw fail('exists', `no free name beside ${from}`);
}
