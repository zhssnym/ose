// Overlays: the one place a floating surface is created. The palette, settings, context menus
// and the prompt/confirm dialogs all sit on this stack so Esc, click-outside and focus
// restoration behave identically. Nobody in the app calls window.prompt/alert/confirm.
import { esc } from './registry.ts';
import { bridge } from './bridge/index.ts';
import { icon } from './icons.ts';
import { titleOf } from './paths.ts';
import { highlight, pageItems } from './fuzzy.ts';
import { pageList } from './pagehost.ts';

export type Overlay = { el: HTMLDivElement, box: HTMLDivElement, close: () => void, prevFocus: Element | null };

const stack: Overlay[] = [];

/**
 * The element `sel` inside `root`, which the caller has just drawn: one that is not there is a
 * bug in the markup above it, and says so instead of failing later on a null.
 */
export function part<T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T {
  const found = root.querySelector(sel);
  if (!found) throw new Error(`[ui] missing ${sel}`);
  return ((found as unknown) as T);
}

/** The element as an HTMLElement when it is one. */
const html = (n: unknown): HTMLElement | null => (n instanceof HTMLElement ? n : null);

export function overlayCount() { return stack.length; }
export function closeTopOverlay() { stack[stack.length - 1]?.close(); }
/**
 * The element that had focus before any overlay opened, or the active element when none is
 * open. Commands that act on "the focused tree row" ask here: the palette's `when` guards run
 * while the palette input itself holds focus, and the row they should see is the one focus
 * will be handed back to when the palette closes.
 */
export function focusOrigin() {
  return stack[0] ? stack[0].prevFocus : document.activeElement;
}
/**
 * The sidebar rebuilds its rows while a dialog is open (an fs event lands mid-confirm); the
 * node focus would go back to is then detached. It tells us the replacement here (B4).
 */
export function retargetFocusOrigin(el: Element | null) {
  if (stack[0] && el) stack[0].prevFocus = el;
}
export function overlayHasInputFocus() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  const a = html(document.activeElement);
  return !!a && top.el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * openOverlay({ width, top, at:{x,y}, dim, className, title, onClose })
 * Returns { el, box, close }. `box` is the .surface to fill.
 *
 * `title` names the dialog for a screen reader (S40); a caller that draws its own heading can
 * instead set `aria-labelledby` on the box afterwards, which is what settings does. A dimmed
 * overlay is a modal one and says so with `aria-modal`; a menu (dim:false) is not modal and
 * must not claim to be.
 */
export function openOverlay(opts: any = {}) {
  const { width = 420, top = null, at = null, dim = true, className = '', title = '', onClose = null } = opts;

  const prevFocus = document.activeElement;
  const el = document.createElement('div');
  el.className = 'ov' + (dim ? ' ov-dim' : '') + (at ? ' ov-at' : '');

  const box = document.createElement('div');
  box.className = 'surface ov-box ' + className;
  box.setAttribute('role', 'dialog');
  if (dim) box.setAttribute('aria-modal', 'true');
  if (title) box.setAttribute('aria-label', title);
  box.tabIndex = -1;
  if (width) box.style.width = typeof width === 'number' ? width + 'px' : width;
  if (top) box.style.marginTop = '0';
  el.appendChild(box);

  const entry = { el, box, close, prevFocus };
  stack.push(entry);
  document.body.appendChild(el);

  if (at) {
    // Place at a point, flipped back inside the viewport. Transparent rather than hidden until
    // then: a `visibility: hidden` box cannot take the focus, and a menu opened from the
    // keyboard must have it before the first frame (see below).
    box.style.opacity = '0';
    requestAnimationFrame(() => {
      const r = box.getBoundingClientRect();
      const x = Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4));
      const y = Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4));
      box.style.left = x + 'px';
      box.style.top = y + 'px';
      box.style.opacity = '';
    });
  } else if (top) {
    el.style.alignItems = 'flex-start';
    el.style.paddingTop = typeof top === 'number' ? top + 'px' : top;
  }

  el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
  el.addEventListener('contextmenu', (e) => { if (e.target === el) { e.preventDefault(); close(); } });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...box.querySelectorAll(FOCUSABLE)].map(html).filter((n) => n !== null && n.offsetParent !== null);
    const first = items[0], last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // Every `.menu` surface (the context menu today) is a list of `.menu-row` buttons, and a
  // list of buttons is arrow-keyed, not tabbed (D4). Enter and Space are the buttons' own.
  if (/\bmenu\b/.test(className)) bindMenuKeys(box);

  // The keyboard leaves the page the moment an overlay is in the document, not a task later.
  // Keys typed right after a chord that opens a prompt were read by the page behind it while
  // the prompt's input waited for its timer: Ctrl+A and a file name went into the open code
  // editor and autosave wrote them over the file. Input events outrun timers, so nothing
  // deferred is soon enough. The box holds the focus until the caller puts it on its own
  // field (`focusField`), which the dialogs here do in the same task.
  try { box.focus({ preventScroll: true }); } catch { /* a detached body: nothing to guard */ }
  const was = html(prevFocus);
  if (was && was !== document.body && document.activeElement === was) was.blur();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    el.remove();
    try { onClose && onClose(); } catch (e) { console.error(e); }
    // `entry.prevFocus`, not the captured const: retargetFocusOrigin may have swapped it.
    const back = html(entry.prevFocus);
    if (back && back.isConnected) back.focus({ preventScroll: true });
  }

  return entry;
}

