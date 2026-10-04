// File operations (docs/CORE.md `ose.fileops`, H12, H13, C6, M17, M18). The one
// implementation of create, new folder, rename, move, copy, paste, trash, restore and
// duplicate. The tree, the palette, the router's "Create it" and the editor
// all call these; the prompts that ask for a name are the shell's.
//
// Every operation that moves or removes a path asks the page first. The page host's
// `beforePathChange` saves every open buffer at or under the path, or refuses; a refusal
// touches nothing on disk. The host call comes next, and only after it has succeeded is anyone
// told: the router's history is re-pointed, the moved files' own links are rewritten while the
// page is still frozen, the page follows its file, the bus says so, and the links into it are
// rewritten. Renaming the open page used to close it, and closing threw the unsaved buffer away
// (C6). Nothing here navigates: the caller decides where to land.
//
// Every operation that changed something is written down in the undo journal (./journal.ts)
// as the steps that undo it, and its result carries that `entry`, so a toast can offer [Undo].
// An undo walks the steps back through these same functions, quietly: an undo is not journaled.
//
// Errors are `Error`s with `.code`: 'bad_name', 'exists', 'not_saved', or the host's own code.

import { bridge } from './bridge/index.ts';
import { bus } from './registry.ts';
import { pageHost } from './pagehost.ts';
import { repoint } from './router.ts';
import { rewriteInboundMany } from './links.ts';
import { check, split, free, sameName } from './names.ts';
import { clean, dirName, baseName, join, isOutside } from './paths.ts';
import { trashMode } from './settings-core.ts';
import { logLine } from './log.ts';
import { record as journal, binName, itemsLabel, folderLabel } from './journal.ts';

/**
 * An Error with a code, the shape every refusal here takes.
 */
