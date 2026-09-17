// A module that does one of everything, and nothing you have to delete before it runs: one
// command, one view that renders a markdown file, one tile that counts what is under `data`,
// one settings section with one switch, and its own stylesheet. Copy the folder, rename the
// id in `module.json`, add it to `cockpit.json`'s `modules`, and it is your module.
//
// Read docs/MODULES.md first; the four rules that matter are repeated where they apply below.

import { render } from 'ose:editor';
import { esc, toast } from 'ose:ui';
import { ymd } from 'ose:md';

// The facade `activate` is handed: the same shape as `ose`, with `files`, `watch`, `run` and
// `state` scoped by this manifest. Never import `ose:kernel` in a module — that object is the
// unscoped one, and the point of a module is that it cannot reach past its own `data`.
let ose = null;

/** The one folder this module reads. Anything outside `data` in module.json is refused. */
const HOME = '7-scratchpad';

/* -------------------------------------------------------------------- view */

const view = {
  name: 'template',
  title: 'Template',

  async mount(host) {
    host.innerHTML = `
      <div class="view-root tpl-root" tabindex="-1">
        <div class="page-col">
          <h1 class="page-title">Template</h1>
          <div class="page-meta"><span>${esc(HOME)}</span></div>
          <div class="tpl-body"><div class="empty">reading…</div></div>
        </div>
      </div>`;
    const body = host.querySelector('.tpl-body');
    host.querySelector('.view-root').focus({ preventScroll: true });

    // `render` is `ose:editor`'s read-only markdown: sanitised, links resolved, images through
    // the vault origin. A page you can edit is `markdownPage`, and a route of your own
    // (`ose.route.own`) is where that belongs.
    //
    // The file is `<data>/README.md` when the vault has one — a module reads its own data
    // through `ose.files` and nowhere else — and this module's own README when it does not,
    // which is a file inside the module folder and so fetched, not read.
    const path = `${HOME}/README.md`;
    let text = '';
    let from = path;
    try {
      text = await ose.files.read(path);
    } catch {
      from = 'the module’s own README.md';
      text = await fetch(new URL('./README.md', import.meta.url)).then((r) => r.text()).catch(() => '');
    }
    body.textContent = '';
    if (!text) { body.innerHTML = `<div class="empty">nothing to show at ${esc(path)}</div>`; return; }
    body.appendChild(render(text, {
      basePath: path,
      onLink: (p) => ose.route.navigate({ type: 'page', path: p }),
    }));
    host.querySelector('.page-meta').innerHTML = `<span>${esc(from)}</span>`;
  },

  unmount() { /* nothing of ours is left in the document */ },
};

/* -------------------------------------------------------------------- tile */

/**
 * A tile is a card on whichever view asks for tiles; the stock Day view does. `render` is
 * called once when that view mounts and answers `{ refresh, unmount }`; the kernel calls
 * `refresh` when anybody asks for one, including the watch below.
 */
function renderTile(box) {
  const paint = async () => {
    let n = 0;
    try { n = (await ose.files.list(HOME)).filter((f) => f.kind === 'file').length; } catch { n = 0; }
    if (!box.isConnected) return;
    box.innerHTML = `<div class="tpl-count mono-sm">${n} file${n === 1 ? '' : 's'} in ${esc(HOME)}</div>`;
  };
  void paint();
  return { refresh: () => void paint() };
}

/* ---------------------------------------------------------------- settings */

/**
 * One switch, kept under `settings.modules.<id>` by way of `ose.state`. A module never writes
 * anywhere else in the settings object, and never into a file outside `data`.
 */
function renderSettings(box) {
  const on = ose.state('greet').get() !== false;
  box.innerHTML = `<div class="set-row">
      <div class="set-name">Say hello</div>
      <div class="set-ctl"><div class="seg" data-seg="tpl-greet">
        <button type="button" class="seg-b${on ? ' on' : ''}" data-v="on">on</button>
        <button type="button" class="seg-b${on ? '' : ' on'}" data-v="off">off</button>
      </div></div>
      <div class="set-note">Whether the command answers with a toast.</div>
    </div>`;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-b');
    if (!b) return;
    b.parentElement.querySelectorAll('.seg-b').forEach((n) => n.classList.toggle('on', n === b));
    ose.state('greet').set(b.dataset.v === 'on');
  });
}

/* ------------------------------------------------------------------ module */

export async function activate(app) {
  ose = app;

  // Every action is a command with a title in plain words. `shortcut` arms the chord and the
  // palette prints it; leave it out and the rice's keys.json can bind one instead.
  ose.commands.register({
    id: 'template.hello', title: 'Template: say hello', group: 'template',
    hint: 'proves the module is alive',
    run: () => {
      if (ose.state('greet').get() === false) return;
      toast(`hello from the template · ${ymd(new Date())}`, 'info');
    },
  });

  ose.views.register('template', view);
  ose.tiles.register({ id: 'template.count', title: 'template', order: 90, render: renderTile });
  ose.settings.section({ id: 'template', title: 'template', render: renderSettings });

  // Changes under `data` only: a module's watch never sees the rest of the vault.
  ose.watch(() => ose.tiles.refresh('template.count'));

  addStyles();
}

// Everything registered through the facade is taken back by the kernel; what is left for a
// module to undo is what it put in the document itself.
export function deactivate() { removeStyles(); }

/* ------------------------------------------------------------------ styles */

let sheet = null;
function addStyles() {
  if (sheet) return;
  sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = new URL('./template.css', import.meta.url).href;   // spells no origin
  document.head.appendChild(sheet);
}
function removeStyles() { if (sheet) { sheet.remove(); sheet = null; } }
