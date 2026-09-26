// Recovered changes (C4, docs/SHELL.md "Recovered changes"). Text that never reached its file
// — a save that failed, a window closed anyway, a crash — is kept by the editor as a draft on
// this machine, outside the vault (docs/HOST.md "Drafts"). This file is the sheet that says so
// when the window opens: every page with a draft, and when it was written. Opening a row opens
// the page, and the editor puts the draft back or offers it (it knows whether the file changed
// since). A draft whose file is gone cannot be opened; it can be saved as a new file.
//
// The sheet comes up once, after the boot, and only when there is something in it. The command
// `app.recovered` brings it back while there is.

import { ose } from 'ose:kernel';
import { esc, openOverlay, overlayCount, prompt, confirm, toast } from 'ose:ui';
import { clean, baseName, dirName } from './paths.js';

const { bus, commands, route } = ose;

/** The last list the host answered: what `app.recovered`'s `when` reads. */
let known = [];
let openOv = null;

const drafts = () => (ose.files && ose.files.drafts) || null;

/** `DraftInfo[]`, newest first, or [] when there are none or the host cannot say. */
async function listDrafts() {
  const d = drafts();
  if (!d || typeof d.list !== 'function') return [];
  try {
    const list = await d.list();
    known = Array.isArray(list) ? list.filter((x) => x && x.path) : [];
  } catch (e) {
    // A host without drafts answers `unknown_command`: there is nothing to recover, and that is
    // not worth a notice. Anything else is logged.
    if (!e || e.code !== 'unknown_command') console.warn('[shell] drafts', e);
    known = [];
  }
  return known;
}

