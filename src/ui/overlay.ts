// Overlays: the one place a floating surface is created. The palette, settings, context menus
// and the prompt/confirm dialogs all sit on this stack so Esc, click-outside and focus
// restoration behave identically. Nobody in the app calls window.prompt/alert/confirm.
import { esc } from './html.ts';

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
export function rowAt(e: Event, sel: string): HTMLElement | null {
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
 * `choose({ title, body, options, cancel })` (docs/CORE.md, the kit): one question, a short
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
    // No chord on the row: the shortcuts are listed in Settings › Keys, and nowhere else.
    row.innerHTML = `${it.iconSvg || ''}<span class="grow">${esc(it.label)}</span>`;
    row.addEventListener('click', () => { ov.close(); Promise.resolve().then(() => it.run && it.run()); });
    frag.appendChild(row);
  }
  ov.box.appendChild(frag);
  // Now, for the reason `prompt` gives above: a menu opened from a keyboard gesture must take
  // the focus before the next key, painted or not.
  focusField(ov.box, ov.box.querySelector('.menu-row'));
  return ov;
}
