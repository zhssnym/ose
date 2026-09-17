// A plugin that does one of everything and runs the moment it is copied: one declared path, one
// command, one view, one tile, one settings section, one stylesheet.
//
// Copy this folder into `<vault>/.ose/plugins/`, rename it, press Ctrl+R. The folder name is the
// id; the loader never loads a name starting with `_`, which is why this copy sits here inert.
//
// Read docs/PLUGINS.md first. The rules that matter are repeated where they apply below.

import { render } from 'ose:editor';
import { esc, toast } from 'ose:ui';
import { ymd } from 'ose:md';

// The `ose` handed to `activate`: the whole object, with this plugin's own `plugin`, `state` and
// `paths` on it. Never `import { ose } from 'ose:kernel'`: registrations made on that one are not
// tagged and would survive an unload.
let ose = null;

export const name = 'Template';
export const description = 'One of everything: a path, a command, a view, a tile, a setting.';

/**
 * What this plugin needs from the vault, by name. It never spells a path: `ose.paths` looks the
 * name up in the tree and, when the name is not enough, draws a box that asks once and remembers.
 * `hint` is the sentence that box and Settings show.
 */
export const paths = {
  notes: { folder: 'scratchpad', hint: 'Any folder of markdown notes. Its README.md is shown.' },
};

/* -------------------------------------------------------------------------------- the view */

const view = {
  name: 'template',
  title: 'Template',
  order: 90,

  async mount(el) {
    el.innerHTML = `
      <div class="view-root tpl-root" tabindex="-1">
        <div class="page-col">
          <h1 class="page-title">Template</h1>
          <div class="page-meta mono-sm"></div>
          <div class="tpl-body"></div>
        </div>
      </div>`;
    el.querySelector('.view-root').focus({ preventScroll: true });
    const body = el.querySelector('.tpl-body');
    const meta = el.querySelector('.page-meta');

    // With `el`, a path that cannot be resolved draws the standard box into it and answers null.
    // The box is the whole answer: say nothing else and let the user finish it.
    const dir = await ose.paths.get('notes', { el: body });
    if (!dir) { meta.textContent = 'no folder yet'; return; }
    meta.textContent = dir;

    const rows = await ose.files.list(dir);
    const readme = rows.find((f) => f.kind !== 'dir' && f.name.toLowerCase() === 'readme.md');
    if (!readme) {
      const n = rows.filter((f) => f.kind !== 'dir').length;
      body.innerHTML = `<div class="empty">${n} file${n === 1 ? '' : 's'} in ${esc(dir)},`
        + ` and no README.md</div>`;
      return;
    }
    // `render` is read-only markdown: sanitised, links resolved, images through the vault origin.
    // A page the user edits is `markdownPage`, and it belongs on a route of the plugin's own.
    body.appendChild(render(await ose.files.read(readme.path), {
      basePath: readme.path,
      onLink: (path) => ose.route.navigate({ type: 'page', path }),
    }));
  },

  // On the registration, not on what `mount` answers: that is where the router looks for it. The
  // kernel takes every registration back on unload, so this only undoes what the view itself put
  // in the document, and here that is nothing.
  unmount() {},
};

/* -------------------------------------------------------------------------------- the tile */

/**
 * A tile is a card on whichever view asks for tiles; the stock Day view does. `render(el)` is
 * called once when that view mounts and answers `{ refresh, unmount }`; `refresh` runs whenever
 * anybody asks for one, including the watch in `activate`.
 */
function renderTile(el) {
  const paint = async () => {
    // `peek` is the synchronous answer, for a place that cannot draw a box: a tile is not the
    // view that asked for the path, so it says nothing rather than asking a second time.
    const dir = ose.paths.peek('notes');
    let text = 'no folder yet';
    if (dir) {
      try {
        const n = (await ose.files.list(dir)).filter((f) => f.kind !== 'dir').length;
        text = `${n} file${n === 1 ? '' : 's'} in ${dir}`;
      } catch { text = `${dir} could not be read`; }
    }
    if (!el.isConnected) return;
    el.innerHTML = `<div class="tpl-count mono-sm">${esc(text)}</div>`;
  };
  void paint();
  return { refresh: () => void paint() };
}

/* ---------------------------------------------------------------------------- the settings */

/** One switch, kept under `plugins.<id>.greet` in `.ose/state.json` through `ose.state`. */
function renderSettings(el) {
  const on = ose.state('greet').get() !== false;
  el.innerHTML = `<div class="set-row">
      <div class="set-name">Say hello</div>
      <div class="set-ctl"><div class="seg" data-seg="tpl-greet">
        <button type="button" class="seg-b${on ? ' on' : ''}" data-v="on">on</button>
        <button type="button" class="seg-b${on ? '' : ' on'}" data-v="off">off</button>
      </div></div>
      <div class="set-note">Whether the command answers with a toast.</div>
    </div>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-b');
    if (!b) return;
    b.parentElement.querySelectorAll('.seg-b').forEach((n) => n.classList.toggle('on', n === b));
    ose.state('greet').set(b.dataset.v === 'on');
  });
}

/* ------------------------------------------------------------------------------ the plugin */

/**
 * Registrations and subscriptions only: `activate` runs while the window is opening, so it reads
 * no file and starts no process. It may be async.
 */
export function activate(app) {
  ose = app;
  const id = ose.plugin.id;
  const tile = `${id}.count`;

  // Every action is a command with a title in plain words, so it is in the palette and reachable
  // from the keyboard. `shortcut` arms a chord; leave it out and the shell's keys.json can bind
  // one instead.
  ose.commands.register({
    id: `${id}.hello`,
    title: 'Template: say hello',
    group: id,
    hint: 'proves the plugin is alive',
    run: () => {
      if (ose.state('greet').get() === false) return;
      toast(`hello from ${ose.plugin.name} · ${ymd(new Date())}`, 'info');
    },
  });

  ose.views.register(view.name, view);
  ose.tiles.register({ id: tile, title: 'template', order: 90, render: renderTile });
  ose.settings.section({ id, title: 'template', render: renderSettings });

  // The watch is the whole vault, so filter it down to the folder this plugin actually resolved.
  ose.watch((e) => {
    const dir = ose.paths.peek('notes');
    if (!dir) return;
    if (e.lost || e.changes.some((c) => c.path === dir || c.path.startsWith(dir + '/'))) {
      ose.tiles.refresh(tile);
    }
  });

  // The tile reads the folder too, so redraw it when the user chooses another one.
  ose.paths.on(() => ose.tiles.refresh(tile));
}

// Optional. The kernel takes back every registration, kills every process the plugin started and
// unlinks `style.css`; what is left for `deactivate` is whatever the plugin put in the document
// by itself, and this one puts nothing there.
export function deactivate() {}
