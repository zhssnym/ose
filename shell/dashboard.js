// Home (H19): where a new tab starts, where the last tab closes to, and what `app.home` opens.
//
// It is a view like any other (`ose.views.register('home', …)`), so the router mounts it, the
// history remembers it and a tab holds it without anything new in the core; the core is
// told it is the home (`ose.route.setHome`) and that is all it knows. What it draws, top to
// bottom, with whitespace between the groups and no cards:
//
//   1. the planner row: one button per view the planner registered (`section: 'planner'`),
//      in their own order, each with its chord when it has one. Nothing when there is none.
//   2. pins, from shell/pins.js: a pin whose file is gone stays, greyed, marked missing (L22).
//   3. recent files, up to eight, each name with its folder.
//   4. the vault root, as the folder view's own list in its compact form, with a way to the
//      whole folder view.
//
// Nothing is counted and nothing is fetched beyond one listing and a handful of stats. It is
// the same page column, the same title and the same rows as everywhere else in Ose, so
// arriving here does not feel like leaving the app.

import { ose } from 'ose:core';
import { esc, icon, hasIcon } from 'ose:ui';
import { openInNewTab } from './tabs.js';
import { byViewOrder } from './order.js';
import * as pins from './pins.js';
import { mountFolderList, folderRoute } from './folder.js';
import { iconName } from './folder-model.js';
import { baseName, dirName, titleOf, vaultName, isOutside, outsideLabel } from './paths.js';

const { bus, commands, route, keys } = ose;

/** The home route. `tabs.js` and `start.js` both ask here rather than spelling the name. */
export const HOME = { type: 'view', name: 'home' };
export const HOME_TITLE = 'Home';

const RECENT = 8;

const iconSvg = (name, fallback = 'file') => icon(hasIcon(name) ? name : fallback);

/** A file's name as the chrome shows it (W8): whole, `.md` stripped only when hideMdExt is on. */
const display = (path) => titleOf(path) || baseName(path);

/** The planner's views, in their own order: `order`, then title (order.js). */
function plannerViews() {
  return ose.views.list().filter((v) => v && v.section === 'planner').sort(byViewOrder);
}

/** The chord of `view.<name>`, when a command of that name has one. */
function chordFor(name) {
  const id = 'view.' + name;
  if (!commands.get(id)) return '';
  return keys.shortcutFor(id) || '';
}

/**
 * A row of the pins or the recent list: the icon, the name, the folder, and a note. A file
 * outside the vault (X7) names its absolute folder and wears the same mark its tab does.
 */
function rowHtml({ path, kind, missing = false }) {
  const out = isOutside(path);
  const folder = out ? outsideLabel(dirName(path)) : dirName(path);
  const name = kind === 'dir' ? (baseName(path) || vaultName()) : display(path);
  const glyph = iconSvg(iconName({ name: baseName(path), kind }), kind === 'dir' ? 'folder' : 'file');
  const hint = missing ? 'missing' : folder;
  const tip = `${out ? outsideLabel(path) : path}${out ? ' (outside the vault)' : ''}${missing ? ' (missing)' : ''}`;
  return `<button type="button" class="row home-row${missing ? ' missing' : ''}${out ? ' outside' : ''}" data-path="${esc(path)}" data-kind="${kind}" title="${esc(tip)}"${out ? ` aria-label="${esc(`${name}, outside vault, ${folder}`)}"` : ''}>
    ${glyph}<span class="grow">${esc(name)}</span>${out ? '<span class="home-out mono-sm" aria-hidden="true">outside vault</span>' : ''}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  </button>`;
}

const routeOfRow = (row) => (row.dataset.kind === 'dir'
  ? folderRoute(row.dataset.path)
  : { type: 'page', path: row.dataset.path });

let el = null;
let root = null;
let rootList = null;
let offs = [];
let recentSeq = 0;

function renderPlanner() {
  const box = root && root.querySelector('.home-planner');
  if (!box) return;
  const list = plannerViews();
  box.hidden = !list.length;
  box.innerHTML = list.map((v) => {
    const chord = chordFor(v.name);
    return `<button type="button" class="btn home-plan" data-view="${esc(v.name)}" title="${esc(v.title || v.name)}${chord ? ` (${esc(chord)})` : ''}">
      ${iconSvg(v.icon || 'view', 'view')}<span>${esc(v.title || v.name)}</span>${chord ? `<span class="kbd">${esc(chord)}</span>` : ''}
    </button>`;
  }).join('');
}

function renderPins() {
  const sec = root && root.querySelector('.home-pins');
  if (!sec) return;
  let list = [];
  try { list = pins.list(); } catch (e) { console.warn('[home] pins', e); }
  sec.hidden = !list.length;
  sec.querySelector('.home-rows').innerHTML = list.map(rowHtml).join('');
}

