// Where the app opens: Home, an empty page, every time. Nothing of the last session
// comes back.

import { ose } from '../core/core.ts';

/**
 * Home: an empty page, so the window is calm until something is opened from the sidebar. The
 * path bar shows only the vault's name over it, and that name, anywhere, comes back here. A new
 * tab starts here and the last closed tab falls back here.
 */
export const HOME = { type: 'view', name: 'home' };

/** The Home view, the core's home route and `app.home`. Before `ose.init`, for the first navigation. */
export function initHome() {
  ose.views.register('home', {
    title: 'New tab',
    mount(el) { el.innerHTML = '<div class="view-root home-empty" tabindex="-1"></div>'; },
  });
  ose.route.setHome(HOME);
  ose.commands.register({
    id: 'app.home', title: 'Home', group: 'navigate', hint: 'an empty page',
    run: () => ose.route.navigate(HOME),
  });
}

/**
 * Where the boot ends. The router was mounted with `start: false`, so the column is blank until
 * this runs. Something that has already navigated somewhere keeps the window it asked for.
 */
export async function startSurface(): Promise<void> {
  if (ose.route.current()) return;
  await ose.route.navigate(HOME);
}
