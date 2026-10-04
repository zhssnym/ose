// The dialogs the editor asks for, and the two state calls, over the kit (src/ui) and the
// core (`ose.state`) through `host.ts`.
//
// The editor once loaded the shell's dialogs lazily and carried a fallback implementation of
// every one of them, because the shell shipped separately and might not have been there. The
// dialogs are the kit's now (src/ui): they are part of what a page editor is handed, like
// the file system, so they are imported statically and there is nothing to fall back to.
// What is left here is `choose`, which the kit does not have in that shape, and
// the two thin state helpers.

import { confirm, openOverlay, patchState as hostPatchState, pickPage as hostPickPage, prompt, stateCache, toast } from './host.ts';

export { prompt, confirm, toast, openOverlay };

/** pickPage({title}) -> Promise<path|null>: the quick-open list, fuzzy, Enter. */
export function pickPage(opts) {
  return hostPickPage({ ...(opts || {}), title: (opts && opts.title) || 'Link to page…' });
}

/**
 * A choice between more than two actions. `confirm` is two-way and its cancel button reads
 * "Cancel", so a question like "reload the file or overwrite it" cannot be asked honestly on
 * it: whichever meaning went on Cancel would be a trap. This builds the same `.dlg`
 * shell on the overlay stack, so Esc, click-outside and focus return behave like every other
 * dialog.
 *
 * choose({title, body?, options:[{label, value, kind?:'primary'|'danger'}], cancel?})
 *   -> Promise<value>   Esc or a click outside resolves to `cancel` (null by default).
 * Put the safest option first: it gets the initial focus.
 */
export function choose<T>({ title = '', body = '', options = [], cancel = null }: { title?: string; body?: string; options?: { label: string; value: T; kind?: string; }[]; cancel?: T | null; } = {}): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); ov.close(); };
    const ov = openOverlay({
      // The head below says the same thing on screen; `title` is what a screen reader is told
      // the dialog is called: without it a dialog is announced as just "dialog".
      width: 460, className: 'dlg-ov', title,
      onClose: () => { if (!done) { done = true; resolve(cancel); } },
    });
    const box = ov.box;
    box.classList.add('dlg');
    const head = document.createElement('div');
    head.className = 'dlg-head label';
    head.textContent = title;
    const bodyEl = document.createElement('div');
    bodyEl.className = 'dlg-body';
    if (body) {
      const p = document.createElement('p');
      p.className = 'dlg-text';
      p.textContent = body;
      bodyEl.append(p);
    }
    const foot = document.createElement('div');
    foot.className = 'dlg-foot';
    for (const o of options) {
      const b = document.createElement('button');
      b.className = 'btn' + (o.kind ? ' ' + o.kind : '');
      b.textContent = o.label;
      b.addEventListener('click', () => finish(o.value));
      foot.append(b);
    }
    box.append(head, bodyEl, foot);
    requestAnimationFrame(() => { const first = (foot.querySelector('.btn') as HTMLElement | null); if (first) first.focus(); });
  });
}

/** patchState(partial) -> Promise<void>. Merged shallow at the top level. */
export async function patchState(partial) {
  return hostPatchState(partial);
}

/** The loaded vault state (`ose.state`), read-only. `{}` until the core has loaded it. */
export async function readState() {
  const c = stateCache();
  return c && typeof c === 'object' ? c : {};
}
