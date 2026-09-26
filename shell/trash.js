// Trash: what was moved to the trash from this vault, and the way back (M18).
//
// A view (`{type:'view', name:'trash'}`), reached from the last row of the sidebar and from
// `app.trash`. It lists `ose.fileops.trashList()`: the vault's own `.trash`, and on Windows and
// Linux the items in the system bin whose original path is inside this vault. Each row says
// what it was, where it was, when it went, and where it is now; Restore puts it back where it
// was (`ose.fileops.restore`), recreating a folder that is gone, and never over a file that has
// taken its place. An item that went to `.trash` before the host kept a note of where it was
// (`known: false`) says so, and goes back to the vault root by its name. The header says honestly what is and is not listed: macOS gives no way to
// look into its Trash, so there only the vault's `.trash` can be restored here.
//
// Nothing here deletes anything. Emptying the bin is the platform's, where it has always been.

import { ose } from 'ose:kernel';
import { esc, icon, hasIcon, toast } from 'ose:ui';
import { baseName, dirName, errorOf, vaultName as nameOfVault } from './paths.js';
import { dateLabel, iconName, sizeLabel } from './folder-model.js';
import { undo } from './fileops.js';

const { bus, commands, route } = ose;

export const TRASH = { type: 'view', name: 'trash' };

const ic = (name, fallback) => (hasIcon(name) ? name : fallback);
const vaultName = () => nameOfVault('the vault');

/** Where an item is now, in the platform's own word. */
function whereWord(where) {
  if (where === 'vault') return '.trash in this vault';
  return ose.platform === 'windows' ? 'Recycle Bin' : 'Trash';
}

/**
 * Where an item was is unknown when it went to `.trash` before the host kept a note of it (no
 * sidecar): the host marks it `known: false`, and Restore puts it at the vault root by its name.
 */
const unknownPlace = (it) => it.known === false;

/** The one sentence over the list: what it holds, and on macOS what it cannot. */
function headSentence(items) {
  const count = items.length;
  const back = items.some(unknownPlace)
    ? 'Restore puts each one back where it was; an item whose folder is not known goes back to the vault root.'
    : 'Restore puts each one back where it was.';
  const mac = ose.platform === 'macos';
  if (mac) return `Only items moved to this vault's .trash can be restored here. ${count ? back + ' ' : ''}Items in the macOS Trash are put back from the Trash in Finder.`;
  const bin = ose.platform === 'windows' ? 'the Recycle Bin' : 'the Trash';
  if (!count) return `Nothing from this vault is in ${bin} or in its .trash folder.`;
  return `Items from this vault in ${bin} and in its .trash folder. ${back}`;
}

// The one mounted view, so `trash.restore` from the palette can reach its selection.
let live = null;

/**
 * Mount the trash list into `host`. Answers the view's handle.
 * @param {HTMLElement} host
 */
