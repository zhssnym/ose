// The plugin loader (docs/PLUGINS.md, docs/KERNEL.md `ose.plugins`).
//
// A plugin is local code in the vault under `.ose/plugins/`: a folder with an `index.js` in it,
// or a single `.js` file. There is no manifest, no list of plugins anywhere and no permission
// wall — it is the vault owner's own code, and it is handed the whole `ose`.
//
// `ose.plugins.load()` lists `.ose/plugins`, imports each entry from the app origin, declares
// its `paths`, links its `style.css` when it has one, and calls `activate(facade)`. Plugins load
// independently and concurrently: one that throws on import or in `activate` is disabled for the
// session, whatever it registered is taken back, a toast names it and Settings shows the error.
// The rest of Ose is unaffected.
//
// The facade is the full `ose` with four things of the plugin's own (PLUGINS.md):
//
//   plugin   { id, name, folder } — the folder as a vault path, a legal `cwd` for `ose.run`
//   state    one key, `plugins.<id>`, whatever the plugin asks for
//   paths    `ose.paths.of(<id>)`, its own declared paths and nothing else
//   tagging  every registration carries `plugin: <id>`, so `unload(id)` takes back the commands,
//            views, tiles, routes, settings sections, watches and schedules in one call, kills
//            the processes the plugin started and calls `deactivate()`.

import { bridge } from './bridge/index.js';
import { toast } from './dialog.js';
import { run as kernelRun } from './run.js';
import { uid, views } from './registry.js';
import { declare, of as pathsOf } from './locate.js';
import { currentRoute, ownerFor, dropCurrent } from './router.js';

/** Where plugins live, as a vault path. The one folder name the kernel knows. */
export const FOLDER = '.ose/plugins';

/** An id is a folder name or a file name without `.js`, and nothing else. */
const ID = /^[a-z0-9-]+$/;

// id -> { id, name, description, single, folder, url, state, error, offs, procs, mod, link }
const loaded = new Map();

/** A plugin's own folder as a vault path: `.ose/plugins` itself for a single-file plugin. */
export const pluginHome = (id, single) => (single ? FOLDER : `${FOLDER}/${id}`);

/* --------------------------------------------------------------------- where the app is */

/**
 * The origin the app's own files are served from. In the host this is `app.localhost` (or
 * `app://localhost` on macOS), which the host tells us through `platformInfo().appOrigin`; a
 * plugin file is `<base>/plugins/<id>/<file>` there and comes from `<vault>/.ose/plugins/<id>/`
 * on disk. In the browser dev server the page is the app's own index.html, so the base is the
 * folder it sits in. Nothing above this line spells an origin; this is the only function here
 * that knows one.
 */
let baseUrl = null;
export function setBase(url) { baseUrl = String(url || '').replace(/\/+$/, ''); }
export function base() { return baseUrl; }

async function resolveBase() {
  if (baseUrl !== null) return baseUrl;
  try {
    const info = await bridge.platformInfo();
    if (info && info.appOrigin) { baseUrl = String(info.appOrigin).replace(/\/+$/, ''); return baseUrl; }
  } catch { /* the browser dev server, or a host that does not answer it */ }
  baseUrl = typeof location !== 'undefined' ? location.href.replace(/[^/]*$/, '').replace(/\/+$/, '') : '';
  return baseUrl;
}

/* -------------------------------------------------------------------------- discovery */

/**
 * What is in `.ose/plugins`. A directory holding an `index.js` is a folder plugin — the listing
 * says whether it also has a `style.css`, so no extra request is needed — and a `*.js` file is a
 * single-file plugin. A name starting with `_` or `.` is never loaded (`_lib/` is where shared
 * files go). A vault with no `.ose/plugins` has no plugins, and that is not an error.
 * -> [{ id, single, style, problem? }]
 */