function fail(code: string, message: string, extra: Record<string, unknown> = {}): Error & { code: string; } {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * What a `catch` caught, read as the coded Error the host and this file throw. Anything can be
 * thrown, so every read of it stays guarded (`e && caught(e).code`); this only names the shape.
 */
const caught = (e: unknown): Error & { code?: string; } => (e as Error & { code?: string });

/**
 * A file outside the vault (X7) is opened and saved where it is, and nothing else: it cannot be
 * renamed, moved, trashed or duplicated from here. The refusal says so, `code` and `reason`
 * both `outside`, and touches nothing.
 */
function outside(path: string, verb: string) {
  return fail('outside', `${baseName(path)} is outside the vault and cannot be ${verb} from here`, { reason: 'outside' });
}

export type LinkSum = { files: number, links: number, failed: string[], error?: string };

const NO_LINKS = (): LinkSum => ({ files: 0, links: 0, failed: [] as any[] });

/** `path` is `from`, or inside the folder `from`. */
const under = (path, from) => path === from || path.startsWith(from + '/');

/** Ask the page host before a change; a missing host or method is a yes. */
async function askPage(change) {
  const host = pageHost();
  if (!host || typeof host.beforePathChange !== 'function') return { ok: true };
  let g;
  try { g = await host.beforePathChange(change); } catch (e) {
    return { ok: false, reason: `the page could not be saved first: ${e && caught(e).message ? caught(e).message : e}` };
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
  let st: import('./bridge/commands.ts').Stat_Serialize | null = null;
  try { st = await bridge.stat(from); } catch { /* the rename will say what is wrong */ }
  if (!st || st.kind !== 'dir') return [{ from, to }];
  const out: any[] = [];
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
async function rewrite(pairs: { from: string; to: string; }[], own: OwnPass[] = []): Promise<LinkSum> {
  const sum = NO_LINKS();
  const settled: Set<string> = new Set();
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
    sum.error = String((e && caught(e).message) || e);
  }
  return sum;
}

/**
 * The moved files' own hrefs (links.ts N16), rewritten while the pages that show them are still
 * frozen and marked as moving: before `afterPathChange`, not after it. Done later, the rewrite
 * edited the open page's file behind a page that had already thawed, and the page saw its own
 * file change on disk: a remount that threw the undo history away, or a conflict it had caused
 * itself. `rewritten` (path -> new hash) goes to the page with `ok:true`, so it can take the new
 * text as its clean baseline. `settled` is every moved file whose hrefs now say where it is,
 * for the inbound pass that follows. Never throws.
 */
export type OwnPass = { files: number, links: number, failed: string[], rewritten: Record<string, string>, settled: string[], error?: string };

async function rewriteOwn(pairs: { from: string; to: string; }[]): Promise<OwnPass> {
  const out: OwnPass = { files: 0, links: 0, failed: [], rewritten: {}, settled: [] };
  if (!pairs.length) return out;
  try {
    const r = await rewriteInboundMany(pairs, { only: 'moved' });
    Object.assign(out, { files: r.files, links: r.links, failed: r.failed, rewritten: r.rewritten || {} });
  } catch (e) {
    console.error('[fileops] own links', e);
    out.error = String((e && caught(e).message) || e);
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
 * @param folder  vault-relative, '' for the root
 */
export async function create(folder: string, name: string, { text, unique = false }: { text?: string; unique?: boolean; } = {}): Promise<{ path: string; entry: any | null; }> {
  const c = check(name, { folders: true });
  if (!c.ok) throw fail('bad_name', c.reason);
  let path = join(folder, c.name);
  const body = typeof text === 'string' ? text : defaultText(path);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await bridge.createNew(path, body);
      path = clean((r && r.path) || path);
      logLine(`fileops create ${path}`);
      const entry = journal({
        verb: 'create',
        label: `Created ${baseName(path)}`,
        steps: [{ op: 'created', path, dir: false, hash: (r && r.hash) || null }],
      });
      bus.emit('paths:created', { paths: [path] });
      return { path, entry };
    } catch (e) {
      if (e && caught(e).code === 'exists' && unique) { path = await free(dirName(path), baseName(path)); continue; }
      logLine(`fileops create failed ${path}: ${e && caught(e).code} ${e && caught(e).message}`, 'warn');
      throw e;
    }
  }
  throw fail('exists', `${path} already exists`);
}

/**
 * A new folder `name` in `folder` (the tree's New folder). `name` may
 * hold `/`. An existing name is refused with `exists`.
 * @param folder  vault-relative, '' for the root
 */
export async function mkdir(folder: string, name: string): Promise<{ path: string; entry: any | null; }> {
  const c = check(name, { folders: true });
  if (!c.ok) throw fail('bad_name', c.reason);
  const path = join(folder, c.name);
  if (await bridge.exists(path)) throw fail('exists', `${baseName(path)} already exists`);
  try {
    await bridge.mkdir(path);
  } catch (e) {
    logLine(`fileops mkdir failed ${path}: ${e && caught(e).code} ${e && caught(e).message}`, 'warn');
    throw e;
  }
  logLine(`fileops mkdir ${path}`);
  const entry = journal({
    verb: 'mkdir',
    label: `Created folder ${baseName(path)}`,
    steps: [{ op: 'created', path, dir: true, hash: null }],
  });
  bus.emit('paths:created', { paths: [path] });
  return { path, entry };
}

/**
 * Rename in place: `to` is `dirname(path)/name`, literally. The name has no `/`. A case-only
 * rename is allowed; any other existing name is refused with `exists`.
 */
export function rename(path: string, name: string): Promise<{ from: string; to: string; links: any; entry: any | null; }> { return renameQuiet(path, name, true); }

async function renameQuiet(path, name, record) {
  if (isOutside(path)) throw outside(path, 'renamed');
  const c = check(name);
  if (!c.ok) throw fail('bad_name', c.reason);
  const from = clean(path);
  const to = join(dirName(from), c.name);
  if (to === from) return { from, to, links: NO_LINKS(), entry: null };
  // Case only, or the same name in another Unicode form (M49: a name typed on a Mac is NFD on
  // disk): the host finds the file itself at `to`, so `exists` says nothing about a clash.
  const caseOnly = sameName(to.toLowerCase(), from.toLowerCase());
  if (!caseOnly && (await bridge.exists(to))) throw fail('exists', `${baseName(to)} already exists`);
  const moved = await movePath('rename', from, to);
  bus.emit('paths:moved', { moves: [{ from, to }] });
  const entry = record ? journal({
    verb: 'rename',
    label: `Renamed ${baseName(from)} to ${baseName(to)}`,
    steps: [{ op: 'moved', from, to }],
  }) : null;
  return { from, to, links: await rewrite(moved.pairs, [moved.own]), entry };
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
    logLine(`fileops ${kind} failed ${from} -> ${to}: ${e && caught(e).code} ${e && caught(e).message}`, 'warn');
    throw e;
  }
  logLine(`fileops ${kind} ${from} -> ${to}`);
  repoint([{ from, to }]);
  const own = await rewriteOwn(pairs);
  const done: {    kind: any;    from: any;    to: any;    ok: boolean; rewritten?: Record<string, string>; } = { kind, from, to, ok: true };
  if (Object.keys(own.rewritten).length) done.rewritten = own.rewritten;
  await tellPage(done);
  return { pairs, own };
}


/**
 * Move each path into `folder` under its own name. A path that cannot go (a name taken, a
 * folder into itself, a page that could not be saved, a host refusal) is skipped with its
 * error; the others still move. One `paths:moved` and one link rewrite for the whole batch.
 */
export function move(paths: string[], folder: string): Promise<{ moved: { from: string; to: string; }[]; skipped: { path: string; error: Error; }[]; links: any; entry: any | null; }> { return moveQuiet(paths, folder, true); }

async function moveQuiet(paths, folder, record) {
  const dest = clean(folder);
  const moved: any[] = [];
  const skipped: any[] = [];
  const pairs: any[] = [];
  const own: any[] = [];
  for (const p of paths || []) {
    const from = clean(p);
    const to = join(dest, baseName(from));
    try {
      if (!from) throw fail('bad_arg', 'nothing to move');
      if (isOutside(from)) throw outside(from, 'moved');
      if (to === from) continue;
      if (under(dest, from)) throw fail('bad_arg', `${baseName(from)} cannot go inside itself`);
      if (await bridge.exists(to)) throw fail('exists', `${baseName(to)} already exists in ${dest || 'the vault root'}`);
      const r = await movePath('move', from, to);
      moved.push({ from, to });
      pairs.push(...r.pairs);
      own.push(r.own);
    } catch (e) {
      skipped.push({ path: from, error: caught(e) });
    }
  }
  if (moved.length) bus.emit('paths:moved', { moves: moved });
  const entry = record && moved.length ? journal({
    verb: 'move',
    label: `Moved ${itemsLabel(moved.map((m) => m.from))} to ${folderLabel(dest)}`,
    steps: moved.map((m) => ({ op: 'moved', from: m.from, to: m.to })),
  }) : null;
  return { moved, skipped, links: await rewrite(pairs, own), entry };
}

/**
 * What the undo of a created or copied file compares against: the host's hash when the file
 * reads as text, else its size and time. Never throws; `{ hash: null }` means "cannot tell".
 */
async function fingerprint(path) {
  try {
    const r = await bridge.readFile(path);
    if (r && r.hash) return { hash: r.hash };
  } catch { /* binary, or gone: the stat below */ }
  try {
    const st = await bridge.stat(path);
    if (st && st.exists) return { hash: null, size: st.size, mtime: st.mtime };
  } catch { /* nothing to compare with */ }
  return { hash: null };
}

/** Names an OS drops into a folder by itself; they do not make a new folder "not empty". */
const OS_LITTER = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * Everything under the folder `dir`, hidden entries too, as `{ 'rel/path': 'size:mtime',
 * 'rel/folder/': 'dir' }`: what the undo of a copied or restored folder compares against. A
 * link is an entry of its own and is never walked. Null when the folder cannot be listed.
 */
async function manifest(dir) {
  const out: Record<string, any> = {};
  const walk = async (p) => {
    const kids = await bridge.list(p, { hidden: true });
    for (const k of Array.isArray(kids) ? kids : []) {
      const cp = clean(k.path);
      const rel = cp.slice(dir.length + 1);
      if (k.kind === 'dir' && !k.link) { out[`${rel}/`] = 'dir'; await walk(cp); }
      else out[rel] = `${k.size ?? ''}:${k.mtime ?? ''}`;
    }
  };
  try { await walk(dir); } catch { return null; }
  return out;
}

/** Two manifests hold the same entries with the same sizes and times. */
function sameManifest(a, b) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && a[k] === b[k]);
}

