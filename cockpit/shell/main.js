// Boot. The rice's entry, and the only file that decides an order.
//
//   ose.ready  ->  the shell  ->  ose.init  ->  the rice's own surfaces  ->  the modules
//
// Nothing is navigated to: the app opens on the sidebar and an empty page column and the user
// picks (docs/CONTRACT.md batch 2). With no vault open the shell is not built at all — one
// surface asks for a folder and the rice starts again on the answer.

import { ose } from 'ose:kernel';
import { toast } from 'ose:ui';
import { mountShell } from './layout.js';
import { mountVaultChooser } from './vault.js';
import { initPageHost } from './page.js';
import { initPalette } from './palette.js';
import { initSearch } from './search.js';
import { initSettings } from './settings.js';
import { initUpdate } from './update.js';
import { initStart, startSurface } from './start.js';

/**
 * The two stylesheets the kernel rewrites into `index.html` (docs/KERNEL.md "Origins"). A host
 * fills them in before the page is parsed; a plain file server does not, and then the kernel's
 * own assets answer for them. Either way no rice file spells an origin.
 */
function linkKernelStyles() {
  for (const link of document.querySelectorAll('link[data-ose]')) {
    if (link.getAttribute('href')) continue;
    link.href = ose.assets.url(`${link.dataset.ose}.css`);
  }
}

/** `keys.json`: the chords this rice adds over the kernel's shell map (docs/RICE.md). */
async function loadKeys() {
  let map = null;
  try {
    const res = await fetch(new URL('../keys.json', import.meta.url), { cache: 'no-store' });
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
 * The modules of this rice (docs/MODULES.md). One that throws is disabled with a toast and
 * named in settings; the rest, and the shell, are untouched.
 */
async function loadModules() {
  try {
    const list = await ose.modules.load();
    const bad = (list || []).filter((m) => m && m.state !== 'active');
    for (const m of bad) console.warn('[shell] module disabled:', m.id, m.error);
  } catch (e) {
    console.error('[shell] modules', e);
    toast('modules could not be loaded: ' + (e.message || e), 'err');
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

  const els = mountShell(root);
  // Who draws a page, and what the page list is. Before `ose.init`, because the router mounts
  // with the shell and the first thing it may be asked for is a page.
  initPageHost();
  // The one call that starts the kernel in the rice: the theme, the key engine, and the
  // router mounted into the rice's own page column.
  ose.init({ page: els.main });

  initPalette();
  initSearch();
  initSettings();
  initUpdate();
  initStart();
  await loadKeys();

  await loadModules();
  startSurface();

  ose.status.set('mode', 'READY');
  ose.bus.emit('booted');
}

boot();
