// Part of the sidebar (./sidebar.ts). Reading the tree, and keeping it current with what the app
// and the disk did.

import { confirm, toast } from '../ui/index.ts';
import { vaultLost } from './vault.ts';
import { baseName, clean, dirName, errorOf, join, segments } from './paths.ts';
import { setSidebarOpen } from './layout.ts';
import {
  debounce, files, findInbound, messageOf, rewriteInboundMany, showHidden, state,
} from './sidebar-state.ts';
import type { TreeNode } from './sidebar-state.ts';
import { expandAncestors, findNode, followPins, persistExpanded, render, rowFor } from './sidebar-tree.ts';
import { scrollToCurrent } from './sidebar-select.ts';

/* ------------------------------------------------------------------ data load */

const codeOf = (e) => errorOf(e).code;

/**
 * Whether the vault folder itself is gone. `tree` answers `io` for a root it cannot read, so the
 * root is listed once more: a missing folder answers `not_found` there, as every listing does.
 */
async function vaultGone(e) {
  const code = codeOf(e);
  if (code === 'no_vault' || code === 'not_found') return true;
  try { await files.list('', { hidden: false }); return false; } catch (again) {
    const c = codeOf(again);
    return c === 'not_found' || c === 'no_vault';
  }
}

let treeLoad: Promise<void> | null = null;

/**
 * Read the whole tree again. Boot, a watcher `rescan` or `lost`, and Show hidden items
 * flipping; everything else patches (M16).
 */
export async function refreshTree() {
  if (treeLoad) return treeLoad;
  treeLoad = (async () => {
    const hidden = showHidden();
    try {
      state.tree = await files.tree({ hidden });
      state.readHidden = hidden;
    } catch (e) {
      console.error('[shell] tree', e);
      // A read that fails because the folder itself is gone is not a tree bug, and a toast per
      // failed call is noise on top of a vault that has been unplugged (S29): the shell has
      // one dialog for it, and `vaultLost` is idempotent while that dialog is up.
      if (await vaultGone(e)) { vaultLost(); return; }
      toast('Could not read the vault: ' + messageOf(e), 'err');
      return;
    }
    if (state.tree) { state.tree.path = ''; if (!state.tree.children) state.tree.children = []; }
    render();
    scrollToCurrent();
  })();
  try { await treeLoad; } finally { treeLoad = null; }
}

/**
 * List one folder and put its entries in place of the ones the tree holds. A subfolder the tree
 * had already read keeps its children; one it had not is answered in the list of new folders.
 * Answers null when the folder could not be listed (and a gone one hands the question up to
 * its parent).
 */
async function relistOne(path: string): Promise<string[] | null> {
  let entries;
  try { entries = await files.list(path, { hidden: showHidden() }); } catch (e) {
    const code = codeOf(e);
    if (code === 'not_found' && path) { pendingDirs.add(dirName(path)); return null; }
    if (code === 'no_vault') { vaultLost(); return null; }
    console.warn('[shell] list', path, e);
    return null;
  }
  const node = findNode(path);
  if (!node || node.kind !== 'dir') return null;
  const old = new Map((node.children || []).map((c) => [c.name, c]));
  const fresh: string[] = [];
  node.children = (entries || []).map((e) => {
    const n: TreeNode = { ...e, path: e.path != null ? clean(e.path) : join(path, e.name) };
    const prev = old.get(e.name);
    if (n.kind === 'dir' && !n.link) {
      if (prev && prev.kind === 'dir' && prev.children) n.children = prev.children;
      else fresh.push(n.path);
    }
    return n;
  });
  return fresh;
}

// Folders whose listing is out of date, gathered from a batch of changes and read together.
const pendingDirs = new Set<string>();
let patchTimer: ReturnType<typeof setTimeout> | null = null;
let patching: Promise<void> | null = null;
// A folder that arrived whole (moved in from Explorer) is read down to its files, so quick
// open finds them; past this many listings in one batch the whole tree is read instead.
const PATCH_BUDGET = 200;

function schedulePatch(dirs) {
  for (const d of dirs) pendingDirs.add(clean(d));
  if (patchTimer) return;
  patchTimer = setTimeout(() => { patchTimer = null; void flushPatch(); }, 60);
}

