// The start surface: what the app opens on, and the one command that goes back to it.
//
// The surface itself is drawn by the kernel's router (recent pages and three chords, D7): it
// is what `ose.route.close()` shows, and the router draws it once when the rice mounts it.
// What is rice here is the *decision* — this app has no startup route (docs/CONTRACT.md batch
// 2): the window opens on the sidebar and an empty page column, and the user picks. Another
// rice may open on its day view instead, and this is the file it would change.

import { ose } from 'ose:kernel';

export function initStart() {
  ose.commands.register({
    id: 'app.start',
    title: 'Empty surface',
    group: 'navigate',
    hint: 'the page column with nothing in it',
    run: () => { void ose.route.close(); },
  });
}

/**
 * Where the boot ends. The route is already the empty surface (the router draws it when it is
 * mounted), so this only makes sure nothing a module registered has navigated away from it,
 * and leaves the focus where it is — on the sidebar, which is what the user reaches for first.
 */
export function startSurface() {
  if (ose.route.current()) return;
  void ose.route.close({ focus: false });
}
