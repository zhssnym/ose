// The small pieces every planner view repeats: the `‹ Today ›` group and its keys, the quiet
// line a view draws when a path is not chosen, and the clicks on a path or on "Choose…".
// DOM and listeners only; nothing here reads or writes the vault.

import { esc } from 'ose:ui';

/**
 * The period navigation, laid out by `.v-nav`: the key hint in mono, then the three buttons.
 * They carry `data-nav` so `bindNav` drives them without ids; `unit` names the period for the
 * screen reader ("Previous day").
 * @returns HTML
 */
export function navHtml(unit: string): string {
  return `<div class="v-nav">
    <span class="v-keys mono-sm" aria-hidden="true">&larr; &rarr; &middot; t</span>
    <button type="button" class="btn sm" data-nav="prev" aria-label="Previous ${esc(unit)}">&lsaquo;</button>
    <button type="button" class="btn sm" data-nav="today">Today</button>
    <button type="button" class="btn sm" data-nav="next" aria-label="Next ${esc(unit)}">&rsaquo;</button>
  </div>`;
}

/** A key pressed while writing belongs to the field, never to the view. */
function inField(t) {
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}

/**
 * Wire one view's period navigation: clicks on `[data-nav]` inside `root`, and ArrowLeft /
 * ArrowRight / t while focus is in `root` and not in a text field. Keys with a modifier are left
 * alone so the shell's map (Alt+Left is back) is never shadowed.
 * @returns removes both listeners
 */
export function bindNav(root: HTMLElement, { prev, next, today }: { prev: Function; next: Function; today: Function; }): () => void {
  const onClick = (ev) => {
    const b = ev.target.closest('[data-nav]');
    if (!b || !root.contains(b)) return;
    if (b.dataset.nav === 'prev') prev();
    else if (b.dataset.nav === 'next') next();
    else if (b.dataset.nav === 'today') today();
  };
  const onKey = (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
    if (inField(ev.target)) return;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); prev(); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); next(); }
    else if (ev.key === 't' || ev.key === 'T') { ev.preventDefault(); today(); }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKey);
  };
}

const WHAT = {
  calendar: 'No calendar file chosen.',
  todo: 'No todo file chosen.',
  reports: 'No reports folder chosen.',
  journal: 'No journal folder chosen.',
};

/**
 * The one quiet line a view draws where a path is missing (9.2), never a red box: what is
 * missing, then "Choose… in Settings › Planner" as a button.
 * @returns HTML
 */
export function missingHtml(key: 'calendar' | 'todo' | 'reports' | 'journal'): string {
  return `<div class="pl-quiet">${esc(WHAT[key] || 'Nothing chosen.')} <button type="button" class="v-link pl-choose" data-planner-settings>Choose…</button> in Settings › Planner</div>`;
}

/**
 * The line for a path that is chosen but has nothing on disk.
 * @returns HTML
 */
export function goneHtml(path: string): string {
  return `<div class="pl-quiet">Nothing at <span class="mono-sm">${esc(path)}</span>. <button type="button" class="v-link pl-choose" data-planner-settings>Choose…</button> in Settings › Planner</div>`;
}

/**
 * While the paths are the detected ones and nobody has confirmed them: one quiet line.
 * @returns HTML
 */
export function detectedHtml(): string {
  return `<div class="pl-quiet pl-detected">These paths were found automatically. <button type="button" class="v-link pl-choose" data-planner-settings>Check them</button> in Settings › Planner</div>`;
}

/**
 * Open Settings › Planner, in a tab of its own (a tab already on Settings is reused).
 */
export function openPlannerSettings(ose: typeof import('ose:core').ose): Promise<unknown> {
  return ose.tabs.open({ type: 'view', name: 'settings', arg: 'planner' });
}

/**
 * The clicks every view shares: a `.v-link[data-path]` opens that file (at `data-line` when it
 * has one), Ctrl or middle click in a new tab, and `[data-planner-settings]` opens the settings.
 * @returns removes the listeners
 */
export function bindLinks(root: HTMLElement, ose: any): () => void {
  const open = (ev, newTab) => {
    if (ev.target.closest('[data-planner-settings]')) { ev.preventDefault(); openPlannerSettings(ose); return true; }
    const link = ev.target.closest('[data-path]');
    if (!link || !root.contains(link) || !link.dataset.path || link.hasAttribute('data-toggle')) return false;
    if (!link.classList.contains('v-link') && !link.classList.contains('tk-src') && !link.classList.contains('dy-grp-head')) return false;
    ev.preventDefault();
    const route: { type: string, path: string, line?: number } = { type: 'page', path: link.dataset.path };
    if (link.dataset.line) route.line = Number(link.dataset.line);
    if (newTab) ose.tabs.open(route, { reuse: false });
    else ose.route.navigate(route);
    return true;
  };
  const onClick = (ev) => { open(ev, ev.ctrlKey || ev.metaKey); };
  const onAux = (ev) => { if (ev.button === 1) open(ev, true); };
  root.addEventListener('click', onClick);
  root.addEventListener('auxclick', onAux);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('auxclick', onAux);
  };
}

/**
 * The display name of a vault path (`ose.names.display`: the real name, `.md` hidden only with
 * the setting).
 */
export function displayName(ose: typeof import('ose:core').ose, path: string): string {
  return ose.names.display(path);
}
