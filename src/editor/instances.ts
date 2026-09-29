// The live page editors, one per open file (wave 2, M12 and M24).
//
// A page that is left for another tab is not torn down any more: its editor is **parked**. The
// column is taken out of the document and kept, with the ProseMirror or CodeMirror state inside
// it, so coming back to the tab puts back the same buffer, the same undo history, the same
// mode, the caret and the scroll. One instance per path, not per tab: the same file in two tabs
// is one buffer, and a save from one is never a conflict for the other.
//
// This file is only the register. What an instance is, and what parking and coming back do to
// it, is page.ts's; the register knows the handful of things every instance answers:
//
//   inst.path()        the file it holds, or null
//   inst.parked        true while its column is out of the document
//   inst.usedAt        when it was last on screen (ms), for the least-recently-used order
//   inst.evictable()   parked, clean, nothing standing between the buffer and the disk
//   inst.handle        the handle `markdownPage` answered; `handle.close()` destroys it
//
// Autosave, drafts, the watcher, the leave gate and the path changes keep covering a parked
// instance: page.ts iterates over `instances` for all of them, parked or not. Only the active
// instance — the one on screen that holds the focus — publishes the status bar and the title.

/** How many parked editors are kept alive. Past it the least recently used clean one goes. */
export const PARK_MAX = 8;

/** Every live instance, on screen or parked. */
export const instances = new Set<any>();

let active: any = null;

/** The instance the commands and the status bar belong to, or null. */
export const activeInstance = () => active;

/** Make `inst` the active instance (null: none). */
export function setActive(inst) { active = inst || null; }

/** The parked instance holding `path`, or null. */
export function findParked(path) {
  if (!path) return null;
  for (const i of instances) if (i.parked && i.path() === path) return i;
  return null;
}

/** The paths of every parked instance, most recently used first. */
export function parkedPaths() {
  return [...instances]
    .filter((i) => i.parked && i.path())
    .sort((a, b) => b.usedAt - a.usedAt)
    .map((i) => i.path());
}

/**
 * The parked instances past the cap that may go, least recently used first. A dirty instance,
 * or one whose text is not on disk for any reason, is never among them: the cap is a memory
 * budget, and memory is never paid for with text.
 */
export function overCap(max = PARK_MAX) {
  const parked = [...instances].filter((i) => i.parked).sort((a, b) => a.usedAt - b.usedAt);
  let extra = parked.length - max;
  const out: any[] = [];
  for (const i of parked) {
    if (extra <= 0) break;
    if (!i.evictable()) continue;
    out.push(i);
    extra--;
  }
  return out;
}
