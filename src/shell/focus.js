// Focus mode: the whole app narrowed to one folder. The pages section is rooted there, pinned
// and scratch disappear, new pages land inside it, Ctrl+P and Ctrl+F only see paths under it,
// and the breadcrumb starts at it (CONTRACT.md batch 4).
//
// State key `focus` (a vault-relative folder path, or null) and store key `focus`. Esc never
// leaves it: only the `exit` control in the sidebar or the command `app.focus-exit`.
import { bus, store, commands } from '../registry.js';
import { patchState, stateCache } from './state.js';
import { clean, baseName, dirName } from './paths.js';
import { newPageMode } from './settings.js';
import { getSource } from '../lib/sources.js';

let focus = null;

/** The focused folder, or null. */
export function getFocus() { return focus; }

/**
 * Where a new page goes (S34). A focused folder always wins: focus mode means the app is
 * narrowed to that folder, and creating outside it would be a surprise. Otherwise the setting
 * decides: `focus` is what the app has always done (nothing here, so `page.new` falls through
 * to the open page's folder and then the scratch source), `scratch` names the scratch folder
 * outright, `page` names the folder of the page on screen.
 *
 * Always a vault-relative folder path or '' (the vault root), so `join(defaultNewFolder(),
 * name)` works whatever the answer is.
 */
export function defaultNewFolder() {
  if (focus) return focus;
  const mode = newPageMode();
  if (mode === 'scratch') return clean(getSource('scratch')) || '';
  if (mode === 'page') {
    const route = store.get('route');
    if (route && route.type === 'page' && route.path) return dirName(route.path);
  }
  return '';
}

/** True when nothing is focused, or when `path` is the focus folder or inside it. */
export function isUnderFocus(path) {
  if (!focus) return true;
  const p = clean(path);
  return p === focus || p.startsWith(focus + '/');
}

/** `Learning/School/3-philosophie` -> `3-philosophie`. Used by the breadcrumb and menus. */
export function focusName() { return focus ? baseName(focus) : ''; }

export function setFocus(path) {
  const next = path ? clean(path) : null;
  if (next === focus) return;
  focus = next;
  store.set('focus', focus);
  patchState({ focus: focus || undefined });
  bus.emit('focus', focus);
}

export function exitFocus() { setFocus(null); }

/** Called by initShell before any module reads the store. */
export function loadFocus(state) {
  const s = state === undefined ? stateCache() : state;
  const saved = s && typeof s === 'object' ? s.focus : null;
  focus = typeof saved === 'string' && clean(saved) ? clean(saved) : null;
  store.set('focus', focus);
  return focus;
}

export function initFocus() {
  // `icon` is what the sidebar's context menu draws next to it (D3); `app.focus-enter`, its
  // opposite, is registered by the sidebar because it needs the focused row.
  commands.register({
    id: 'app.focus-exit', title: 'Exit focus', group: 'app', icon: 'focus',
    when: () => !!focus,
    run: () => exitFocus(),
  });
}
