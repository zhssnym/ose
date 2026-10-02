// The vault pickers: Move to… (a folder), Choose a file…, Link a page…, and the title a link
// carries. Built on the overlay stack of src/ui; they read the vault through the bridge, which is
// why they are the core's and not bricks of the kit.
import { esc } from '../ui/html.ts';
import { icon } from '../ui/icons.ts';
import { highlight } from '../ui/fuzzy.ts';
import { openOverlay, focusField, part, rowAt } from '../ui/overlay.ts';
import { bridge } from './bridge/index.ts';
import { titleOf } from './paths.ts';
import { pageItems } from './page-items.ts';
import { pageList } from './pagehost.ts';

// A local subsequence matcher so this file stays free of a palette import (palette.js
// imports this one). Same idea, fewer bonuses: enough to rank a path list.
function fuzzyPath(text, q) {
  if (!q) return 0;
  const t = text.toLowerCase();
  let ti = 0, score = 0;
  for (let i = 0; i < q.length; i++) {
    const at = t.indexOf(q[i], ti);
    if (at < 0) return null;
    score += at === ti ? 6 : 2;
    if (at === 0 || /[\s/\\._-]/.test(t[at - 1])) score += 4;
    ti = at + 1;
  }
  return score - text.length * 0.05;
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'accent' });

/** Every folder in the vault, root first, as vault-relative paths ('' is the root). */
async function vaultFolders() {
  const out = [''];
  let tree: import('./bridge/commands.ts').Entry_Serialize | null = null;
  try { tree = await bridge.tree(); } catch { return out; }
  const walk = (n) => {
    if (!n || !n.children) return;
    const dirs = n.children.filter((c) => c.kind === 'dir' && !c.hidden);
    dirs.sort(byName);
    for (const d of dirs) { out.push(d.path); walk(d); }
  };
  walk(tree);
  return out;
}

/** Every file in the vault, folder by folder, limited to `exts` (lowercase, no dot). */
async function vaultFiles(exts) {
  const out: any[] = [];
  let tree: import('./bridge/commands.ts').Entry_Serialize | null = null;
  try { tree = await bridge.tree(); } catch { return out; }
  const ok = (name) => {
    if (!exts || !exts.length) return true;
    const i = name.lastIndexOf('.');
    return i > 0 && exts.includes(name.slice(i + 1).toLowerCase());
  };
  const walk = (n) => {
    if (!n || !n.children) return;
    const kids = n.children.filter((c) => !c.hidden);
    const files = kids.filter((c) => c.kind === 'file' && ok(c.name)).sort(byName);
    const dirs = kids.filter((c) => c.kind === 'dir').sort(byName);
    for (const f of files) out.push(f.path);
    for (const d of dirs) walk(d);
  };
  walk(tree);
  return out;
}

/**
 * The picker both pickFolder and pickFile are: a `.surface` list of vault paths, fuzzy-filtered,
 * arrows to move, Enter to confirm, Esc to cancel. Resolves to a vault-relative path or `null`,
 * so callers must test `=== null`, not falsiness (the vault root is the empty string).
 */
