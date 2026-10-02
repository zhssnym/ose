// Where the app opens: Home, an empty page, every time. Nothing of the last session
// comes back.

import { ose } from 'ose:core';

/**
 * Home: an empty page, so the window is calm until something is opened from the sidebar. The
 * path bar shows only the vault's name over it, and that name, anywhere, comes back here. A new
 * tab starts here and the last closed tab falls back here.
 */
export const HOME = { type: 'view', name: 'home' };

/** The Home view, the core's home route and `app.home`. Before `ose.init`, for the first navigation. */
export function initHome() {
  ose.views.register('home', {
    title: 'Home',
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
 * @returns {Promise<void>}
 */
export async function startSurface() {
  if (ose.route.current()) return;
  await openStart();
}

/**
 * Where a fresh window or a new tab lands, by Settings › Files › Open at start: the empty page,
 * today's journal (created when it is missing), or a chosen page; a page that is gone since
 * falls back to the empty page.
 */
export async function openStart() {
  const start = ose.settings.get().startPage;
  if (start === 'journal' && ose.commands.get('journal.today')) {
    try { await ose.commands.run('journal.today'); if (ose.route.current()) return; } catch { /* the empty page */ }
  } else if (typeof start === 'string' && start && start !== 'empty') {
    let there = false;
    try { const st = await ose.files.stat(start); there = !!(st && st.exists !== false && st.kind !== 'dir'); } catch { there = false; }
    if (there && await ose.route.navigate({ type: 'page', path: start })) return;
  }
  await ose.route.navigate(HOME);
}
