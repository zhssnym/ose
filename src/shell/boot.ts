// Boot. The only file that decides an order.
//
//   ose.ready -> settings.apply -> vault chooser | mountShell
//             -> initPageHost -> initHome -> initTabs
//             -> ose.init({start:false}) -> initPalette -> initSearch -> initSettings -> initFileOps
//             -> initRecover -> loadKeys
//             -> loadPlanner -> startSurface -> 'booted' -> offerRecovered
//
// The app opens on Home, an empty page (./start.ts). With no vault open the shell is not built
// at all: one surface asks for a folder and the shell starts again on the answer.
//
// The planner (Day, Week, Month, Journal) is part of the app, the views in src/views, loaded
// as a chunk of its own that ships inside the executable. It is loaded here, after the
// shell's own surfaces, so a planner that fails costs its own views and one toast, never the window.
//
// `main.ts` imports this file and calls `boot()`. Whatever throws in here ends on the boot
// error page (`boot-error.ts`, M38), never on a blank window.

import { ose } from '../core/core.ts';
import { toast } from '../ui/index.ts';
import { mountShell } from './layout.ts';
import { mountVaultChooser } from './vault.ts';
import { initPageHost, loadEditor } from './page.ts';
import { initPalette } from './palette.ts';
import { initSearch } from './search.ts';
import { initSettings } from './settings.ts';
import { initHome, startSurface } from './start.ts';
import { initTabs } from './tabs.ts';
import { initFileOps } from './fileops.ts';
import { initRecover, offerRecovered } from './recover.ts';
import { showBootError } from './boot-error.ts';
import KEYS from './keys.json';

/** `keys.json`: the chords the shell adds over the core's window map. */
function loadKeys() {
  for (const [combo, id] of Object.entries(KEYS)) {
    if (typeof id !== 'string' || !id) continue;
    try { ose.keys.bind(combo, id); } catch (e) { console.warn('[shell] keys.json', combo, e); }
  }
}

/**
 * Day, Week, Month and Journal (the views, src/views). One import and one call; the
 * planner registers its views, commands and its section of Settings itself. A planner that
 * does not load is logged and said once, and the rest of the app carries on without it.
 */
async function loadPlanner() {
  try {
    const m = await import('../views/index.ts');
    await m.initViews(ose);
  } catch (e) {
    console.error('[shell] planner', e);
    toast('The planner could not be loaded: ' + (e && typeof e === 'object' && 'message' in e && e.message ? e.message : e), 'err');
  }
}

/** Start the app. Called once by `main.ts`; a vault change boots again through a reload. */
export async function boot(): Promise<void> {
  // The editor is the biggest bundle the window loads, and nothing in the core's own start
  // needs it: its download starts now and `initPageHost` waits for it below.
  void loadEditor();

  try {
    await ose.ready;
  } catch (e) {
    showBootError(e, { stage: 'The core did not answer.', ose });
    return;
  }

  try {
    // The host has answered for itself now, and that is the authority: `first-paint.ts`
    // guessed from the user agent so the first frame had the right font stack.
    if (ose.platform === 'macos') document.documentElement.classList.add('mac');
    document.documentElement.dataset.os =
      ose.platform === 'macos' ? 'mac' : ose.platform === 'linux' ? 'other' : 'win';

    // Font size, line height, zoom and the readable width, before anything is drawn: applying
    // them after would be a visible reflow on every launch.
    ose.settings.apply();

    // `#app` is in index.html.
    const app = document.getElementById('app') as HTMLElement;
    if (!ose.vault.root) {
      await mountVaultChooser(app);
      return;
    }

    const els = mountShell(app);
    // Who draws a page and who draws a folder, before `ose.init`: the router mounts with the
    // shell, and the first thing it may be asked for is either.
    await initPageHost();
    // Home, and the strip that holds the tabs. Both before `ose.init`: Home has to be a
    // registered view (and the router's fallback) before anything navigates to it, and the
    // strip has to be listening before the first route event.
    initHome();
    initTabs(els.tabs, els.main);
    // The one call that starts the core in the shell: the theme, the key engine, and the
    // router mounted into the shell's own page column. `start: false` because the shell
    // decides where the app opens (start.ts).
    ose.init({ page: els.main, start: false });

    initPalette();
    initSearch();
    initSettings();
    initFileOps();
    initRecover();
    await loadKeys();

    // Before the first route, so a tab opened on Day or Journal finds its view registered.
    await loadPlanner();
    await startSurface();

    ose.bus.emit('booted');

    // Text that never reached its file last time: the sheet, once the window is whole (C4).
    void offerRecovered();
    void offerUpdate();
  } catch (e) {
    showBootError(e, { stage: 'The interface failed while it was starting.', ose });
  }
}

/** A new version, downloaded in the background: one sticky toast, and a restart on the user's word. */
async function offerUpdate() {
  const u = await ose.window.updateReady();
  if (!u) return;
  toast(`Ose ${u.version} is ready`, 'info', 0, { actions: [{ label: 'Restart', run: () => u.restart() }] });
}
