// Part of the markdown page (../page.ts). The listeners one document has one of, and the calls
// that act on every open page.

import { bus, onWindowLeave } from '../host.ts';
import { activeInstance, findParked, instances, parkedPaths as parkedList } from '../instances.ts';
import { bindPagePath } from '../link.ts';
import { renameMode } from '../modes.ts';
import * as P from '../paths.ts';
import { errText } from './shared.ts';

// ---------------------------------------------------------------------------
// the listeners one document has one of

let globalsWired = false;

export function wireGlobals() {
  if (globalsWired) return;
  globalsWired = true;
  // link.ts turns a picked page into an href relative to the page being edited.
  bindPagePath(() => (activeInstance() ? activeInstance().path() : null));
  // The bridge facade already re-emits 'fs' onto the bus; listening to both would reload twice.
  bus.on('fs', (payload) => { for (const i of [...instances]) i.onFsChange(payload); });
  // Spellcheck is a setting now (L12/E43): a page already open follows a change to it.
  bus.on('settings', () => { for (const i of [...instances]) i.applySpellcheck(); });
  // C5: the one leave gate. Closing the window, reloading it and switching vaults all await
  // this, and a false keeps the window (docs/CORE.md `ose.window.onLeave`). The pages that
  // said yes stay frozen until the core says the window stays after all.
  onWindowLeave(() => leaveAll());
  bus.on('window:stay', () => { for (const i of [...instances]) i.stay(); });
  // No save can finish in `beforeunload`; a draft can be started, and the browser is asked to
  // keep the page. The leave gate above is the path that saves.
  window.addEventListener('beforeunload', (e) => {
    let any = false;
    for (const i of [...instances]) if (i.isDirty()) { any = true; void i.writeDraft(); }
    if (any) { e.preventDefault(); e.returnValue = ''; }
  });
  // A window that is hidden may be the last thing that happens to it (logout, a killed process).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    for (const i of [...instances]) if (i.isDirty()) { void i.writeDraft(); void i.save(); }
  });
}

/** Every page lets the window go, or the window stays. False if any page says no. */
async function leaveAll() {
  let ok = true;
  for (const i of [...instances]) {
    let answer = true;
    try { answer = await i.leaveWindow(); } catch (e) { console.error('[editor] leave', e); answer = false; }
    if (answer === false) ok = false;
  }
  return ok;
}

/**
 * Save every mounted page. False if any page answered false (§6.2).
 */
export async function saveAll(opts: { explicit?: boolean; closing?: boolean; }) {
  let ok = true;
  for (const i of [...instances]) {
    let answer = true;
    try { answer = await i.save(opts); } catch (e) { console.error('[editor] save all', e); answer = false; }
    if (answer === false) ok = false;
  }
  return ok;
}

/**
 * Before a rename, move, trash or copy of `from` (a file, or a folder: every page under it),
 * each mounted page at or under it is flushed (§6.3). One refusal refuses the whole change,
 * and the pages that had already agreed are told it did not happen.
 */
export async function beforePathChange(change: { kind: 'rename' | 'move' | 'trash' | 'copy'; from: string; to: string | null; }): Promise<{ ok: boolean; reason?: string; }> {
  if (!change || !change.from) return { ok: true };
  const agreed: any[] = [];
  for (const i of [...instances]) {
    if (!i.covers(change.from)) continue;
    let r;
    try { r = await i.beforePathChange(change); } catch (e) { r = { ok: false, reason: errText(e) }; }
    if (!r || r.ok === false) {
      for (const a of agreed) { try { await a.afterPathChange({ ...change, ok: false }); } catch { /* told */ } }
      return { ok: false, reason: (r && r.reason) || 'a page has unsaved changes that could not be saved' };
    }
    agreed.push(i);
  }
  return { ok: true };
}

/**
 * After the host call, whether it succeeded (`ok`) or not: the pages that were asked follow
 * the new path, stay as they were, or let go of a trashed file (§6.3).
 */
export async function afterPathChange(change: { kind: string; from: string; to: string | null; ok: boolean; }) {
  if (!change || !change.from) return;
  // The mode each file remembers follows it, open or not, a whole folder at a time (modes.ts).
  if (change.ok && change.to && (change.kind === 'rename' || change.kind === 'move')) void renameMode(change.from, change.to);
  for (const i of [...instances]) {
    try { await i.afterPathChange(change); } catch (e) { console.error('[editor] afterPathChange', e); }
  }
}

/**
 * `PageHost.release(path)` (M12): the parked instance of `path` is saved and destroyed, as a
 * background tab showing it is closed. True when there is none, or it went; false when its text
 * could not be saved, and then it stays, with its banner, for the tab to show again.
 */
export async function releasePage(path: string): Promise<boolean> {
  const inst = findParked(P.pagePath(String(path ?? '')));
  if (!inst) return true;
  try { return (await inst.handle.close()) !== false; } catch (e) {
    console.error('[editor] release', e);
    return false;
  }
}

/**
 * The paths of the parked instances, most recently used first (M12).
 */
export function parkedPaths(): string[] { return parkedList(); }

/**
 * `PageHost.problems()`: the paths of every live page, on screen or parked, whose text is not on
 * disk and could not be put there (not saved, a conflict, or its file deleted). The core's
 * leave gate names them, and reopens one no tab shows.
 */
export function problemPages(): string[] {
  const out: any[] = [];
  for (const i of instances) {
    let st = 'clean';
    try { st = i.api ? i.api.status() : 'clean'; } catch { st = 'clean'; }
    const path = i.path();
    if (path && ['not-saved', 'conflict', 'deleted'].includes(st)) out.push(path);
  }
  return out;
}

/**
 * `PageHost.rewriteLinksIn(path, pairs)` (H5, §4.8): the links of an open page — on screen or
 * parked — into files that moved are rewritten in the editor, as an edit of the page, instead of
 * the file being written on disk behind it. `{handled: false}` when no page holds `path`: the
 * core then rewrites the file on disk as before. `opts.settled`: the core's second pass,
 * where the file's own hrefs were already rewritten for the move.
 */
export async function rewriteLinksIn(path: string, pairs: Array<{ from: string; to: string; }>, opts: { settled?: boolean; } = {}): Promise<{ handled: boolean; changed?: number; failed?: string; }> {
  const target = P.pagePath(String(path ?? ''));
  if (!target) return { handled: false };
  for (const i of [...instances]) {
    if (!i.holds(target)) continue;
    try { return await i.rewriteLinks(target, pairs, opts || {}); } catch (e) {
      return { handled: true, changed: 0, failed: errText(e) };
    }
  }
  return { handled: false };
}
