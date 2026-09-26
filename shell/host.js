// What the shell needs to know about the window it is drawn in: is this a real window or a
// browser tab, and the one window hose left (a vault a second launch asked for). The window's
// frame, its buttons, moving and resizing it are the platform's own (X9): nothing here draws
// or drives them any more.
//
// One file knows; everybody else calls it.

import { ose } from 'ose:kernel';

/** A real window (the Tauri host or a web view) rather than a browser tab. */
export const isHost = () => ose.host !== 'browser';

/** What the status bar and the settings dialog print for "who is answering". */
export const hostKind = () => ose.host;

/**
 * A second launch named another folder (docs/HOST.md "Single instance"). The host does not
 * adopt it on its own: it asks, with `{root, name}`, and the shell switches the way Change
 * vault does, after the open page has been saved (C5). Kept until windows per vault (X6, gate
 * G3) take over, when a second launch opens a window of its own and the host stops asking; a
 * kernel that has dropped the hose by then answers a no-op unsubscribe here.
 */
export function onVaultChangeRequested(fn) {
  const v = ose.vault;
  if (!v || typeof v.onChangeRequested !== 'function') return () => {};
  return v.onChangeRequested((d) => { if (d && d.root) fn(d); });
}

/**
 * Where the executable sits, for the first-run chooser's `suggested:` line. Empty string when
 * the kernel does not say, and then the line is not drawn at all.
 */
export async function exeDir() {
  try {
    const info = await ose.vault.info();
    const dir = info && (info.exeDir || (info.exe ? String(info.exe).replace(/[\\/][^\\/]*$/, '') : ''));
    return dir || '';
  } catch { return ''; }
}