/**
 * Put the focus on `el`, a field of the overlay `box`, now: the node is in the document as
 * soon as `openOverlay` answers, and the focus has to be there before the next key is read.
 * `then()` runs after each focus (a prompt selects its text). One more attempt follows after a
 * task, for a window that would not take the focus yet (ADV-N: backgrounded, minimised, a
 * hidden web view); it only acts when the focus is not already on a field of the box, so it
 * never undoes what the user typed or where they tabbed in the meantime.
 */
export function focusField(box: HTMLElement, el: HTMLElement | null, then?: () => void) {
  if (!el) return;
  const go = () => {
    if (!el.isConnected) return;
    try { el.focus({ preventScroll: true }); } catch { return; }
    if (then && document.activeElement === el) { try { then(); } catch (e) { console.error(e); } }
  };
  go();
  setTimeout(() => {
    const a = document.activeElement;
    if (a === el || (a && a !== box && box.contains(a))) return;
    go();
  }, 0);
}

/**
 * The row `sel` an event happened in, or null.
 */
function rowAt(e: Event, sel: string): HTMLElement | null {
  return e.target instanceof Element ? html(e.target.closest(sel)) : null;
}

/**
 * Menu keys: Up/Down wrap, Home/End, and a letter jumps to the next row whose label starts
 * with it (cycling, so pressing it again moves on). Chords are left alone: the shell's window
 * listener has already had them, and anything with a modifier is not a letter jump.
 */
function bindMenuKeys(box: HTMLElement) {
  const rows = (): HTMLElement[] => [...box.querySelectorAll('.menu-row')]
    .map(html)
    .filter((n): n is HTMLElement => n !== null && !((n as HTMLButtonElement)).disabled && n.offsetParent !== null);
  box.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const list = rows();
    if (!list.length) return;
    const at = list.indexOf((document.activeElement as HTMLElement));
    let next = -1;
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % list.length;
    else if (e.key === 'ArrowUp') next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key.length === 1 && e.key !== ' ') {
      const ch = e.key.toLowerCase();
      const starts = (n: HTMLElement | undefined) => !!n && (n.textContent || '').trim().toLowerCase().startsWith(ch);
      for (let i = 1; i <= list.length; i++) {
        const n = (at + i) % list.length;
        if (starts(list[n])) { next = n; break; }
      }
      if (next < 0) return;
    } else return;
    e.preventDefault();
    list[next]?.focus();
  });
}

// Every dialog head gets an id so the box can point `aria-labelledby` at it: the heading a
// sighted user reads first is the name a screen reader announces first (S40).
let headSeq = 0;