async function discover() {
  let entries;
  try {
    entries = await bridge.list(FOLDER);
  } catch { return []; }
  if (!Array.isArray(entries)) return [];

  const found = [];
  await Promise.all(entries.map(async (row) => {
    const name = String((row && row.name) || '');
    if (!name || name.startsWith('_') || name.startsWith('.')) return;
    if (row.kind === 'dir') {
      let files = [];
      try { files = await bridge.list(`${FOLDER}/${name}`); } catch { files = []; }
      const has = (file) => files.some((f) => f && f.kind !== 'dir' && String(f.name).toLowerCase() === file);
      found.push({
        id: name, single: false, style: has('style.css'),
        problem: has('index.js') ? null : `no index.js in ${FOLDER}/${name}`,
      });
      return;
    }
    if (!/\.js$/i.test(name)) return;
    found.push({ id: name.slice(0, -3), single: true, style: false, problem: null });
  }));
  // The listing is answered in whatever order the two calls settled in; the ids are sorted so a
  // list of plugins reads the same way twice. A folder and a file of the same name are one id:
  // the folder wins, and loading both would activate one plugin twice.
  found.sort((a, b) => String(a.id).localeCompare(String(b.id)) || (a.single ? 1 : -1));
  return found.filter((row, i) => i === 0 || row.id !== found[i - 1].id);
}

/* ------------------------------------------------------------------------- the facade */

/**
 * The object a plugin's `activate` receives: the whole `ose`, plus its own four things. There is
 * no guard on `files`, `watch` or `run` — a plugin reads and writes anywhere in the vault and may
 * run any program (PLUGINS.md). What is kept is the tagging, so nothing survives an unload.
 */
export function makeFacade(ose, entry) {
  const { id } = entry;
  const keep = (off) => { if (typeof off === 'function') entry.offs.push(off); return off; };

  // The id is minted here rather than inside `ose.run`, so the plugin's process table is right
  // from before the call leaves: `unload` kills exactly what this plugin started.
  const run = (cmd, args, opts = {}) => {
    const pid = opts.id || `${id}.${uid()}`;
    entry.procs.add(pid);
    return kernelRun(cmd, args, { ...opts, id: pid }).finally(() => entry.procs.delete(pid));
  };
  run.kill = (pid) => kernelRun.kill(pid);

  return {
    ...ose,
    plugin: { id, name: entry.name, folder: entry.folder },
    run,
    // One key in .ose/state.json, named after the plugin. `paths` under it is the kernel's.
    state: (key) => ose.state(`plugins.${id}${key ? '.' + key : ''}`),
    paths: pathsOf(id),
    commands: { ...ose.commands, register: (cmd) => keep(ose.commands.register({ ...cmd, plugin: id })) },
    views: { ...ose.views, register: (name, def) => keep(ose.views.register(name, { ...def, plugin: id })) },
    tiles: { ...ose.tiles, register: (def) => keep(ose.tiles.register({ ...def, plugin: id })) },
    keys: { ...ose.keys, bind: (...a) => keep(ose.keys.bind(...a)) },
    bus: { ...ose.bus, on: (...a) => keep(ose.bus.on(...a)) },
    settings: { ...ose.settings, section: (def) => keep(ose.settings.section({ ...def, plugin: id })) },
    route: {
      ...ose.route,
      own: (pattern, mount) => keep(ose.route.own(pattern, mount)),
      index: (pattern, fn) => keep(ose.route.index(pattern, fn)),
      on: (fn) => keep(ose.route.on(fn)),
    },
    watch: (...a) => keep(ose.watch(...a)),
    schedule: (sid, spec, fn) => keep(ose.schedule(`${id}.${sid}`, spec, fn)),
  };
}

/* -------------------------------------------------------------------------- loading */

/** The plugin's `style.css`, linked while it is active and removed by `unload`. */
function linkStyle(entry, href) {
  if (typeof document === 'undefined') return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.plugin = entry.id;
  document.head.appendChild(link);
  entry.link = link;
}

async function loadOne(ose, base, found) {
  const { id, single, style } = found;
  const entry = {
    id, name: id, description: '', single,
    folder: pluginHome(id, single),
    url: single ? `${base}/plugins/${id}.js` : `${base}/plugins/${id}/index.js`,
    state: 'disabled', error: null, offs: [], procs: new Set(), mod: null, link: null,
  };
  loaded.set(id, entry);
  if (found.problem) throw new Error(found.problem);

  const mod = await import(/* @vite-ignore */ entry.url);
  entry.mod = mod;
  if (typeof mod.name === 'string' && mod.name.trim()) entry.name = mod.name.trim();
  if (typeof mod.description === 'string') entry.description = mod.description;
  if (typeof mod.activate !== 'function') throw new Error('the entry exports no activate()');
  if (mod.paths && typeof mod.paths === 'object') declare(id, mod.paths);
  if (style) linkStyle(entry, `${base}/plugins/${id}/style.css`);
  await mod.activate(makeFacade(ose, entry));
  entry.state = 'active';
  return entry;
}

