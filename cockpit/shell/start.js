// Where the app opens.
//
// What is rice here is the *decision*. The kernel has no startup route (docs/CONTRACT.md batch
// 2) and its empty surface is still a hose — `ose.route.close()` draws it, and the tab strip
// leans on that to close a tab. But this rice has a home of its own: the dashboard
// (shell/dashboard.js), the first tab, one card per module, `app.home` in the palette. Another
// rice may open on its day view, or on nothing at all, and this is the file it would change.
//
// There is no `app.start` any more. A command that landed on the empty surface would land on
// a surface with no tab in front of it, and "back to nothing" is not a thing this rice offers:
// `app.home` is where nothing-in-particular goes.

import { ose } from 'ose:kernel';
import { HOME } from './dashboard.js';

/**
 * Where the boot ends: the home tab. The router was mounted with `start: false`, so the column
 * is blank until this runs and the kernel's empty surface never flashes under it. A module
 * that has already navigated somewhere keeps the window it asked for.
 */
export function startSurface() {
  if (ose.route.current()) return;
  void ose.route.navigate(HOME);
}
