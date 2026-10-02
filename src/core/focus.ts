// Focus mode: the whole app narrowed to one folder. The tree is rooted there, new pages land
// inside it, Ctrl+P and Ctrl+F only see paths under it, and the address bar starts at it.
//
// It used to be a trap (H18): a click entered it, it came back after a restart, Esc did not
// leave it, and nothing outside the sidebar said the app was narrowed, so quick open answered
// "no matches" for a page that was right there. Now:
// - it is entered only on purpose (the command, or the tree's own gesture), and it lasts for
//   the session: it is never restored at boot, and a focus left in the vault's state by an
//   older build is dropped;
// - it is said in one place only, the sidebar's heading (`Focus <folder> ×`), and left there
//   with its ×, or with `app.focus-exit` from the tree's menu or the palette. No key leaves it.
//   The bus says `focus` on every change for whoever draws it.
//
// Store key `focus` (a vault-relative folder path, or null).
import { bus, store, commands, status } from './registry.ts';
import { patchState, stateCache } from './state.ts';
import { clean, baseName, dirName, isOutside } from './paths.ts';

let focus: string | null = null;

/** The focused folder, or null. */
export function getFocus() { return focus; }

/**
 * Where a new file goes when the caller names no folder: the focused folder, else the folder of
 * what is on screen (a folder route's own path, a page's folder), else the vault root ''. The
 * scratch folder is gone (W2): a new file lands where the user is, and a folder is one keystroke.
 * Always a vault-relative folder path or '', so `join(defaultNewFolder(), name)` works.
 */
export function defaultNewFolder() {
  if (focus) return focus;
  const route = store.get('route');
  if (route && route.type === 'folder' && typeof route.path === 'string') return clean(route.path);
  // A file outside the vault (X7) has no folder in it: a new file goes to the root.
  if (route && route.type === 'page' && route.path && !isOutside(route.path)) return dirName(route.path);
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

/** Nothing in the status bar: the sidebar's heading says it. Clears what an older build set. */
function publish() {
  status.clear('focus');
}

/**
 * Narrow the app to `path`, or leave focus with a falsy one. For this session only: nothing
 * is written to the state file.
 */
export function setFocus(path) {
  const next = path ? clean(path) : null;
  if (next === focus) return;
  focus = next;
  store.set('focus', focus);
  publish();
  bus.emit('focus', focus);
}

export function exitFocus() { setFocus(null); }

/**
 * Called at boot, before anything reads the store. The app always opens unfocused (H18): a
 * focus saved by an older build is dropped from the state file, not applied.
 */
export function loadFocus(state) {
  const s = state === undefined ? stateCache() : state;
  if (s && typeof s === 'object' && s.focus !== undefined) patchState({ focus: undefined });
  focus = null;
  store.set('focus', focus);
  publish();
  return focus;
}

export function initFocus() {
  // `icon` is what the sidebar's context menu draws next to it (D3); `app.focus-enter`, its
  // opposite, is registered by the sidebar because it needs the focused row.
  commands.register({
    id: 'app.focus-exit', title: 'Exit focus', group: 'app', icon: 'focus',
    hint: 'or the × on the sidebar heading',
    when: () => !!focus,
    run: () => exitFocus(),
  });
}