/** "today 14:02", "yesterday 09:10", or the date. */
function when(at) {
  const d = new Date(Number(at) || 0);
  if (!+d) return '';
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} ${time}`;
}

/**
 * A draft whose file is gone: saved as a new file with the draft's text, byte for byte, through
 * the one create (`ose.fileops.create`, never over an existing file). The draft is dropped only
 * once the new file holds its text.
 */
async function saveAs(info) {
  const d = drafts();
  let draft = null;
  try { draft = await d.read(info.path); } catch (e) { toast(`could not read the recovered text: ${e.message || e}`, 'err', 0); return false; }
  if (!draft || typeof draft.text !== 'string') { toast('the recovered text is gone', 'err', 0); return false; }
  let value = clean(info.path);
  let reason = '';
  for (;;) {
    const start = value.lastIndexOf('/') + 1;
    const { ext } = ose.names.split(value.slice(start));
    const typed = await prompt({
      title: 'Save Recovered Text As', value, ok: 'Save',
      select: [start, ext ? value.length - ext.length - 1 : value.length],
      body: reason || 'A vault path. Nothing existing is written over.',
    });
    if (!typed) return false;
    value = typed;
    const c = ose.names.check(typed, { folders: true });
    if (!c.ok) { reason = `${c.reason}.`; continue; }
    try {
      const { path } = await ose.fileops.create(dirName(c.name), baseName(c.name), { text: draft.text });
      try { await d.drop(info.path, { ifRev: draft.rev }); } catch (e) { console.warn('[shell] draft drop', e); }
      bus.emit('paths:created', { paths: [path] });
      await route.navigate({ type: 'page', path });
      return true;
    } catch (e) {
      if (e && (e.code === 'exists' || e.code === 'bad_name')) { reason = `${e.message}.`; continue; }
      toast(`could not save the recovered text: ${e && e.message ? e.message : e}`, 'err', 0);
      return false;
    }
  }
}

/**
 * The tab that shows `path` now, or null. A restored session (H19) mounts the tab in front
 * before this sheet comes up, and a page that finds its draft applies it: the buffer on screen
 * is then the recovered text, marked unsaved, and the next leave writes it.
 */
function tabShowing(path) {
  const list = ose.tabs && typeof ose.tabs.list === 'function' ? ose.tabs.list() : [];
  const tab = list.find((t) => t && t.route && t.route.type === 'page' && t.route.path === path);
  if (tab) return tab;
  const cur = route.current();
  return cur && cur.type === 'page' && cur.path === path ? { id: null, route: cur } : null;
}

/**
 * Throw a draft away, once asked. Dropping the draft alone is right only while no editor holds
 * it: a page open in a tab may have put the draft back into its buffer, and would write it into
 * the file on the next leave, the very text the user just said to discard. Such a page is
 * brought to the front and discards through its own command (`page.discard-changes`): the
 * buffer goes back to the file on disk, the draft goes, and the page asks its own question.
 * Answers true once the draft is gone.
 */
async function discard(info) {
  if (tabShowing(info.path)) {
    let shown = false;
    try { shown = await route.navigate({ type: 'page', path: info.path }); } catch (e) { console.warn('[shell] recovered discard', e); }
    const cur = route.current();
    if (shown === false || !cur || cur.type !== 'page' || cur.path !== info.path) {
      toast(`could not discard: ${info.path} could not be brought to the front`, 'err', 0);
      return false;
    }
    // Undefined: the command does not apply, so the page holds nothing of the draft (no unsaved
    // text, nothing offered) and the draft is dropped below like any other.
    const run = commands.run('page.discard-changes');
    if (run !== undefined) {
      try { await run; } catch (e) {
        toast(`could not discard: ${e && e.message ? e.message : e}`, 'err', 0);
        return false;
      }
      // What decides is whether the draft is gone, not what the page answered: a Cancel on the
      // page's own question keeps it.
      return !(await listDrafts()).some((x) => x.path === info.path);
    }
  }
  const ok = await confirm({
    title: 'Discard Recovered Text?',
    body: `The unsaved text of ${info.path} from ${when(info.at)} goes. The file itself is not touched.`,
    ok: 'Discard', danger: true,
  });
  if (!ok) return false;
  try { await drafts().drop(info.path); return true; } catch (e) {
    toast(`could not discard: ${e && e.message ? e.message : e}`, 'err', 0);
    return false;
  }
}

/**
 * The sheet. One row per draft: the file's name, its path and when the text was written. Enter
 * or a click opens it (or, for a file that is gone, saves it as a new one); Delete discards the
 * draft after asking. Up and Down walk the rows.
 */
export async function showRecovered() {
  if (openOv) return;
  const list = await listDrafts();
  if (!list.length) { toast('nothing to recover', 'info', 2000); return; }
  const there = await Promise.all(list.map((x) => ose.files.exists(x.path).then((v) => !!v, () => true)));
  let items = list.map((x, i) => ({ ...x, there: there[i] }));

  const ov = openOverlay({
    width: 560, className: 'dlg rec', title: 'Unsaved changes were recovered',
    onClose: () => { openOv = null; },
  });
  openOv = ov;

  const paint = () => {
    ov.box.innerHTML = `
      <div class="dlg-head" id="rec-head">Unsaved changes were recovered</div>
      <div class="dlg-body">
        <p class="dlg-text">This text never reached its file, and was kept on this machine. Open a page to get it back: the page shows what it recovered.</p>
        <div class="rec-list">${items.map((x, i) => `
          <button type="button" class="row rec-row${x.there ? '' : ' gone'}" data-i="${i}" title="${esc(x.path)}">
            <span class="rec-name">${esc(baseName(x.path))}</span>
            <span class="grow rec-path mono-sm">${esc(dirName(x.path) || '/')}</span>
            ${x.there ? '' : '<span class="pal-hint gone">file gone · save as…</span>'}
            <span class="pal-hint">${esc(when(x.at))}</span>
          </button>`).join('')}</div>
      </div>
      <div class="dlg-foot">
        <span class="grow mono-sm faint"><span class="kbd">Enter</span> open <span class="kbd">Del</span> discard</span>
        <button class="btn" data-act="close">Close</button>
      </div>`;
    ov.box.setAttribute('aria-labelledby', 'rec-head');
  };
  paint();

  const rows = () => [...ov.box.querySelectorAll('.rec-row')];
  const focusAt = (i) => { const r = rows(); if (r.length) r[Math.max(0, Math.min(i, r.length - 1))].focus(); };

  const act = async (i) => {
    const x = items[i];
    if (!x) return;
    if (!x.there) {
      ov.close();
      await saveAs(x);
      void listDrafts();
      return;
    }
    ov.close();
    await route.navigate({ type: 'page', path: x.path });
  };

  ov.box.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="close"]')) { ov.close(); return; }
    const row = e.target.closest('.rec-row');
    if (row) void act(+row.dataset.i);
  });
  ov.box.addEventListener('keydown', async (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const r = rows();
    const at = r.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusAt(at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + r.length) % r.length);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && at >= 0) {
      e.preventDefault();
      const gone = items[at];
      if (!(await discard(gone))) { focusAt(at); return; }
      items = items.filter((x) => x !== gone);
      known = known.filter((k) => k.path !== gone.path);
      if (!items.length) { ov.close(); return; }
      paint();
      focusAt(at);
    }
  });
  requestAnimationFrame(() => focusAt(0));
}

/**
 * After the boot: the sheet, when there is anything in it. Never throws, and never shows over a
 * dialog that is already up (a prompt the planner opened, say): the command brings it back.
 */
export async function offerRecovered() {
  const list = await listDrafts();
  if (!list.length) return;
  if (overlayCount()) {
    toast(`${list.length} page${list.length === 1 ? ' has' : 's have'} recovered changes`, 'warn', 0, {
      actions: [{ label: 'Show', run: () => commands.run('app.recovered') }],
    });
    return;
  }
  await showRecovered();
}

/** The command, and the count it reads kept current as pages save. */
export function initRecover() {
  commands.register({
    id: 'app.recovered', title: 'Recovered changes…', group: 'app',
    hint: 'text that never reached its file',
    when: () => known.length > 0,
    run: () => showRecovered(),
  });
  // A page that saves drops its draft; the list is asked again a moment later, so the command
  // is not offered for text that is on disk now.
  const refresh = ose.debounce(() => { void listDrafts(); }, 1200);
  bus.on('doc:saved', refresh);
  bus.on('doc:recovered', refresh);
  // And the other way: a save that failed, a conflict held or a page deleted under its text
  // writes a draft and says so only on `doc:state`, and the command is wanted exactly then.
  bus.on('doc:state', (d) => { if (d && d.draft) refresh(); });
}
