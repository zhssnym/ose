// Where the app opens (H19).
//
// The window comes back the way it was left: the same tabs, each with its own history, the
// same one in front, scrolled where it was (`ose.session`, docs/KERNEL.md "Session restore").
// That is on by default and one machine setting turns it off (`restoreSession`, Settings ›
// Files). With nothing to restore — the first launch, the setting off, a session none of whose
// tabs could be rebuilt — the window opens on Home (shell/dashboard.js).
//
// A tab whose file has gone since is still restored: it shows the router's miss box when it
// is brought to the front, which is honest and costs nothing at boot. Only the tab in front is
// mounted; the others are drawn when they are picked.

import { ose } from 'ose:kernel';
import { HOME } from './dashboard.js';

/**
 * Where the boot ends. The router was mounted with `start: false`, so the column is blank until
 * this runs. Something that has already navigated somewhere keeps the window it asked for.
 * @returns {Promise<void>}
 */
export async function startSurface() {
  if (ose.route.current()) return;
  if (ose.settings.get().restoreSession !== false) {
    let restored = false;
    try { restored = await ose.session.restore(); } catch (e) { console.warn('[shell] session restore', e); }
    if (restored) return;
  }
  await ose.route.navigate(HOME);
}