function dialogShell(box: HTMLElement, { title, danger }: { title?: string; danger?: boolean; }): { body: HTMLElement; cancel: HTMLElement; ok: HTMLElement; } {
  box.classList.add('dlg');
  const headId = `dlg-head-${++headSeq}`;
  box.setAttribute('aria-labelledby', headId);
  box.innerHTML = `
    <div class="dlg-head" id="${headId}">${esc(title || '')}</div>
    <div class="dlg-body"></div>
    <div class="dlg-foot">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok"></button>
    </div>`;
  return {
    body: part(box, '.dlg-body'),
    cancel: part(box, '[data-act="cancel"]'),
    ok: part(box, '[data-act="ok"]'),
  };
}

/**
 * A one-line question. Answers the trimmed value, or null on cancel or an empty answer.
 * `select: [start, end]` is the input's selection once it has focus (a rename selects the stem
 * and leaves the extension alone); the default is the whole value.
 */
export function prompt({ title = 'Rename', value = '', placeholder = '', ok = 'OK', body = '', select = null }: { title?: string; value?: string; placeholder?: string; ok?: string; body?: string; select?: number[] | null; } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = openOverlay({ width: 420, className: 'dlg-ov', onClose: () => { if (!done) { done = true; resolve(null); } } });
    const parts = dialogShell(ov.box, { title });
    parts.ok.textContent = ok;
    parts.body.innerHTML = (body ? `<p class="dlg-text">${esc(body)}</p>` : '') + `<input class="input" type="text" spellcheck="false">`;
    const input = (part(parts.body, 'input') as HTMLInputElement);
    input.value = value;
    input.placeholder = placeholder;
    parts.ok.addEventListener('click', () => finish(input.value.trim() || null));
    parts.cancel.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); }
    });
    // Now, not after a timer or a frame: the keys typed right after the chord that opened
    // this are the name, and they must land here, not in the page behind (focusField).
    focusField(ov.box, input, () => {
      if (Array.isArray(select) && select.length === 2) {
        const len = input.value.length;
        const a = Math.max(0, Math.min(len, Number(select[0]) || 0));
        const b = Math.max(a, Math.min(len, Number(select[1]) || 0));
        try { input.setSelectionRange(a, b); } catch { input.select(); }
      } else input.select();
    });
  });
}

/**
 * A yes or no question. Answers true for OK, false for Cancel, Esc or a click outside.
 */
export function confirm({ title = 'Are you sure?', body = '', ok = 'OK', danger = false }: { title?: string; body?: string; ok?: string; danger?: boolean; } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = openOverlay({ width: 400, className: 'dlg-ov', onClose: () => { if (!done) { done = true; resolve(false); } } });
    const parts = dialogShell(ov.box, { title, danger });
    parts.ok.textContent = ok;
    parts.body.innerHTML = body ? `<p class="dlg-text">${esc(body)}</p>` : '';
    parts.ok.addEventListener('click', () => finish(true));
    parts.cancel.addEventListener('click', () => finish(false));
    // On the OK button only: on the whole box this fired with Cancel focused too, which
    // turned Enter-to-dismiss into Enter-to-delete.
    parts.ok.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } });
    focusField(ov.box, parts.ok);
  });
}

/**
 * `choose({ title, body, options, cancel })` (docs/CORE.md `ose:ui`): one question, a short
 * list of answers, one of them the default. Resolves to the chosen `value`, or null when the
 * dialog is dismissed. Options are `{ value, label, note?, danger? }` or bare strings.
 *
 * Rows, not a select: the same list every picker in the app draws, so Up and Down walk it and
 * Enter takes the focused row. Nothing here needs the mouse.
 */