function pickPath({ title, all, current, iconName, mode, rootLabel, empty }) {
  return new Promise<any>((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = openOverlay({ width: 560, top: '15vh', className: 'pal pick', title, onClose: () => { if (!done) { done = true; resolve(null); } } });
    ov.box.innerHTML = `
      <div class="pal-head">
        <span class="pal-icon">${icon(iconName)}</span>
        <input class="pal-input" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(title)}" aria-label="${esc(title)}">
      </div>
      <div class="pal-list" role="listbox"></div>
      <div class="pal-foot mono-sm">
        <span class="grow"></span>
        <span class="pal-mode">${esc(mode)}</span>
      </div>`;

    const input = (part(ov.box, '.pal-input') as HTMLInputElement);
    const list = part(ov.box, '.pal-list');
    let items = all;
    let sel = 0;

    function build() {
      const q = input.value.trim().toLowerCase();
      if (!q) items = all;
      else {
        items = all
          .map((p) => ({ p, s: fuzzyPath(p || rootLabel, q) }))
          .filter((x) => x.s !== null)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.p);
      }
      sel = Math.max(0, items.indexOf(current) >= 0 && !q ? items.indexOf(current) : 0);
      paint();
    }

    function paint() {
      list.textContent = '';
      if (!items.length) { list.innerHTML = `<div class="empty">${esc(empty)}</div>`; return; }
      const frag = document.createDocumentFragment();
      items.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'row pal-row' + (i === sel ? ' active' : '');
        row.dataset.i = String(i);
        row.setAttribute('role', 'option');
        // No glyph per row: the head's icon already says what kind of thing is listed, and the
        // page picker and Ctrl+P draw their rows without one (E13).
        row.innerHTML = `<span class="grow">${esc(p || rootLabel)}</span>`
          + (p === current ? '<span class="pal-hint">current</span>' : '');
        frag.appendChild(row);
      });
      list.appendChild(frag);
      list.querySelector('.pal-row.active')?.scrollIntoView({ block: 'nearest' });
    }

    function move(d) {
      if (!items.length) return;
      sel = (sel + d + items.length) % items.length;
      paint();
    }

    input.addEventListener('input', build);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); const p = items[sel]; if (p !== undefined) finish(p); }
    });
    list.addEventListener('click', (e) => {
      const row = rowAt(e, '.pal-row');
      if (!row) return;
      const p = items[Number(row.dataset.i)];
      if (p !== undefined) finish(p);
    });
    list.addEventListener('mousemove', (e) => {
      const row = rowAt(e, '.pal-row');
      if (!row || Number(row.dataset.i) === sel) return;
      sel = Number(row.dataset.i);
      list.querySelectorAll('.pal-row').forEach((n, i) => n.classList.toggle('active', i === sel));
    });

    build();
    focusField(ov.box, input);
  });
}

/**
 * Folder picker (move to…, and the `plans` source). Resolves to a vault-relative path, `''`
 * for the vault root, or `null` when cancelled. `hide` drops a subtree from the list so a
 * folder cannot be moved into itself.
 */
export async function pickFolder({ title = 'Move to…', current = null, hide = null }: { title?: string; current?: string | null; hide?: string | null; enterLabel?: string; } = {}): Promise<string | null> {
  const all = (await vaultFolders()).filter((p) => !hide || (p !== hide && !p.startsWith(hide + '/')));
  return pickPath({
    // Only the caller knows what Enter does here: moving a file is a move, naming the folder the
    // planner reads is a choice, and the foot used to say "move here" for both.
    title, all, current,
    iconName: 'folder', mode: 'folders',
    rootLabel: 'vault root', empty: 'no folder matches',
  });
}

/**
 * File picker: the same surface, listing files. `ext` limits it and takes 'md', '.jsonl',
 * 'md,txt' or an array of those. Resolves to a vault-relative path or `null`.
 */
