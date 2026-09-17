// What the shell needs to know about the window it is drawn in: is this a real window or a
// browser tab, and the four window hoses the batch-12 shell used to read off the bridge
// (drag, resize by an edge, the maximised state, a vault change). All of them are `ose` now.
//
// One file knows; everybody else calls it. A rice for another kind of window — a decorated
// one, a kiosk — replaces this file and nothing else.

import { ose } from 'ose:kernel';

/** A real window (the Tauri host or a web view) rather than a browser tab. */
export const isHost = () => ose.host !== 'browser';

/** What the status bar and the settings dialog print for "who is answering". */
export const hostKind = () => ose.host;

/** Move the window by its title bar. A browser tab has its own frame and needs none. */
export function dragWindow() {
  if (!isHost()) return;
  try { ose.window.drag(); } catch (e) { console.warn('[shell] drag', e); }
}

/** Resize the frameless window by one of its eight edges. */
export function resizeWindow(edge) {
  if (!isHost()) return;
  try { ose.window.resize(edge); } catch (e) { console.warn('[shell] resize', e); }
}

/** No real window, no edge divs drawn. */
export const canResizeWindow = () => isHost();

/**
 * The maximised state, now and on every change. `fn(true|false)` runs at least once, so the
 * button has the right glyph on the first frame as well as after every toggle.
 */
export function onMaximize(fn) {
  const off = ose.window.onMaximize((v) => fn(!!v));
  if (isHost()) ose.window.isMaximized().then((v) => fn(!!v)).catch(() => { /* no answer, no glyph change */ });
  return off;
}

/** A second launch named another folder and the host adopted it: the rice starts over on it. */
export const onVaultChange = (fn) => ose.vault.onChange(fn);

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
