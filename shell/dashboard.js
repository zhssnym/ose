// The dashboard: the home of the shell, and the first tab.
//
// It is a view like any other (`ose.views.register('dashboard', …)`), so the router mounts it,
// the history remembers it and a tab holds it without anything new in the kernel. What it
// draws is one card per plugin the loader has seen — its name, its one-line description, and
// the chord that opens its view when a command owns one. Nothing is counted, nothing is
// fetched: the dashboard reads `ose.plugins.list()` and that is all. A launcher would put
// numbers on it; this is the same page column, the same title, the same boxes as everywhere
// else in Ose, so arriving here does not feel like leaving the app.
//
// Plugins activate after `ose.init`, so the view redraws on `booted` (main.js emits it once
// the loader has answered) and on a later `plugins` change if one is ever announced.

import { ose } from 'ose:kernel';
import { esc } from 'ose:ui';
import { openInNewTab } from './tabs.js';
import { byViewOrder, byPluginOrder } from './order.js';

const { bus, commands, route, keys, plugins } = ose;

/** The home route. `tabs.js` and `start.js` both ask here rather than spelling the name. */
export const HOME = { type: 'view', name: 'dashboard' };
export const HOME_TITLE = 'Home';

let el = null;
let root = null;
let ro = null;
let offBooted = null;

// Under this many pixels of page column the grid is one column. The cards are the page's, not
// the window's: the sidebar changes how much room there is (the Day view measures the same way).
const NARROW = 640;

/**
 * The command that opens a view, by the convention every stock plugin follows: `view.<name>`
 * navigates to `{ type:'view', name }`. A plugin that names its command something else simply
 * gets no chord on its card, which is better than printing one that does something else.
 */
function chordFor(view) {
  if (!view) return '';
  const id = 'view.' + view.name;
  if (!commands.get(id)) return '';
  return keys.shortcutFor(id) || '';
}

/** The plugins, in the sidebar's order: their views' `order`, then title (order.js). */
function rows() {
  return plugins.list().slice().sort(byPluginOrder);
}

/** The view a card opens: the first of the plugin's, in the order the sidebar lists them. */
const mainView = (p) => ((p && p.views) || []).slice().sort(byViewOrder)[0] || null;

function cardHtml(p, view) {
  const chord = chordFor(view);
  return `
    <button type="button" class="dash-card" data-view="${esc(view.name)}">
      <span class="dash-name">${esc(p.name || p.id)}</span>
      <span class="dash-desc">${esc(p.description || '')}</span>
      ${chord ? `<span class="dash-key kbd">${esc(chord)}</span>` : ''}
    </button>`;
}

function render() {
  if (!root) return;
  const all = rows();
  const cards = all.filter((p) => p.state === 'active' && mainView(p));
  const bare = all.filter((p) => p.state === 'active' && !mainView(p));
  const off = all.filter((p) => p.state !== 'active');

  const grid = root.querySelector('.dash-grid');
  const rest = root.querySelector('.dash-rest');
  grid.innerHTML = cards.map((p) => cardHtml(p, mainView(p))).join('');
  // A vault with no plugins is a plain editor, and the home page says so in one quiet line
  // rather than looking like something failed. With plugins but no cards the lines below
  // carry the whole story already.
  if (!all.length) grid.innerHTML = `<div class="empty">No plugins. A plugin is a folder in .ose/plugins.</div>`;

  // A plugin with no view of its own is a line under the grid, not a card that opens nothing.
  // A disabled one says why, in the same line shape, in the error colour.
  const lines = [];
  if (bare.length) {
    lines.push(`<div class="dash-line mono-sm">also loaded: ${bare.map((p) => esc(p.name || p.id)).join(', ')}</div>`);
  }
  for (const p of off) {
    lines.push(`<div class="dash-line mono-sm err">${esc(p.name || p.id)} is disabled: ${esc(p.error || 'unknown')}</div>`);
  }
  rest.innerHTML = lines.join('');
}

const view = {
  title: HOME_TITLE,
  icon: 'view',
  // Never in a sidebar list of views: it is the page the app opens on, not a plugin's way in.
  order: 0,

  mount(host) {
    el = host;
    el.innerHTML = `
<div class="view-root dash" tabindex="-1">
  <div class="page-col">
    <h1 class="page-title view-title">${esc(HOME_TITLE)}</h1>
    <div class="dash-grid"></div>
    <div class="dash-rest"></div>
  </div>
</div>`;
    root = el.querySelector('.view-root');

    // A plain click replaces what is in front; Ctrl (or Cmd) click and the middle button make
    // a tab of it, which is the same gesture every row in the app answers to (shell/tabs.js).
    const open = (card, aside) => {
      const r = { type: 'view', name: card.dataset.view };
      if (aside) void openInNewTab(r); else void route.navigate(r);
    };
    root.addEventListener('click', (e) => {
      const card = e.target.closest('.dash-card');
      if (!card) return;
      open(card, e.ctrlKey || e.metaKey);
    });
    root.addEventListener('auxclick', (e) => {
      const card = e.target.closest('.dash-card');
      if (!card || e.button !== 1) return;
      e.preventDefault();
      open(card, true);
    });

    const fit = (w) => { if (root) root.classList.toggle('narrow', w < NARROW); };
    fit(el.clientWidth);
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver((entries) => fit(entries[0].contentRect.width));
      ro.observe(el);
    }

    render();
    // The loader answers after `ose.init`: the cards appear the moment it does, in place,
    // rather than the dashboard being drawn twice or waiting for the plugins to open at all.
    offBooted = bus.on('booted', render);
    return { unmount: view.unmount, refresh: render };
  },

  unmount() {
    if (offBooted) { offBooted(); offBooted = null; }
    if (ro) { ro.disconnect(); ro = null; }
    el = null;
    root = null;
  },
};

export function initDashboard() {
  ose.views.register('dashboard', view);
  commands.register({
    id: 'app.home', title: 'Home', group: 'navigate',
    hint: 'the dashboard: one card per plugin',
    run: () => { void route.navigate(HOME); },
  });
}