export function choose<T = string>({ title = 'Choose', body = '', options = [], cancel = 'Cancel' }: {
  title?: string, body?: string, cancel?: string,
  options?: ({ value: T, label?: string, note?: string, danger?: boolean } | string)[],
} = {}): Promise<T | null> {
  type Item = { value: T | string, label?: string, note?: string, danger?: boolean };
  const items = options.map((o): Item => (typeof o === 'string' ? { value: o, label: o } : o))
    .filter((o) => o && o.value !== undefined);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = openOverlay({ width: 420, className: 'dlg-ov', onClose: () => { if (!done) { done = true; resolve(null); } } });
    ov.box.innerHTML = `
      <div class="dlg-head">${esc(title)}</div>
      <div class="dlg-body">
        ${body ? `<p class="dlg-text">${esc(body)}</p>` : ''}
        <div class="dlg-choices">${items.map((o, i) => `
          <button type="button" class="row choice${o.danger ? ' danger' : ''}" data-i="${i}">
            <span class="grow">${esc(o.label ?? o.value)}</span>
            ${o.note ? `<span class="hint">${esc(o.note)}</span>` : ''}
          </button>`).join('')}</div>
      </div>
      <div class="dlg-foot"><button class="btn" data-act="cancel">${esc(cancel)}</button></div>`;
    const rows = [...ov.box.querySelectorAll('.choice')].map(html).filter((r) => r !== null);
    rows.forEach((r) => r.addEventListener('click', () => { const o = items[Number(r.dataset.i)]; finish(o ? o.value : null); }));
    const cancelBtn = part(ov.box, '[data-act="cancel"]');
    cancelBtn.addEventListener('click', () => finish(null));
    ov.box.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const at = rows.indexOf((document.activeElement as HTMLElement));
      if (at < 0) return;
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    });
    // Synchronously: the box is already in the document, a button needs no layout pass, and a
    // frame callback never runs in a background tab — which would leave the dialog up with
    // nothing focused and Up/Down doing nothing at all.
    (rows[0] || cancelBtn).focus();
  });
}