function mountTrash(host) {
  let items = [];
  let selected = new Set();
  let active = 0;
  let anchor = null;
  let loaded = false;
  let seq = 0;
  const uid = 'tr' + Math.random().toString(36).slice(2, 8);

  host.innerHTML = `
<div class="view-root trash-view" tabindex="-1">
  <div class="page-col">
    <div class="tr-head">
      <h1 class="page-title view-title">Trash</h1>
      <span class="tr-count mono-sm"></span>
    </div>
    <p class="tr-say"></p>
    <div class="tr-tools" role="toolbar" aria-label="Trash">
      <button type="button" class="btn sm tr-restore" disabled>${icon(ic('restore', 'back'))}<span>Restore</span></button>
    </div>
    <div class="tr-cols mono-sm" role="presentation">
      <span>Name</span><span>Was in</span><span>Deleted</span><span>Where it is</span>
    </div>
    <div class="tr-list" role="listbox" aria-label="Items in the trash" aria-multiselectable="true" tabindex="0"></div>
    <div class="tr-note"></div>
  </div>
</div>`;
  const root = host.querySelector('.view-root');
  const listEl = root.querySelector('.tr-list');
  const sayEl = root.querySelector('.tr-say');
  const countEl = root.querySelector('.tr-count');
  const noteEl = root.querySelector('.tr-note');
  const restoreBtn = root.querySelector('.tr-restore');

  function draw() {
    sayEl.textContent = loaded ? headSentence(items) : 'Reading the trash…';
    countEl.textContent = loaded && items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : '';
    root.querySelector('.tr-cols').hidden = !items.length;
    listEl.hidden = !items.length;
    if (active >= items.length) active = Math.max(0, items.length - 1);
    listEl.innerHTML = items.map((it, i) => {
      const was = unknownPlace(it) ? 'Unknown, restores to the vault root' : (dirName(it.original) || vaultName());
      const on = selected.has(it.id);
      const cls = 'tr-row' + (on ? ' selected' : '') + (i === active ? ' active' : '');
      const size = it.kind === 'dir' ? 'folder' : sizeLabel(it.size, 'file');
      return `<div class="${cls}" role="option" id="${uid}-${i}" data-id="${esc(it.id)}" aria-selected="${on}" title="${esc(`${it.original} · ${size}`)}">
        <span class="tr-name">${icon(ic(iconName({ name: it.name, kind: it.kind }), it.kind === 'dir' ? 'folder' : 'file'))}<span class="tr-text">${esc(it.name)}</span></span>
        <span class="tr-was">${esc(was)}</span>
        <span class="tr-when">${esc(dateLabel(Number(it.deletedAt) || 0))}</span>
        <span class="tr-where">${esc(whereWord(it.where))}</span>
      </div>`;
    }).join('');
    if (items.length) listEl.setAttribute('aria-activedescendant', `${uid}-${active}`);
    else listEl.removeAttribute('aria-activedescendant');
    restoreBtn.disabled = !targets().length;
    const n = targets().length;
    restoreBtn.querySelector('span').textContent = n > 1 ? `Restore ${n}` : 'Restore';
    const cur = listEl.querySelector('.tr-row.active');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  /** What Restore acts on: the selection, else the active row. */
  function targets() {
    if (selected.size) return items.filter((it) => selected.has(it.id)).map((it) => it.id);
    return items[active] ? [items[active].id] : [];
  }

  async function load() {
    const my = ++seq;
    let list = [];
    try {
      list = await ose.fileops.trashList();
    } catch (e) {
      const err = errorOf(e);
      noteEl.textContent = `Could not read the trash: ${err.message}`;
      list = [];
    }
    if (my !== seq || !live) return;
    items = (Array.isArray(list) ? list : []).filter((it) => it && it.id)
      .sort((a, b) => (Number(b.deletedAt) || 0) - (Number(a.deletedAt) || 0));
    const ids = new Set(items.map((it) => it.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    loaded = true;
    draw();
  }

  async function restore(ids = targets()) {
    if (!ids.length) return;
    let res;
    try { res = await ose.fileops.restore(ids); } catch (e) {
      toast(`Could not restore: ${errorOf(e).message}`, 'err', 0);
      return;
    }
    const byId = new Map(items.map((it) => [it.id, it]));
    for (const f of (res && res.failed) || []) {
      const it = byId.get(f.id);
      const err = errorOf(f.error);
      const name = it ? it.name : 'An item';
      // Nothing destructive is offered: the file that took its place is somebody's work too.
      if (err.code === 'exists') toast(`${name} was not restored. A file with that name is already there: ${it ? it.original : ''}`, 'err', 0);
      else toast(`${name} was not restored: ${err.message}`, 'err', 0);
    }
    const back = (res && res.restored) || [];
    if (back.length) {
      const first = back[0];
      const label = (res.entry && res.entry.label)
        || (back.length === 1 ? `Restored ${baseName(first.path)} to ${dirName(first.path) || vaultName()}` : `Restored ${back.length} items`);
      const actions = [];
      if (res.entry && res.entry.id && res.entry.undoable !== false) actions.push({ label: 'Undo', run: () => void undo(res.entry.id) });
      if (back.length === 1) actions.push({ label: 'Show', run: () => void route.navigate({ type: 'folder', path: dirName(first.path), select: baseName(first.path) }) });
      toast(label, 'info', 6000, { actions });
      for (const r of back) selected.delete(r.id);
    }
    await load();
  }

  const rowIndex = (node) => {
    const row = node && node.closest ? node.closest('.tr-row') : null;
    return row ? items.findIndex((it) => it.id === row.dataset.id) : -1;
  };

  function selectRange(to) {
    const a = anchor == null ? active : anchor;
    selected = new Set(items.slice(Math.min(a, to), Math.max(a, to) + 1).map((it) => it.id));
  }

  listEl.addEventListener('click', (e) => {
    const i = rowIndex(e.target);
    if (i < 0) return;
    listEl.focus({ preventScroll: true });
    if (e.ctrlKey || e.metaKey) {
      const id = items[i].id;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      anchor = i;
    } else if (e.shiftKey) selectRange(i);
    else { selected = new Set([items[i].id]); anchor = i; }
    active = i;
    draw();
  });
  listEl.addEventListener('dblclick', (e) => {
    const i = rowIndex(e.target);
    if (i >= 0) void restore([items[i].id]);
  });

  listEl.addEventListener('keydown', (e) => {
    if (!items.length) return;
    const k = e.key;
    let next = null;
    if (k === 'ArrowDown') next = Math.min(items.length - 1, active + 1);
    else if (k === 'ArrowUp') next = Math.max(0, active - 1);
    else if (k === 'Home') next = 0;
    else if (k === 'End') next = items.length - 1;
    else if (k === 'Enter') { e.preventDefault(); void restore(); return; }
    else if (k === ' ') {
      e.preventDefault();
      const id = items[active].id;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      anchor = active;
      draw();
      return;
    } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'a') {
      e.preventDefault();
      selected = new Set(items.map((it) => it.id));
      draw();
      return;
    } else if (k === 'Escape' && selected.size) { e.preventDefault(); selected.clear(); draw(); return; }
    else return;
    e.preventDefault();
    if (e.shiftKey) { if (anchor == null) anchor = active; selectRange(next); }
    else if (!(e.ctrlKey || e.metaKey)) { selected = new Set(); anchor = next; }
    active = next;
    draw();
  });

  restoreBtn.addEventListener('click', () => void restore());

  const offs = [
    bus.on('paths:trashed', () => void load()),
    bus.on('paths:restored', () => void load()),
  ];

  const handle = {
    restore: () => restore(),
    hasTargets: () => targets().length > 0,
    focus: () => listEl.focus({ preventScroll: true }),
    refresh: () => void load(),
    unmount() {
      seq++;
      for (const off of offs) { try { off && off(); } catch { /* gone */ } }
      if (live === handle) live = null;
      host.innerHTML = '';
    },
  };
  live = handle;
  draw();
  void load();
  // The list takes the keyboard on arrival, so Up, Down and Enter work at once.
  requestAnimationFrame(() => { if (live === handle) listEl.focus({ preventScroll: true }); });
  return handle;
}

let mounted = null;

const view = {
  title: 'Trash',
  icon: 'trash',
  mount(host) {
    mounted = mountTrash(host);
    return { unmount: view.unmount, refresh: view.refresh };
  },
  refresh() { if (mounted) mounted.refresh(); },
  unmount() { if (mounted) { mounted.unmount(); mounted = null; } },
};

/**
 * Register the Trash view, `app.trash` ("Show trash") and `trash.restore` ("Restore", while the
 * view is open and something is chosen). `boot.js` calls this once, after the file commands.
 */
export function initTrash() {
  ose.views.register('trash', view);
  commands.register({
    id: 'app.trash', title: 'Show trash', group: 'file', icon: 'trash',
    hint: 'what was moved to the trash from this vault',
    run: () => route.navigate(TRASH),
  });
  commands.register({
    id: 'trash.restore', title: 'Restore', group: 'file', icon: ic('restore', 'back'),
    hint: 'put the chosen items back where they were',
    when: () => !!live && live.hasTargets(),
    run: () => (live ? live.restore() : undefined),
  });
}
