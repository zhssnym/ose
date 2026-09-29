// Drag in (docs/SHELL.md "Drag in", contract §5.5): the one place the tree and the folder view
// go for a drop from the OS.
//
// A drop from Explorer or Finder is an ordinary HTML5 `drop`. `takeDropped` turns the drop's items into entries — folders
// walked with `webkitGetAsEntry()`, their children read in batches — and `importDropped`
// hands them to `ose.fileops.importEntries`, which makes the folders, writes every file as its
// bytes through the create-only `createNewBinary` (never over anything, a taken name gets a
// free one) and records one undo step. Nothing here reads a file as text: a byte-order mark
// or a file in another encoding lands as it was. A drag of a row is the internal move; a
// browser tab cannot drag a vault file out to the system, so nothing here does.

import { ose } from 'ose:kernel';
import { toast } from 'ose:ui';
import { baseName, errorOf } from './paths.js';
import { undo } from './fileops.js';

/** The private type an internal drag carries: a JSON list of vault paths (C17). */
export const DRAG_TYPE = 'application/x-os-path';

// The paths an internal drag carries, while it lasts: `getData` is unreadable during dragover,
// and the tree and the folder view both need them there to know which folders may light up.
let draggedNow = null;

/**
 * Say which vault paths a drag that started in this window carries (null when it ends).
 * @param {string[]|null} paths
 */
export function setDragged(paths) { draggedNow = paths && paths.length ? [...paths] : null; }

/**
 * The vault paths the drag in progress carries, when it started in this window.
 * @returns {string[]|null}
 */
export const dragged = () => draggedNow;

/** A file bigger than this is refused by a drop: 64 MB travels badly as base64 over IPC. */
export const DROP_MAX_BYTES = 64 * 1024 * 1024;

// Above this many items the copy says it has started, so a long one is not a silent one.
const PROGRESS_AT = 20;

/**
 * What the platform's own file manager is called, for the refusal of a file too large.
 * @returns {string}
 */
const fileManager = () => (ose.platform === 'windows' ? 'Explorer' : ose.platform === 'macos' ? 'Finder' : 'the file manager');

/**
 * Whether a drag carries files from outside the window.
 * @param {DataTransfer|null|undefined} dt
 * @returns {boolean}
 */
export const hasOsFiles = (dt) => !!dt && [...(dt.types || [])].includes('Files');

/**
 * Whether a drag is one of ours (a row of the tree or of a folder view).
 * @param {DataTransfer|null|undefined} dt
 * @returns {boolean}
 */
export const isInternal = (dt) => !!dt && [...(dt.types || [])].includes(DRAG_TYPE);

/** @typedef {{ path: string, kind: 'dir'|'file', file?: File }} DropEntry */

/** `reader.readEntries` as a promise: one batch, empty at the end. */
const readBatch = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
/** `entry.file` as a promise. */
const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

/**
 * One dropped entry and, for a folder, everything under it, in order: a folder before what it
 * holds. A file over the limit is not an entry: it is refused, with the reason.
 */
async function walk(entry, prefix, out, refused) {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isDirectory) {
    out.push({ path, kind: 'dir' });
    const reader = entry.createReader();
    // Chromium answers at most 100 children a call: read until a batch comes back empty.
    for (;;) {
      let batch;
      try { batch = await readBatch(reader); } catch (e) { refused.push({ path, error: errorOf(e).message || 'could not be read' }); return; }
      if (!batch.length) break;
      for (const child of batch) await walk(child, path, out, refused);
    }
    return;
  }
  if (!entry.isFile) return;
  let file;
  try { file = await fileOf(entry); } catch (e) { refused.push({ path, error: errorOf(e).message || 'could not be read' }); return; }
  if (file.size > DROP_MAX_BYTES) {
    refused.push({ path, error: `too large to copy by drop; copy it in ${fileManager()}` });
    return;
  }
  out.push({ path, kind: 'file', file });
}

/**
 * The entries of an OS drop. **Call it inside the `drop` handler**, before any `await`: the
 * drop's items are readable only while the event is being dispatched, and the entries are
 * taken from them at once; the walk that follows is asynchronous.
 * @param {DataTransfer} dt
 * @returns {Promise<{ entries: DropEntry[], refused: {path: string, error: string}[] }>}
 */
export function takeDropped(dt) {
  const roots = [];
  const loose = [];
  const items = dt && dt.items ? [...dt.items] : [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) roots.push(entry);
    else { const f = item.getAsFile(); if (f) loose.push(f); }
  }
  if (!items.length && dt && dt.files) loose.push(...dt.files);
  return (async () => {
    /** @type {DropEntry[]} */
    const entries = [];
    /** @type {{path: string, error: string}[]} */
    const refused = [];
    for (const entry of roots) await walk(entry, '', entries, refused);
    for (const f of loose) {
      if (f.size > DROP_MAX_BYTES) refused.push({ path: f.name, error: `too large to copy by drop; copy it in ${fileManager()}` });
      else entries.push({ path: f.name, kind: 'file', file: f });
    }
    return { entries, refused };
  })();
}

/** What did not come in, said once: the first few by name, with their reasons. */
function sayRefused(list) {
  if (!list.length) return;
  const shown = list.slice(0, 4).map((r) => `${baseName(r.path)} (${r.error})`);
  const more = list.length > shown.length ? `, and ${list.length - shown.length} more` : '';
  const head = list.length === 1 ? 'Not copied in' : `${list.length} items not copied in`;
  toast(`${head}: ${shown.join('; ')}${more}`, 'err', 0);
}

/**
 * Copy an OS drop into `folder`. Answers when it is done; every outcome is a toast (the copy,
 * with Undo when the journal took it, and what was refused).
 * @param {Promise<{ entries: DropEntry[], refused: {path: string, error: string}[] }>|{ entries: DropEntry[], refused: {path: string, error: string}[] }} dropped what `takeDropped` answered
 * @param {string} folder a vault folder, '' for the root
 * @returns {Promise<string[]>} the vault paths created
 */
export async function importDropped(dropped, folder) {
  let got;
  try { got = await dropped; } catch (e) { toast(`Could not read the drop: ${errorOf(e).message}`, 'err', 0); return []; }
  const { entries, refused } = got;
  const files = entries.filter((e) => e.kind === 'file').length;
  if (!entries.length) { sayRefused(refused); return []; }
  const where = folder || 'the vault root';
  const busy = entries.length > PROGRESS_AT ? toast(`Copying ${entries.length} items into ${where}…`, 'info', 0) : null;
  let res;
  try {
    res = await ose.fileops.importEntries(entries, folder);
  } catch (e) {
    if (busy) busy();
    sayRefused(refused);
    toast(`Could not copy in: ${errorOf(e).message}`, 'err', 0);
    return [];
  }
  if (busy) busy();
  const created = (res && res.created) || [];
  const failed = ((res && res.failed) || []).map((f) => ({ path: f.path, error: errorOf(f.error).message || 'failed' }));
  sayRefused(refused.concat(failed));
  if (created.length) {
    const entry = res && res.entry;
    const what = files === 1 && entries.length === 1 ? baseName(created[0]) : `${created.length} item${created.length === 1 ? '' : 's'}`;
    const text = (entry && entry.label) || `Copied ${what} into ${where}`;
    const canUndo = !!(entry && entry.id && entry.undoable !== false);
    toast(text, 'info', canUndo ? 6000 : 2600, canUndo ? {
      actions: [{ label: 'Undo', run: () => undo(entry.id) }],
    } : {});
    ose.bus.emit('tree:reveal', { path: created[0], focus: false });
  }
  return created;
}