async function flushPatch() {
  if (patching) { await patching; if (pendingDirs.size) schedulePatch([]); return; }
  patching = (async () => {
    if (!state.tree) { pendingDirs.clear(); await refreshTree(); return; }
    let budget = PATCH_BUDGET;
    while (pendingDirs.size) {
      // Each changed path's nearest folder the tree has read: a change inside a folder the tree
      // never unfolded is that folder's news, not the tree's.
      const targets = new Set<string>();
      for (let d of pendingDirs) {
        let n = findNode(d);
        while (d && (!n || n.kind !== 'dir' || !n.children)) { d = dirName(d); n = findNode(d); }
        if (n && n.kind === 'dir' && n.children) targets.add(d);
      }
      pendingDirs.clear();
      const order = [...targets].sort((a, b) => segments(a).length - segments(b).length);
      const queue = [...order];
      while (queue.length) {
        if (--budget < 0) { pendingDirs.clear(); await refreshTree(); return; }
        const fresh = await relistOne(queue.shift()!);
        if (fresh) queue.push(...fresh);
      }
    }
    render();
  })();
  try { await patching; } finally { patching = null; }
}

/** A folder the tree had not read (past the walk's depth), read when it is unfolded. */
const loadingDirs = new Set<string>();
export async function loadChildren(path) {
  if (loadingDirs.has(path)) return;
  loadingDirs.add(path);
  try {
    await relistOne(path);
    const n = findNode(path);
    if (n && n.kind === 'dir' && !n.children) n.readable = false;
  } finally { loadingDirs.delete(path); }
  render();
}

// Autosaves: a `modify` of a file the tree already has only changes its size and time, which
// the tree does not draw; the node is brought up to date quietly, a few at a time.
const staleFiles = new Set<string>();
const statStale = debounce(async () => {
  const list = [...staleFiles];
  staleFiles.clear();
  for (const p of list) {
    try {
      const st = await files.stat(p);
      const n = findNode(p);
      if (n && st && st.exists !== false) { if (st.mtime != null) n.mtime = st.mtime; if (st.size != null) n.size = st.size; }
    } catch { /* the next listing of its folder says the rest */ }
  }
}, 400);

/** The watcher's half of M16: which folders to re-list, and nothing more. */
export function onFsTree(payload) {
  if (!payload) return;
  if (payload.lost || payload.rescan) { void refreshTree(); return; }
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const dirs: string[] = [];
  for (const c of changes) {
    if (!c || !c.path) continue;
    const p = clean(c.path);
    if (c.hidden && !c.to && !showHidden()) continue;
    if (c.kind === 'modify' && !c.to) {
      const n = findNode(p);
      if (n && n.kind === 'file') { staleFiles.add(p); continue; }
    }
    dirs.push(dirName(p));
    if (c.to) dirs.push(dirName(clean(c.to)));
    // A folder itself changed (created, removed, renamed): its own listing may be stale too.
    if (c.dir) dirs.push(p);
  }
  if (staleFiles.size) statStale();
  if (dirs.length) schedulePatch(dirs);
}

/* ------------------------------------------------------------------ what the app did */

/**
 * The from/to pairs a move produces, read from the tree before it happens: the path itself,
 * and for a folder every file under it, because the watcher reports a folder moved in the app
 * as one rename per file and the N19 question below must not ask about any of them.
 */
function filePairs(from, to) {
  const out = [{ from, to }];
  const node = findNode(from);
  if (!node || node.kind !== 'dir') return out;
  const walk = (n) => {
    for (const c of n.children || []) {
      if (c.kind === 'dir') walk(c); else out.push({ from: c.path, to: to + c.path.slice(from.length) });
    }
  };
  walk(node);
  return out;
}

// The focused row's path when a move of it began (`paths:moving`), so `paths:moved` can put the
// keyboard back on it even if a watcher re-list moved focus in between.
let movedFocus: string | null = null;

const followMove = (p, from, to) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : null);

