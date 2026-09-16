// The dashboard: the home of the stock rice, and the first tab.
//
// It is a view like any other (`ose.views.register('dashboard', …)`), so the router mounts it,
// the history remembers it and a tab holds it without anything new in the kernel. What it
// draws is one card per module the loader has seen — name, the manifest's one-line
// description, and the chord that opens its view when a command owns one. Nothing is counted,
// nothing is fetched: the dashboard reads `ose.modules.list()` and that is all. A launcher
// would put numbers on it; this is the same page column, the same title, the same boxes as
// everywhere else in Ose, so arriving here does not feel like leaving the app.
//
// Modules activate after `ose.init`, so the view redraws on `booted` (main.js emits it once
// the loader has answered) and on a later `modules` change if one is ever announced.

import { ose } from 'ose:kernel';
import { esc } from 'ose:ui';
import { openInNewTab } from './tabs.js';

const { bus, commands, route, keys, modules } = ose;

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
 * The command that opens a view, by the convention every stock module follows: `view.<name>`
 * navigates to `{ type:'view', name }`. A module that names its command something else simply
 * gets no chord on its card, which is better than printing one that does something else.
 */
function chordFor(view) {
  if (!view) return '';
  const id = 'view.' + view.name;
  if (!commands.get(id)) return '';
  return keys.shortcutFor(id) || '';
}

/** The rows, sorted the way the sidebar sorted its views: the manifest's order, then the name. */
function rows() {
  const list = modules.list();
  return list.slice().sort((a, b) =>
    (((a.view && a.view.order) ?? 100) - ((b.view && b.view.order) ?? 100))
    || String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

function cardHtml(m) {
  const chord = chordFor(m.view);
  return `
    <button type="button" class="dash-card" data-view="${esc(m.view.name)}">
      <span class="dash-name">${esc(m.view.title || m.name || m.id)}</span>
      <span class="dash-desc">${esc(m.description || '')}</span>
      ${chord ? `<span class="dash-key kbd">${esc(chord)}</span>` : ''}
    </button>`;
}

function render() {
  if (!root) return;
  const all = rows();
  const cards = all.filter((m) => m.state === 'active' && m.view);
  const bare = all.filter((m) => m.state === 'active' && !m.view);
  const off = all.filter((m) => m.state !== 'active');

  const grid = root.querySelector('.dash-grid');
  const rest = root.querySelector('.dash-rest');
  grid.innerHTML = cards.map(cardHtml).join('');
  if (!cards.length) grid.innerHTML = `<div class="empty">no module is loaded</div>`;

  // A module with no view of its own is a line under the grid, not a card that opens nothing.
  // A disabled one says why, in the same line shape, in the error colour.
  const lines = [];
  if (bare.length) {
    lines.push(`<div class="dash-line mono-sm">also loaded: ${bare.map((m) => esc(m.name || m.id)).join(', ')}</div>`);
  }
  for (const m of off) {
    lines.push(`<div class="dash-line mono-sm err">${esc(m.name || m.id)} is disabled: ${esc(m.error || 'unknown')}</div>`);
  }
  rest.innerHTML = lines.join('');
}

const view = {
  title: HOME_TITLE,
  icon: 'view',
  // Never in a sidebar list of views: the stock sidebar has none, and a rice that draws one
  // wants its own home first, not a row among the modules'.
  order: 0,

  mount(host) {
    el = host;
    el.innerHTML = `
<div class="view-root dash" tabindex="-1">
  <div class="page-col">
    <h1 class="page-title">${esc(HOME_TITLE)}</h1>
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
    // rather than the dashboard being drawn twice or waiting for the modules to open at all.
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
    hint: 'the dashboard: one card per module',
    run: () => { void route.navigate(HOME); },
  });
}