/** A folder's print for the journal: `{ dir: true, manifest }` (no manifest: cannot tell). */
async function folderPrint(path) {
  const m = await manifest(path);
  return m ? { dir: true, hash: null, manifest: m } : { dir: true, hash: null };
}

/** A path's print, a file's or a folder's, whichever it is now. */
async function pathPrint(path) {
  let st: import('./bridge/commands.ts').Stat_Serialize | null = null;
  try { st = await bridge.stat(path); } catch { /* the fingerprint says what it can */ }
  if (st && st.kind === 'dir') return folderPrint(path);
  return { dir: false, ...(await fingerprint(path)) };
}

/**
 * A byte copy of a file or a whole folder (`copyPath`); a file outside the vault comes in
 * through `importOutside`, the one command that may read it for a copy.
 */
async function copyBytes(from: string, to: string): Promise<{ path: string; hash?: string | null; }> {
  if (isOutside(from)) {
    const r = await bridge.importOutside(from, to);
    return { path: clean((r && r.path) || to), hash: (r && r.hash) || null };
  }
  const r = await bridge.copyPath(from, to);
  return { path: clean((r && r.path) || to) };
}

/**
 * Copy each path into `folder`, bytes, a file or a whole folder. The name is the path's own,
 * or the next free one (`x 2.ext`, `folder 2`), so copying into the folder it is in makes a
 * copy beside it. The page is asked first so a copy holds what is on screen. A path that
 * cannot be copied is skipped with its error.
 */