/**
 * `paths:moving` (src/shell/fileops.ts, before the host call): the watcher will report these a
 * moment later, and the links are about to be rewritten by `ose.fileops` itself, so the N19
 * question must not offer to fix them.
 */
export function onMoving(d) {
  movedFocus = null;
  for (const m of (d && d.moves) || []) {
    if (!m || !m.from || !m.to) continue;
    if (state.roving === 'path:' + clean(m.from)) movedFocus = clean(m.from);
    for (const p of filePairs(clean(m.from), clean(m.to))) noteSelfMove(p.from, p.to);
  }
}

/**
 * `paths:moved` (`ose.fileops`, after the host call): expansion, the selection and the focused
 * row follow the files to their new paths, and the two folders are listed again. The page and
 * its tab have followed already; nothing here navigates.
 */
export function onMoved(d) {
  const moves = ((d && d.moves) || []).filter((m) => m && m.from && m.to).map((m) => ({ from: clean(m.from), to: clean(m.to) }));
  if (!moves.length) return;
  const dirs: string[] = [];
  for (const m of moves) {
    noteSelfMove(m.from, m.to);
    for (const p of [...state.expanded]) { const n = followMove(p, m.from, m.to); if (n) { state.expanded.delete(p); state.expanded.add(n); } }
    // Where it went is opened, so the row can be seen and focused there.
    expandAncestors(m.to);
    // The row the user was on has a new name; the next render focuses it there (B4, D1).
    if (state.roving === 'path:' + m.from || movedFocus === m.from) state.focusAfterRender = 'path:' + m.to;
    else if (state.roving === 'pin:' + m.from) state.focusAfterRender = 'pin:' + m.to;
    dirs.push(dirName(m.from), dirName(m.to));
  }
  persistExpanded();
  followPins(moves);
  if (state.selected.size) {
    const next = new Set<string>();
    for (const p of state.selected) {
      let moved = null;
      for (const m of moves) { moved = followMove(p, m.from, m.to); if (moved) break; }
      next.add(moved || p);
    }
    state.selected = next;
  }
  schedulePatch(dirs);
}

/** `paths:trashed`: what went takes its expansion and its place in the selection. */
export function onTrashed(d) {
  const paths = ((d && d.paths) || []).map(clean).filter(Boolean);
  if (!paths.length) return;
  for (const p of paths) {
    for (const e of [...state.expanded]) if (followMove(e, p, p)) state.expanded.delete(e);
    for (const s of [...state.selected]) if (followMove(s, p, p)) state.selected.delete(s);
  }
  persistExpanded();
  schedulePatch(paths.map(dirName));
}

/** `paths:created`, `paths:copied`, `paths:restored`: the tree opens down to them and lists their folders. */
export function onArrived(paths) {
  const list = paths.map(clean).filter(Boolean);
  if (!list.length) return;
  for (const p of list) expandAncestors(p);
  persistExpanded();
  schedulePatch(list.map(dirName));
}

/** `tree:reveal` (./fileops.ts): show a path the person just made, and with `focus` put the keyboard on it. */
export function onReveal(d) {
  const p = clean(d && d.path);
  if (!p) return;
  expandAncestors(p);
  // A folder gone to on purpose (a link, the path bar) opens as well.
  if (d.open) { state.expanded.add(p); void loadChildren(p); }
  persistExpanded();
  if (d.focus) state.focusAfterRender = 'path:' + p;
  setSidebarOpen(true);
  schedulePatch([dirName(p)]);
}

/* ------------------------------------------------- renames made outside the app (N19) */

// A move the app made itself: the watcher reports it a moment later, and the links have
// already been rewritten by `ose.fileops`. Keyed `from>to`, forgotten after a few seconds.
const selfMoves = new Map();
const SELF_MOVE_MS = 8000;

function noteSelfMove(from, to) {
  const now = Date.now();
  selfMoves.set(from + '>' + to, now);
  for (const [k, at] of selfMoves) if (now - at > SELF_MOVE_MS) selfMoves.delete(k);
}

/**
 * Where a row went, when the app is moving it right now: the watcher can re-list the folder
 * before `paths:moved` arrives, and the focused row must follow the file, not fall to its
 * neighbour.
 */
