// Boot. The shell's entry, and the only file that decides an order.
//
//   ose.ready  ->  the shell  ->  ose.init  ->  the shell's own surfaces  ->  the plugins
//
// The app opens on the dashboard (shell/dashboard.js): the home tab, one card per plugin, and
// no page — there is still no startup *route*, only a home the user leaves by picking
// something. With no vault open the shell is not built at all: one surface asks for a folder
// and the shell starts again on the answer.

import { ose } from 'ose:kernel';
import { toast } from 'ose:ui';
import { mountShell } from './layout.js';
import { mountVaultChooser } from './vault.js';
import { initPageHost } from './page.js';
import { initPalette } from './palette.js';
import { initSearch } from './search.js';
import { initSettings } from './settings.js';
import { startSurface } from './start.js';
import { initDashboard } from './dashboard.js';
import { initTabs } from './tabs.js';

/**
 * The two stylesheets the kernel rewrites into `index.html` (docs/KERNEL.md "Origins"). A host
 * fills them in before the page is parsed; a plain file server does not, and then the kernel's
 * own assets answer for them. Either way no shell file spells an origin.
 */
function linkKernelStyles() {
  for (const link of document.querySelectorAll('link[data-ose]')) {
    if (link.getAttribute('href')) continue;
    link.href = ose.assets.url(`${link.dataset.ose}.css`);
  }
}

/** `keys.json`: the chords the shell adds over the kernel's window map. */
async function loadKeys() {
  let map = null;
  try {
    const res = await fetch(new URL('./keys.json', import.meta.url), { cache: 'no-store' });
    if (!res.ok) return;
    map = await res.json();
  } catch (e) { console.warn('[shell] keys.json', e); return; }
  if (!map || typeof map !== 'object') return;
  for (const [combo, id] of Object.entries(map)) {
    if (typeof id !== 'string' || !id) continue;
    try { ose.keys.bind(combo, id); } catch (e) { console.warn('[shell] keys.json', combo, e); }
  }
}

/**
 * The shell's own path: where a new page lands when no folder is focused. It is declared under
 * the owner `app`, like a plugin's, so the sidebar's scratch section and Settings › Files read
 * it the same way a plugin reads its own (docs/PLUGINS.md `ose.paths`). Resolved once here,
 * before the sidebar is drawn, so the section is right on the first frame.
 */
async function resolveScratch() {
  ose.paths.declare('app', {
    scratch: { folder: 'scratchpad', hint: 'Where new pages land unless a folder is focused.' },
  });
  try { await ose.paths.of('app').get('scratch'); } catch (e) { console.warn('[shell] scratch', e); }
}

/**
 * The plugins of this vault (docs/PLUGINS.md). One that throws is disabled for the session,
 * toasted by the loader and named in Settings › Plugins; the rest, and the shell, are
 * untouched.
 */
async function loadPlugins() {
  try {
    const list = await ose.plugins.load();
    for (const p of (list || []).filter((p) => p && p.state !== 'active')) {
      console.warn('[shell] plugin disabled:', p.id, p.error);
    }
  } catch (e) {
    console.error('[shell] plugins', e);
    toast('plugins could not be loaded: ' + (e.message || e), 'err');
  }
}

async function boot() {
  const root = document.getElementById('app');
  ose.status.set('mode', 'STARTING');

  try {
    await ose.ready;
  } catch (e) {
    root.innerHTML = `<div class="empty">the kernel did not answer: ${String(e && e.message ? e.message : e)}</div>`;
    return;
  }
  linkKernelStyles();

  // The host has answered for itself now, and that is the authority: `first-paint.js` guessed
  // from the user agent so the first frame had the right font stack.
  if (ose.platform === 'macos') document.documentElement.classList.add('mac');
  document.documentElement.dataset.os =
    ose.platform === 'macos' ? 'mac' : ose.platform === 'linux' ? 'other' : 'win';

  // Font size, line height, zoom and the readable width, before anything is drawn: applying
  // them after would be a visible reflow on every launch.
  ose.settings.apply();

  if (!ose.vault.root) {
    ose.status.set('mode', 'NO VAULT');
    await mountVaultChooser(root);
    return;
  }

  await resolveScratch();

  const els = mountShell(root);
  // Who draws a page, and what the page list is. Before `ose.init`, because the router mounts
  // with the shell and the first thing it may be asked for is a page.
  initPageHost();
  // The home this shell opens on, and the strip that holds it. Both before `ose.init`: the
  // dashboard has to be a registered view before anything navigates to it, and the strip has
  // to be listening before the first route event.
  initDashboard();
  initTabs(els.tabs, els.main);
  // The one call that starts the kernel in the shell: the theme, the key engine, and the
  // router mounted into the shell's own page column. `start: false` because the shell has a
  // home of its own; without it the kernel's empty surface would flash away under the
  // dashboard on every boot.
  ose.init({ page: els.main, start: false });

  initPalette();
  initSearch();
  initSettings();
  await loadKeys();

  // The home tab, before the plugins load: the dashboard is on screen while they activate and
  // fills in when `booted` says they have. A plugin that navigates somewhere else on activate
  // opens a second tab, which is what a second tab is for.
  startSurface();

  await loadPlugins();

  ose.status.set('mode', 'READY');
  ose.bus.emit('booted');
}

boot();