async function renderRecent() {
  const sec = root && root.querySelector('.home-recent');
  if (!sec) return;
  const my = ++recentSeq;
  const candidates = (route.recent() || []).slice(0, RECENT * 2);
  // A recent file that is gone is left out of the list, not out of the record: it comes back
  // if the file does. One stat per row, after the rest of Home is up.
  const alive = await Promise.all(candidates.map((p) => ose.files.exists(p).catch(() => false)));
  if (my !== recentSeq || !root) return;
  const list = candidates.filter((_, i) => alive[i]).slice(0, RECENT);
  sec.hidden = !list.length;
  sec.querySelector('.home-rows').innerHTML = list.map((p) => rowHtml({ path: p, kind: 'file' })).join('');
}

function renderRootHead() {
  const name = root && root.querySelector('.home-root-name');
  if (name) name.textContent = vaultName();
}

function render() {
  if (!root) return;
  renderPlanner();
  renderPins();
  void renderRecent();
  renderRootHead();
}

/** Up and Down walk the rows of one group, so Enter opens without a Tab per row. */
function walk(e) {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest('.home-plan') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    const all = [...root.querySelectorAll('.home-plan')];
    const at = all.indexOf(t.closest('.home-plan'));
    const next = all[(at + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
    e.preventDefault();
    next.focus();
    return;
  }
  const row = t.closest('.home-row');
  if (!row || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  const all = [...root.querySelectorAll('.home-row')];
  const at = all.indexOf(row);
  const next = all[Math.max(0, Math.min(all.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
  e.preventDefault();
  if (next) next.focus();
}

const view = {
  title: HOME_TITLE,
  icon: 'home',

  mount(host) {
    el = host;
    el.innerHTML = `
<div class="view-root home" tabindex="-1">
  <div class="page-col">
    <h1 class="page-title view-title">${esc(HOME_TITLE)}</h1>
    <div class="home-planner" role="group" aria-label="Planner" hidden></div>
    <section class="home-sec home-pins" hidden aria-label="Pinned">
      <div class="label">Pinned</div>
      <div class="home-rows"></div>
    </section>
    <section class="home-sec home-recent" hidden aria-label="Recent">
      <div class="label">Recent</div>
      <div class="home-rows"></div>
    </section>
    <section class="home-sec home-root" aria-label="Vault">
      <div class="home-root-head">
        <div class="label home-root-name"></div>
        <button type="button" class="v-link home-open-root mono-sm">Open folder view</button>
      </div>
      <div class="home-list"></div>
    </section>
  </div>
</div>`;
    root = el.querySelector('.view-root');

    // A plain click replaces what is in front; Ctrl (or Cmd) click and the middle button make
    // a tab of it, the gesture every row in the app answers to (shell/tabs.js).
    const go = (r, aside) => { if (aside) void openInNewTab(r); else void route.navigate(r); };
    root.addEventListener('click', (e) => {
      const aside = e.ctrlKey || e.metaKey;
      const plan = e.target.closest('.home-plan');
      if (plan) { go({ type: 'view', name: plan.dataset.view }, aside); return; }
      const row = e.target.closest('.home-row');
      if (row) { go(routeOfRow(row), aside); return; }
      if (e.target.closest('.home-open-root')) go(folderRoute(''), aside);
    });
    root.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const plan = e.target.closest('.home-plan');
      const row = e.target.closest('.home-row');
      if (!plan && !row && !e.target.closest('.home-open-root')) return;
      e.preventDefault();
      go(plan ? { type: 'view', name: plan.dataset.view } : row ? routeOfRow(row) : folderRoute(''), true);
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        const b = e.target instanceof Element ? e.target.closest('.home-row, .home-plan, .home-open-root') : null;
        if (!b) return;
        e.preventDefault();
        go(b.classList.contains('home-plan') ? { type: 'view', name: b.dataset.view }
          : b.classList.contains('home-row') ? routeOfRow(b) : folderRoute(''), true);
        return;
      }
      walk(e);
    });

    rootList = mountFolderList(root.querySelector('.home-list'), '', { compact: true });

    render();
    offs = [
      // The planner registers after the shell; its row appears the moment it has.
      bus.on('booted', renderPlanner),
      pins.on(renderPins),
      bus.on('paths:moved', () => void renderRecent()),
      bus.on('paths:trashed', () => void renderRecent()),
      bus.on('paths:restored', () => void renderRecent()),
    ];
    return { unmount: view.unmount, refresh: view.refresh };
  },

  refresh() {
    if (!root) return;
    render();
    if (rootList) void rootList.refresh();
  },

  unmount() {
    for (const off of offs) { try { off && off(); } catch { /* gone */ } }
    offs = [];
    recentSeq++;
    if (rootList) { rootList.unmount(); rootList = null; }
    el = null;
    root = null;
  },
};

/**
 * Register Home: the view, `app.home`, and the core's home route (the tab the last close
 * falls back to). Before `ose.init`, so it is there for the first navigation.
 */
export function initDashboard() {
  ose.views.register('home', view);
  route.setHome(HOME);
  commands.register({
    id: 'app.home', title: 'Home', group: 'navigate',
    hint: 'the planner, pins, recent files and the vault folder',
    run: () => route.navigate(HOME),
  });
}
