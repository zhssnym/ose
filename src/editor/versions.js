// Versions: the previous content of a file kept under .ose/versions before a save changes it;
// the Versions… dialog that lists and restores. Host side in src-tauri/src/versions.rs, dev
// side in dev/bridge-plugin.mjs. See docs/HOST.md "Versions".
//
// Nothing here is on the critical path of a save except one rpc, and that rpc can fail without
// the save noticing: a version is insurance, never a precondition. Every call is swallowed and
// logged.

import { bridge, commands } from './host.js';
import { choose, openOverlay, toast } from './deps.js';

/** The api handed over by index.js at boot (registerExtensionCommands). */
let api = null;

/**
 * Keep `previous` (the text the page was opened from or last wrote) before `next` replaces it
 * on disk. Must never throw and never block a save for long.
 * @param {string} path  vault-relative
 * @param {string} previous
 * @param {string} next
 */
export async function keepVersion(path, previous, next) {
  if (!path || !previous || previous === next) return;
  try {
    await bridge.versionKeep(path, previous, false);
  } catch (e) {
    // An old host has no `versionKeep`; a full disk has no room. Neither may stop a save.
    console.warn('[editor] version not kept', e && e.message ? e.message : e);
  }
}

/**
 * The one moment a version is not optional: "Keep mine" in the changed-on-disk dialog is about
 * to overwrite text this editor has never seen, so the disk's text is kept whatever the
 * five-minute rule says.
 */
export async function keepDiskVersion(path, text) {
  if (!path || !text) return;
  try {
    await bridge.versionKeep(path, text, true);
  } catch (e) {
    console.warn('[editor] disk version not kept', e && e.message ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// the dialog

/**
 * `+N −M lines` between two texts, without a real diff: a line present more often in one text
 * than in the other is counted once per extra occurrence. Order is ignored, which is exactly
 * what a one-line summary should ignore, and it costs one pass instead of an LCS over a file
 * that can be thousands of lines long.
 */
export function diffSummary(before, after) {
  const count = (text) => {
    const m = new Map();
    for (const line of String(text ?? '').split('\n')) {
      if (!line.trim()) continue;
      m.set(line, (m.get(line) || 0) + 1);
    }
    return m;
  };
  const a = count(before);
  const b = count(after);
  let added = 0;
  let removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) || 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) || 0));
  return { added, removed };
}

const two = (n) => String(n).padStart(2, '0');