export function movedKey(key) {
  if (!key || !key.startsWith('path:')) return null;
  const from = key.slice(5);
  let best = null, at = 0;
  for (const [k, t] of selfMoves) {
    const i = k.indexOf('>');
    if (k.slice(0, i) === from && t >= at && Date.now() - t <= SELF_MOVE_MS) { best = k.slice(i + 1); at = t; }
  }
  return best ? 'path:' + best : null;
}

const wasSelfMove = (from, to) => {
  const at = selfMoves.get(from + '>' + to);
  return !!at && Date.now() - at <= SELF_MOVE_MS;
};

// Renames the watcher has reported and we have not asked about yet. They are collected rather
// than handled one by one, because moving a folder in Explorer arrives as one event per file.
/** A path renamed or moved: where it was, and where it is now. */
type Move = { from: string, to: string };
let pendingRenames: Move[] = [];
let askingRenames = false;

/**
 * A file renamed or moved from outside — Explorer, an agent, a terminal — leaves every link
 * into it pointing at a name that is gone (N19). The app cannot silently rewrite files the
 * user did not ask it to touch, so it asks, once, and only when there is something to fix:
 * the question names the count, and answering no leaves every file exactly as it is.
 */
export async function askAboutRenames() {
  if (askingRenames || !pendingRenames.length) return;
  askingRenames = true;
  const moves = pendingRenames;
  pendingRenames = [];
  try {
    // Which of them anything actually links to. One search per moved name; a rename nobody
    // linked to is never mentioned at all.
    const real: Move[] = [];
    let count = 0;
    const where = new Set();
    for (const m of moves) {
      let inbound: Awaited<ReturnType<typeof findInbound>> = [];
      try { inbound = await findInbound(m.from); } catch (e) { console.error('[shell] links', e); continue; }
      if (!inbound.length) continue;
      real.push(m);
      for (const p of inbound) { count += p.count; where.add(p.path); }
    }
    if (!real.length) return;
    const one = real.length === 1 ? real[0] : null;
    const linksWord = `${count} link${count === 1 ? '' : 's'}`;
    const filesWord = `${where.size} file${where.size === 1 ? '' : 's'}`;
    const ok = await confirm({
      title: 'Update links?',
      body: one
        ? `${baseName(one.from)} was moved to ${one.to} outside the app. ${linksWord} in ${filesWord} still point at the old name.`
        : `${real.length} files were moved outside the app. ${linksWord} in ${filesWord} still point at their old names.`,
      ok: `Update ${linksWord}`,
    });
    if (!ok) return;
    const res = await rewriteInboundMany(real);
    toast(res.links
      ? `${res.links} link${res.links === 1 ? '' : 's'} in ${res.files} file${res.files === 1 ? '' : 's'} updated`
      : 'Nothing to update', 'info', 2600);
    for (const p of res.failed || []) toast('Could not update links in ' + p, 'err', 0);
  } finally {
    askingRenames = false;
    if (pendingRenames.length) void askAboutRenames();
  }
}

/** The `fs` half: collect the paired renames that were not ours. */
export function onFsRenames(payload) {
  const changes = payload && Array.isArray(payload.changes) ? payload.changes : [];
  for (const c of changes) {
    if (!c || c.kind !== 'rename' || !c.to || !c.path) continue;
    const from = clean(c.path), to = clean(c.to);
    if (!from || !to || from === to || wasSelfMove(from, to)) continue;
    // Into `.trash` or another hidden place: the file left, and a link to it has nowhere to go.
    const dotted = (p) => p.split('/').some((seg) => seg.startsWith('.'));
    if (dotted(to) && !dotted(from)) continue;
    pendingRenames.push({ from, to });
  }
}

/** Expand the tree down to a folder and bring it into view. No navigation. */
export function revealFolder(path) {
  const dir = clean(path);
  setSidebarOpen(true);
  if (dir) { expandAncestors(dir + '/x'); state.expanded.add(dir); } else state.rootOpen = true;
  persistExpanded();
  render();
  requestAnimationFrame(() => {
    const n = rowFor(dir);
    if (n) n.scrollIntoView({ block: 'center' });
  });
}
