// Where the app opens: Home, the vault's root folder, every time. Nothing of the last session
// comes back.

import { ose } from 'ose:core';

/** Home: the vault root's folder view. A new tab starts here and the last closed tab falls back here. */
export const HOME = { type: 'folder', path: '' };

/** The core's home route and `app.home`. Before `ose.init`, so it is there for the first navigation. */
export function initHome() {
  ose.route.setHome(HOME);
  ose.commands.register({
    id: 'app.home', title: 'Home', group: 'navigate', hint: 'the vault folder',
    run: () => ose.route.navigate(HOME),
  });
}

/**
 * Where the boot ends. The router was mounted with `start: false`, so the column is blank until
 * this runs. Something that has already navigated somewhere keeps the window it asked for.
 * @returns {Promise<void>}
 */
export async function startSurface() {
  if (ose.route.current()) return;
  await ose.route.navigate(HOME);
}