export async function copy(paths: string[], folder: string): Promise<{ copied: { from: string; to: string; }[]; skipped: { path: string; error: Error; }[]; entry: any | null; }> {
  const dest = clean(folder);
  const copied: any[] = [];
  const skipped: any[] = [];
  const steps: any[] = [];
  for (const p of paths || []) {
    const from = clean(p);
    try {
      if (!from) throw fail('bad_arg', 'nothing to copy');
      let st: import('./bridge/commands.ts').Stat_Serialize | null = null;
      try { st = await bridge.stat(from); } catch { /* the copy will say */ }
      if (st && st.exists === false) throw fail('not_found', `${baseName(from)} is not there any more`);
      const dir = !!st && st.kind === 'dir';
      if (dir && under(dest, from)) throw fail('bad_arg', `${baseName(from)} cannot be copied into itself`);
      let to = await free(dest, baseName(from), { dir });
      const g = await askPage({ kind: 'copy', from, to });
      if (!g.ok) throw fail('not_saved', g.reason || `${baseName(from)} has unsaved changes that could not be saved`);
      let done: { path: string; hash?: string | null; } | null = null;
      for (let attempt = 0; attempt < 5 && !done; attempt++) {
        try {
          done = await copyBytes(from, to);
        } catch (e) {
          if (e && caught(e).code === 'exists') { to = await free(dest, baseName(from), { dir }); continue; }
          await tellPage({ kind: 'copy', from, to, ok: false });
          throw e;
        }
      }
      if (!done) {
        await tellPage({ kind: 'copy', from, to, ok: false });
        throw fail('exists', `no free name for ${baseName(from)} in ${dest || 'the vault root'}`);
      }
      await tellPage({ kind: 'copy', from, to, ok: true });
      to = done.path;
      logLine(`fileops copy ${from} -> ${to}`);
      const print = dir ? await folderPrint(to) : (done.hash ? { hash: done.hash } : await fingerprint(to));
      copied.push({ from, to });
      steps.push({ op: 'copied', from, to, dir, ...print });
    } catch (e) {
      logLine(`fileops copy failed ${from}: ${e && caught(e).code} ${e && caught(e).message}`, 'warn');
      skipped.push({ path: from, error: caught(e) });
    }
  }
  const entry = copied.length ? journal({
    verb: 'copy',
    label: `Copied ${itemsLabel(copied.map((c) => c.from))} to ${folderLabel(dest)}`,
    steps,
  }) : null;
  if (copied.length) bus.emit('paths:copied', { pairs: copied });
  return { copied, skipped, entry };
}

/**
 * Paste what was cut or copied into `folder`: a cut moves (and a path already in `folder`
 * stays where it is), a copy copies (and into the same folder makes `x 2`). Answers what
 * `move` or `copy` answered.
 */
export function paste(clip: { mode: 'cut' | 'copy'; paths: string[]; }, folder: string) {
  const paths = clip && Array.isArray(clip.paths) ? clip.paths : [];
  if (clip && clip.mode === 'cut') return move(paths, folder);
  return copy(paths, folder);
}

/**
 * Move each path to the trash the user chose in Settings (the system bin, or `.trash` in the
 * vault). The page is asked first; the path is trashed; only then is the page told, so a
 * trash that fails leaves the page exactly as it was (C6). History and drafts stay. Nothing
 * is ever deleted outright: where the bin refuses, the host uses `.trash` and says so (M18).
 */
export function trash(paths: string[]): Promise<{ trashed: string[]; items: { path: string; id: string | null; where: string; }[]; failed: { path: string; error: Error; }[]; entry: any | null; }> { return trashQuiet(paths, true); }