/** `10 Sep · 20:15`, local time, from the epoch milliseconds the host reports. */
function when(at) {
  const d = new Date(Number(at) || 0);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${d.getDate()} ${month} · ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const size = (bytes) => {
  const n = Number(bytes) || 0;
  return n < 1024 ? `${n} B` : `${Math.round(n / 1024)} kB`;
};

/** Every version of `path` with the diff summary against `current`, newest first. */
async function loadVersions(path, current) {
  const list = await bridge.versionList(path);
  const rows = Array.isArray(list) ? list : [];
  const texts = await Promise.all(rows.map(async (r) => {
    try { return await bridge.versionRead(path, r.id); } catch { return null; }
  }));
  return rows.map((r, i) => ({
    ...r,
    text: texts[i],
    // What restoring this version would do to the file as it is now, which is the question
    // the row is answering — not the other way round.
    diff: texts[i] === null ? null : diffSummary(current, texts[i]),
  }));
}

/**
 * Restore one version. The page is flushed first so the reopen cannot lose a buffer, and so
 * the write below is never seen as somebody else changing the file under a dirty page.
 */
async function restore(path, id) {
  if (api && api.hasPage() && api.getPath() === path) {
    const ok = await api.saveNow({ explicit: true });
    if (!ok) { toast('not restored: the page has unsaved changes waiting on you', 'warn'); return; }
  }
  try {
    await bridge.versionRestore(path, id);
  } catch (e) {
    toast('could not restore that version: ' + (e && e.message ? e.message : e), 'err');
    return;
  }
  if (api && api.hasPage() && api.getPath() === path) await api.reopenInPlace();
  toast('version restored · the undo history was cleared', 'info', 6000);
}

/** The list, on the shell's overlay stack. Arrow keys move, Enter restores, Esc closes. */
function versionsOverlay(ov, path, rows) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const box = ov.box;
    box.classList.add('dlg', 'ed-versions');

    const head = document.createElement('div');
    head.className = 'dlg-head label';
    head.textContent = 'Versions';

    const body = document.createElement('div');
    body.className = 'dlg-body ed-versions-body';

    const foot = document.createElement('div');
    foot.className = 'dlg-foot';
    const note = document.createElement('span');
    note.className = 'grow ed-versions-note';
    note.textContent = `${rows.length} kept · ${path}`;
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = 'Close';
    cancel.addEventListener('click', () => finish(null));
    const ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.textContent = 'Restore';
    ok.addEventListener('click', () => finish(rows[sel] ? rows[sel].id : null));
    foot.append(note, cancel, ok);

    let sel = 0;
    const paint = () => {
      // The rows are rebuilt, so the focused one is destroyed with them: whether the focus was
      // inside the list is decided before, and given back to the new current row after.
      const had = body.contains(document.activeElement);
      body.textContent = '';
      rows.forEach((r, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'row' + (i === sel ? ' current' : '');
        const time = document.createElement('span');
        time.className = 'grow';
        time.textContent = when(r.at);
        const diff = document.createElement('span');
        diff.className = 'hint';
        diff.textContent = r.diff ? `+${r.diff.added} −${r.diff.removed}` : 'unreadable';
        const bytes = document.createElement('span');
        bytes.className = 'hint ed-versions-size';
        bytes.textContent = size(r.bytes);
        row.append(time, diff, bytes);
        row.addEventListener('click', () => { sel = i; paint(); });
        row.addEventListener('dblclick', () => finish(r.id));
        body.append(row);
      });
      const current = body.querySelector('.row.current');
      current?.scrollIntoView({ block: 'nearest' });
      if (had) current?.focus();
    };
    paint();

    box.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, rows.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(rows[sel] ? rows[sel].id : null); }
    });

    box.append(head, body, foot);
    // Straight away, not on a frame: a hidden window fires no frames and the dialog would
    // open with the focus still in the page behind it.
    const first = body.querySelector('.row');
    (first || ok).focus();
  });
}

/** Without the shell: the same choice on the fallback surface deps.js builds. */
function versionsFallback(rows) {
  return choose({
    title: 'Versions',
    body: 'Restore an earlier version of this page.',
    options: [
      { label: 'Close', value: null },
      ...rows.slice(0, 8).map((r) => ({
        label: `${when(r.at)}  ${r.diff ? `+${r.diff.added} −${r.diff.removed}` : ''}`,
        value: r.id,
      })),
    ],
    cancel: null,
  });
}

async function openVersions() {
  const path = api ? api.getPath() : null;
  if (!path) return;
  let current = '';
  try { current = await bridge.readText(path); } catch { /* a gone file still has versions */ }
  let rows;
  try {
    rows = await loadVersions(path, current);
  } catch (e) {
    toast('could not read the version history: ' + (e && e.message ? e.message : e), 'err');
    return;
  }
  if (!rows.length) { toast('no versions of this page yet', 'info'); return; }

  // `title` is what `openOverlay` puts on the box as its aria-label: a dialog with no
  // accessible name is announced as just "dialog".
  const ov = await openOverlay({ width: 520, className: 'dlg-ov', title: 'Versions' });
  const id = ov ? await versionsOverlay(ov, path, rows) : await versionsFallback(rows);
  if (id) await restore(path, id);
}

export function registerCommands(a) {
  api = a;
  commands.register({
    id: 'page.versions',
    title: 'Versions…',
    group: 'page',
    when: () => !!(api && api.hasPage()),
    run: () => void openVersions(),
  });
}
