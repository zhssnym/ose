// Toasts: one line above the status bar, newest last, for news the user should see.
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