/** `asked`: the undo has already asked the page (and compared the disk after it saved). */
async function trashQuiet(paths, record, { asked = false } = {}) {
  const trashed: any[] = [];
  const items: any[] = [];
  const failed: any[] = [];
  for (const p of paths || []) {
    const from = clean(p);
    if (!from) continue;
    if (isOutside(from)) { failed.push({ path: from, error: outside(from, 'trashed') }); continue; }
    const change = { kind: 'trash', from, to: null };
    const g = asked ? { ok: true } : await askPage(change);
    if (!g.ok) { failed.push({ path: from, error: fail('not_saved', g.reason || `${baseName(from)} could not be saved`) }); continue; }
    let r;
    try {
      r = await bridge.trash(from, { mode: trashMode() });
    } catch (e) {
      await tellPage({ ...change, ok: false });
      logLine(`fileops trash failed ${from}: ${e && caught(e).code} ${e && caught(e).message}`, 'warn');
      failed.push({ path: from, error: caught(e) });
      continue;
    }
    const id = (r && r.id) || null;
    const where = r && r.where === 'vault' ? 'vault' : (r && r.where) || trashMode();
    logLine(`fileops trash ${from} (${where}${id ? '' : ', not restorable here'})`);
    await tellPage({ ...change, ok: true });
    trashed.push(from);
    items.push({ path: from, id, where });
  }
  const entry = record && items.length ? journal({
    verb: 'trash',
    label: `Moved ${itemsLabel(trashed)} to ${binName(items[0]?.where || trashMode())}`,
    steps: items.map((i) => ({ op: 'trashed', path: i.path, id: i.id, where: i.where })),
  }) : null;
  if (trashed.length) bus.emit('paths:trashed', { paths: trashed, items });
  return { trashed, items, failed, entry };
}

/**
 * Put trashed items back where they were (M18). The host never overwrites: an item whose place
 * is taken again fails with `[exists]`, and missing parent folders are made.
 * @param ids  TrashItem ids, from `trashList` or a trash's `items`
 */
export function restore(ids: string[]): Promise<{ restored: { id: string; path: string; }[]; failed: { id: string; error: any; }[]; entry: any | null; }> { return restoreQuiet(ids, true); }

async function restoreQuiet(ids, record) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return { restored: [] as any[], failed: [] as any[], entry: null };
  let r;
  try {
    r = await bridge.trashRestore(list);
  } catch (e) {
    logLine(`fileops restore failed: ${e && caught(e).code} ${e && caught(e).message}`, 'warn');
    return { restored: [] as any[], failed: list.map((id) => ({ id, error: e })), entry: null };
  }
  const restored = (r && Array.isArray(r.restored) ? r.restored : []).map((x) => ({ id: x.id, path: clean(x.path) }));
  const failed = r && Array.isArray(r.failed) ? r.failed : [];
  if (restored.length) logLine(`fileops restore ${restored.map((x) => x.path).join(', ')}`);
  // What each item is now, so an undo that finds it edited since leaves it in place.
  const prints = record ? await Promise.all(restored.map((x) => pathPrint(x.path))) : [];
  const entry = record && restored.length ? journal({
    verb: 'restore',
    label: `Restored ${itemsLabel(restored.map((x) => x.path))}`,
    steps: restored.map((x, i) => ({ op: 'restored', id: x.id, path: x.path, ...prints[i] })),
  }) : null;
  if (restored.length) bus.emit('paths:restored', { items: restored });
  return { restored, failed, entry };
}

/**
 * What can be restored: the vault's `.trash`, and the system bin where the platform lets the
 * host read it back (TrashItem[], newest first).
 */
export async function trashList() {
  const r = await bridge.trashList();
  return Array.isArray(r) ? r : [];
}

/**
 * A byte copy beside the file, `stem 2.ext` (the next free name), whatever its type. The page
 * is asked first so the copy holds what is on screen, not what was last saved.
 */
export async function duplicate(path: string): Promise<{ path: string; entry: any | null; }> {
  if (isOutside(path)) throw outside(path, 'duplicated');
  const from = clean(path);
  let st: import('./bridge/commands.ts').Stat_Serialize | null = null;
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
      const done = clean((r && r.path) || to);
      const entry = journal({
        verb: 'duplicate',
        label: `Duplicated ${baseName(from)} as ${baseName(done)}`,
        steps: [{ op: 'copied', from, to: done, dir: false, hash: (r && r.hash) || null }],
      });
      bus.emit('paths:copied', { pairs: [{ from, to: done }] });
      return { path: done, entry };
    } catch (e) {
      if (e && caught(e).code === 'exists') { to = await free(dirName(from), baseName(from)); continue; }
      await tellPage({ kind: 'copy', from, to, ok: false });
      logLine(`fileops duplicate failed ${from}: ${e && caught(e).code} ${e && caught(e).message}`, 'warn');
      throw e;
    }
  }
  await tellPage({ kind: 'copy', from, to, ok: false });
  throw fail('exists', `no free name beside ${from}`);
}