/**
 * `ose.plugins.load()` (PLUGINS.md "Loading, errors, reload"): the shell calls it once, after
 * its own surfaces exist. Every plugin is loaded independently and concurrently; one that throws
 * is disabled, named in a toast and in `list()`, and the others still activate. Resolves to the
 * same rows `list()` answers.
 */
export async function load(ose) {
  const base = await resolveBase();
  const found = await discover();
  await Promise.all(found.map(async (row) => {
    const { id } = row;
    try {
      if (!ID.test(id)) throw new Error(`"${id}" is not a plugin id: lowercase letters, digits and - only`);
      await loadOne(ose, base, row);
    } catch (e) {
      const error = String((e && e.message) || e);
      // Half a plugin is worse than none: whatever it managed to register before it threw is
      // taken back, so a failed activate leaves no orphan command in the palette.
      const entry = loaded.get(id)
        || { id, name: id, description: '', single: !!row.single, folder: pluginHome(id, row.single), state: 'disabled', offs: [], procs: new Set(), link: null };
      loaded.set(id, entry);
      await unload(id);
      entry.error = error;
      entry.state = 'disabled';
      console.error(`[plugin:${id}]`, e);
      try { toast(`plugin ${id} is disabled: ${error}`, 'err', 6000); } catch { /* no DOM */ }
    }
  }));
  return list();
}

/**
 * Take back everything a plugin registered, unmount what it has on screen, kill what it started,
 * unlink its stylesheet, call `deactivate`. Resolves to false when there is no such plugin.
 *
 * The page comes down first, and it is awaited (docs/KERNEL.md, the three guarantees): while
 * `unmount` runs the facade is still under it, so the clock banks, the editor saves and the child
 * is killed by the page itself. What is "on screen" is read before the registrations go: a view
 * carries the plugin id the facade tagged it with, and an owned route carries nothing at all, so
 * its owner is looked up now and compared with what owns it once the registrations are back.
 */
export async function unload(id) {
  const entry = loaded.get(id);
  if (!entry) return false;
  const route = currentRoute();
  const view = route && route.type === 'view' ? views.get(route.name) : null;
  const owner = route && route.type === 'own' ? ownerFor(route.path) : null;
  for (const off of entry.offs.reverse()) { try { off(); } catch (e) { console.error(`[plugin:${id}] unsubscribe`, e); } }
  entry.offs = [];
  const mine = (!!view && view.plugin === id) || (!!owner && ownerFor(route.path) !== owner);
  if (mine) {
    try { await dropCurrent(); } catch (e) { console.error(`[plugin:${id}] unmount`, e); }
  }
  for (const pid of entry.procs) { try { void kernelRun.kill(pid); } catch { /* going away */ } }
  entry.procs.clear();
  if (entry.link) { try { entry.link.remove(); } catch { /* already gone */ } entry.link = null; }
  // The paths it declared are left standing on purpose: Settings lists a disabled plugin with
  // the paths it needs, and the choice the user made for one is not lost by a bad edit.
  if (entry.mod && typeof entry.mod.deactivate === 'function') {
    try { entry.mod.deactivate(); } catch (e) { console.error(`[plugin:${id}] deactivate`, e); }
  }
  entry.state = 'disabled';
  return true;
}

export async function unloadAll() { for (const id of [...loaded.keys()]) await unload(id); }

/** The views a plugin has registered, as a row carries them: `[{ name, title, order }]`. */
function viewsOf(id) {
  return views.list()
    .filter((v) => v && v.plugin === id)
    .map((v) => ({ name: v.name, title: String(v.title || v.name), order: Number.isFinite(v.order) ? v.order : 100 }))
    .sort((a, b) => (a.order - b.order) || String(a.title).localeCompare(String(b.title)));
}

/**
 * `ose.plugins.list()`: one row per plugin the loader has seen,
 * `{ id, name, description, state, error?, single, views }` (PLUGINS.md). `views` is read off
 * the view registry by the plugin tag, so a disabled plugin has none: there is no manifest to
 * promise a view that never registered.
 */
export function list() {
  return [...loaded.values()].map((p) => {
    const row = {
      id: p.id,
      name: p.name,
      description: p.description || '',
      state: p.state,
      single: !!p.single,
      views: viewsOf(p.id),
    };
    if (p.error) row.error = p.error;
    return row;
  });
}

export function get(id) { return loaded.get(id) || null; }