export async function pickFile({ title = 'Choose a file…', ext = null, current = null }: { title?: string; ext?: string | string[] | null; current?: string | null; } = {}): Promise<string | null> {
  const exts = (Array.isArray(ext) ? ext : String(ext ?? '').split(','))
    .map((e) => String(e).trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  const all = await vaultFiles(exts);
  return pickPath({
    title, all, current,
    iconName: 'page', mode: exts.length ? exts.map((e) => '.' + e).join(' ') : 'files',
    rootLabel: 'vault root', empty: 'no file matches',
  });
}

/* -------------------------------------------------------------------- page picker */

// The recent list belongs to the router, which imports this file: a dynamic import at call
// time keeps the module graph acyclic and costs nothing, since by the time anybody picks a
// page the router is long since evaluated. The page list belongs to whatever draws the tree
// (the stock sidebar, which narrows it to the focused folder) and reaches the core through
// `setPageList`; with nothing registered the vault is walked instead.
async function quickOpenData() {
  const router = await import('./router.ts');
  let recent: string[] = [];
  try { recent = router.recentFiles(); } catch { /* no history yet */ }
  const provider = pageList();
  let paths: string[] = [];
  try { paths = provider ? [...(await provider())] : await vaultFiles(['md']); } catch (e) { console.error('[ui] page list', e); }
  return { paths, recent };
}

/**
 * Pick a markdown page: the quick-open list, the quick-open matcher, Enter to confirm.
 * Resolves to the vault-relative path of the page, or `null` when cancelled.
 * Used by the editor's `Link` slash item and the `page.link` command.
 */
export async function pickPage({ title = 'Link a page…', current = null } = {}) {
  const { paths, recent } = await quickOpenData();
  return new Promise<any>((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = openOverlay({ width: 560, top: '15vh', className: 'pal pick', title, onClose: () => { if (!done) { done = true; resolve(null); } } });
    ov.box.innerHTML = `
      <div class="pal-head">
        <span class="pal-icon">${icon('page')}</span>
        <input class="pal-input" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(title)}" aria-label="${esc(title)}">
      </div>
      <div class="pal-list" role="listbox"></div>
      <div class="pal-foot mono-sm">
        <span class="grow"></span>
        <span class="pal-mode">pages</span>
      </div>`;

    const input = (part(ov.box, '.pal-input') as HTMLInputElement);
    const list = part(ov.box, '.pal-list');
    let items: ReturnType<typeof pageItems> = [];
    let sel = 0;

    function build() {
      const q = input.value.trim();
      items = pageItems(paths, q, { recent });
      const at = current ? items.findIndex((it) => it.path === current) : -1;
      sel = !q && at > 0 ? at : 0;
      paint();
    }

    function paint() {
      list.textContent = '';
      if (!items.length) { list.innerHTML = '<div class="empty">no page matches</div>'; return; }
      const frag = document.createDocumentFragment();
      items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'row pal-row' + (i === sel ? ' active' : '');
        row.dataset.i = String(i);
        row.setAttribute('role', 'option');
        row.innerHTML = `<span class="grow">${highlight(it.title, it.hits)}</span>`
          + (it.hint ? `<span class="pal-hint">${esc(it.hint)}</span>` : '')
          + (it.path === current ? '<span class="pal-hint">current</span>' : '');
        frag.appendChild(row);
      });
      list.appendChild(frag);
      list.querySelector('.pal-row.active')?.scrollIntoView({ block: 'nearest' });
    }

    function move(d) {
      if (!items.length) return;
      sel = (sel + d + items.length) % items.length;
      paint();
    }

    input.addEventListener('input', build);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); const it = items[sel]; if (it) finish(it.path); }
    });
    list.addEventListener('click', (e) => {
      const row = rowAt(e, '.pal-row');
      if (!row) return;
      const it = items[Number(row.dataset.i)];
      if (it) finish(it.path);
    });
    list.addEventListener('mousemove', (e) => {
      const row = rowAt(e, '.pal-row');
      if (!row || Number(row.dataset.i) === sel) return;
      sel = Number(row.dataset.i);
      list.querySelectorAll('.pal-row').forEach((n, i) => n.classList.toggle('active', i === sel));
    });

    build();
    focusField(ov.box, input);
  });
}

/**
 * The title a link to `path` should carry: the file's first H1, else the file name.
 * One read, no cache: it is called once per inserted link. Never throws — a file that cannot
 * be read falls back to its name, which is what the old behaviour was anyway.
 */
export async function pageTitle(path) {
  const fallback = titleOf(path);
  if (!path) return fallback;
  try {
    let text = await bridge.readText(path);
    if (typeof text !== 'string') return fallback;
    // YAML frontmatter is not content; an H1 inside it would not be one.
    if (/^---\r?\n/.test(text)) {
      const end = text.search(/\r?\n---[ \t]*(\r?\n|$)/);
      if (end >= 0) text = text.slice(text.indexOf('\n', end + 1) + 1);
    }
    const m = text.match(/^[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/m);
    const h1 = m && m[1] ? m[1].trim() : '';
    return h1 || fallback;
  } catch {
    return fallback;
  }
}