/* ------------------------------------------------------------------------------ bytes */

/**
 * Bytes as base64, in chunks: `String.fromCharCode(...bytes)` blows the argument limit on
 * anything large.
 */
export function bytesToBase64(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* --------------------------------------------------------------------------------- undo */

/**
 * Is a created, copied or restored path still what the operation left? A new folder counts
 * only while it is empty: anything in it came later, and is somebody's work. A copied or
 * restored folder counts while it holds exactly the entries it held then, with the same sizes
 * and times. A file counts while its hash (or size and time) is the same, and so does a file
 * the journal could not fingerprint. A path that is gone answers null: nothing left to undo.
 */
async function stillSame(path: string, step: any): Promise<boolean | null> {
  try {
    if (step.dir) {
      const st = await bridge.stat(path);
      if (!st || !st.exists) return null;
      if (step.op === 'created') {
        const kids = await bridge.list(path, { hidden: true });
        return (Array.isArray(kids) ? kids : []).every((k) => k.kind !== 'dir' && OS_LITTER.has(String(k.name || baseName(k.path)).toLowerCase()));
      }
      // No manifest to compare with: what is inside cannot be vouched for, so it stays.
      if (!step.manifest) return false;
      const now = await manifest(path);
      return !!now && sameManifest(now, step.manifest);
    }
    if (step.hash) {
      const r = await bridge.readFile(path);
      return !!r && r.hash === step.hash;
    }
    if (step.size !== undefined) {
      const st = await bridge.stat(path);
      if (!st || !st.exists) return null;
      return st.size === step.size && st.mtime === step.mtime;
    }
  } catch (e) {
    if (e && caught(e).code === 'not_found') return null;
    return false;
  }
  return true;
}

/**
 * The undo of a created, copied or restored path: a trash, only if it is still what the
 * operation left. The page is asked first, so an open buffer at or under the path is saved
 * before the disk is compared: what was typed a moment ago, still in the autosave's wait,
 * counts as a change and keeps the file.
 */
async function trashIfSame(path, step) {
  const change = { kind: 'trash', from: path, to: null };
  const g = await askPage(change);
  if (!g.ok) throw fail('not_saved', g.reason || `${baseName(path)} could not be saved`);
  let same: boolean | null = false;
  try { same = await stillSame(path, step); } catch { same = false; }
  if (same !== true) {
    await tellPage({ ...change, ok: false });
    if (same === null) return;
    throw fail('changed', step.dir && step.op === 'created'
      ? `${baseName(path)} is not empty any more, left in place`
      : `${baseName(path)} changed since, left in place`);
  }
  const r = await trashQuiet([path], false, { asked: true });
  const f = r.failed[0];
  if (f) throw f.error;
}

/**
 * Undo `steps` (already in reverse order), each through the ordinary operation, quietly, so
 * open pages follow and links are rewritten back. Used by the journal (./journal.ts `undo`).
 * Answers the steps that failed, `[{ step, error }]`.
 */
export async function undoSteps(steps: any[]) {
  const failed: any[] = [];
  for (const step of steps) {
    try {
      if (step.op === 'moved') {
        if (dirName(step.from) === dirName(step.to)) {
          await renameQuiet(step.to, baseName(step.from), false);
        } else {
          const r = await moveQuiet([step.to], dirName(step.from), false);
          const s = r.skipped[0];
          if (s) throw s.error;
        }
      } else if (step.op === 'created' || step.op === 'copied' || step.op === 'restored') {
        await trashIfSame(step.op === 'copied' ? step.to : step.path, step);
      } else if (step.op === 'trashed') {
        if (!step.id) throw fail('cannot', `${baseName(step.path)} cannot be restored from here`);
        const r = await restoreQuiet([step.id], false);
        if (r.failed.length) {
          const f = r.failed[0].error;
          throw f instanceof Error ? f : fail('restore', String(f));
        }
      }
    } catch (e) {
      logLine(`fileops undo ${step.op} failed: ${e && caught(e).code} ${e && caught(e).message}`, 'warn');
      failed.push({ step, error: (e && caught(e).message) || String(e) });
    }
  }
  return failed;
}