/* ------------------------------------------------------------------ folder picker */

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
function pickPath({ title, all, current, iconName, mode, enterLabel, rootLabel, empty }) {
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
        <span><span class="kbd">↑</span><span class="kbd">↓</span> move</span>
        <span><span class="kbd">Enter</span> ${esc(enterLabel)}</span>
        <span><span class="kbd">Esc</span> cancel</span>
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
export async function pickFolder({ title = 'Move to…', current = null, hide = null, enterLabel = 'choose' }: { title?: string; current?: string | null; hide?: string | null; enterLabel?: string; } = {}): Promise<string | null> {
  const all = (await vaultFolders()).filter((p) => !hide || (p !== hide && !p.startsWith(hide + '/')));
  return pickPath({
    // Only the caller knows what Enter does here: moving a file is a move, naming the folder the
    // planner reads is a choice, and the foot used to say "move here" for both.
    title, all, current,
    iconName: 'folder', mode: 'folders', enterLabel,
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
    enterLabel: 'choose', rootLabel: 'vault root', empty: 'no file matches',
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
        <span><span class="kbd">↑</span><span class="kbd">↓</span> move</span>
        <span><span class="kbd">Enter</span> link</span>
        <span><span class="kbd">Esc</span> cancel</span>
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

/* ------------------------------------------------------------------ clipboard */

/**
 * Put text on the clipboard. `navigator.clipboard` needs a secure context, which both the dev
 * server (127.0.0.1) and the host give us; the textarea fallback is there so a copy never
 * silently does nothing. Resolves true when the text went somewhere.
 */
export async function copyText(text) {
  const s = String(text ?? '');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* fall through to the old way */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (e) {
    console.error('[shell] copy', e);
    return false;
  }
}

/**
 * Context menu: items are {label, iconSvg?, shortcut?, danger?, sep?, run()}. Arrow keys,
 * Home/End and letter jumps come from openOverlay's `.menu` handling; Esc from the shell.
 */
export function contextMenu(x, y, items) {
  const ov = openOverlay({ at: { x, y }, dim: false, width: null, className: 'menu' });
  ov.box.setAttribute('role', 'menu');
  const frag = document.createDocumentFragment();
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { const d = document.createElement('div'); d.className = 'divider'; frag.appendChild(d); continue; }
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute('role', 'menuitem');
    row.className = 'row menu-row' + (it.danger ? ' danger' : '');
    row.innerHTML = `${it.iconSvg || ''}<span class="grow">${esc(it.label)}</span>`
      + (it.shortcut ? `<span class="kbd">${esc(it.shortcut)}</span>` : '');
    row.addEventListener('click', () => { ov.close(); Promise.resolve().then(() => it.run && it.run()); });
    frag.appendChild(row);
  }
  ov.box.appendChild(frag);
  // Now, for the reason `prompt` gives above: a menu opened from a keyboard gesture must take
  // the focus before the next key, painted or not.
  focusField(ov.box, ov.box.querySelector('.menu-row'));
  return ov;
}

/* ------------------------------------------------------------------ toasts */

// Newest last in the DOM, so `dismissToast` pops the last child. The host is a live region:
// a screen reader hears a save error the way a sighted user sees it (D10).
let toastHost: HTMLDivElement | null = null;

/** Each toast's kill, and whether it is sticky, for `dismissToast`. */
const toastState: WeakMap<Element, { kill: () => void; sticky: boolean; }> = new WeakMap();

/**
 * A message above the status bar (docs/CORE.md `ose.toast`, H8). Errors surface here instead
 * of being swallowed. Answers the kill function.
 *
 * - `ms` is how long it stays. `0` is sticky: no timer, a click on the text does nothing, and
 *   the toast carries a close button; it goes when that button, an action or the caller's kill
 *   says so. A save that failed must not be a message that vanished before it was read.
 * - `opts.actions`: `[{ label, run }]`, drawn as buttons, reachable with Tab. Running one
 *   closes the toast; `run` may return a promise and its failure is logged, not thrown.
 * - `kind === 'err'` gives the toast `role="alert"`, so a screen reader interrupts for it.
 */
export function toast(text: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info', ms: number = 4500, opts: { actions?: Array<{ label: string; run: () => any; }>; } = {}): () => void {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  const sticky = !(ms > 0);
  const actions = opts && Array.isArray(opts.actions) ? opts.actions.filter((a) => a && a.label && typeof a.run === 'function') : [];
  const t = document.createElement('div');
  t.className = 'toast surface ' + kind + (sticky ? ' sticky' : '') + (actions.length ? ' has-actions' : '');
  if (kind === 'err') t.setAttribute('role', 'alert');
  const line = document.createElement('span');
  line.className = 'toast-text';
  line.textContent = String(text);
  t.appendChild(line);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    clearTimeout(timer);
    t.remove();
    if (toastHost && !toastHost.childElementCount) { toastHost.remove(); toastHost = null; }
  };
  toastState.set(t, { kill, sticky });
  if (actions.length || sticky) {
    const row = document.createElement('span');
    row.className = 'toast-actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn toast-act';
      b.textContent = String(a.label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        kill();
        try { Promise.resolve(a.run()).catch((err) => console.error('[toast] action', a.label, err)); }
        catch (err) { console.error('[toast] action', a.label, err); }
      });
      row.appendChild(b);
    }
    if (sticky) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'btn ghost toast-close';
      x.setAttribute('aria-label', 'Dismiss');
      x.title = 'Dismiss';
      x.textContent = '×';
      x.addEventListener('click', (e) => { e.stopPropagation(); kill(); });
      row.appendChild(x);
    }
    t.appendChild(row);
  }
  toastHost.appendChild(t);
  if (sticky) return kill;
  // Hovering pauses the clock: a message being read must not vanish under the pointer. On
  // leave it gets what was left, and never less than a second to finish the line. A toast
  // with actions is not killed by a click on its text: the click may be aiming at a button.
  timer = setTimeout(kill, ms);
  let left = ms, since = Date.now();
  t.addEventListener('mouseenter', () => { clearTimeout(timer); left = Math.max(0, left - (Date.now() - since)); });
  t.addEventListener('mouseleave', () => { since = Date.now(); timer = setTimeout(kill, Math.max(1000, left)); });
  t.addEventListener('focusin', () => { clearTimeout(timer); });
  if (!actions.length) t.addEventListener('click', kill);
  return kill;
}

/** Esc with no overlay open (keys.ts): drop the newest toast. True when there was one. */
export function dismissToast() {
  // A sticky toast is not Esc's to take: Esc also reaches the editor's block selection, and a
  // "not saved" notice must not go with a keystroke meant for something else. Its own close
  // button, or its action, is the way.
  const all = toastHost ? [...toastHost.children] : [];
  const t = all.reverse().map((n) => toastState.get(n)).find((s) => s && !s.sticky);
  if (!t) return false;
  t.kill();
  return true;
}
