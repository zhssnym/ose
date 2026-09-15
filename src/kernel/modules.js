// The module loader (docs/MODULES.md, docs/KERNEL.md `ose.modules`).
//
// `ose.modules.load()` reads every `modules/*/module.json` from the rice, checks `requires`
// against `ose.api`, imports the entry, builds the **facade** the module's `activate` is
// handed, and disables the module with a toast if anything throws. The rest of Ose is never
// affected by a module that fails: one bad folder is one disabled row in settings.
//
// The facade is the same object shape as `ose`, with four hoses narrowed by the manifest:
//
//   files   read and write only under `data`; empty `data` means read the whole vault and
//           write nothing
//   watch   folders intersected with `data`
//   run     only the programs `run` names — compared the way the host compares them, by
//           program stem and case-insensitively on Windows — and the list is passed to the
//           host as well so the refusal happens on both sides. `cwd` may be one of the data
//           folders or the module's own folder.
//   state   one key, `modules.<id>`, whatever the module asks for
//
// and with every registration tagged by module id, so `unload(id)` takes back the commands,
// views, tiles, routes, settings sections, watches, schedules and running processes in one
// call. A violation rejects with `not allowed by module.json: <what>`, the sentence KERNEL.md
// promises, and nothing is written.

import { bridge } from './bridge/index.js';
import { clean } from './paths.js';
import { toast } from './dialog.js';
import { run as kernelRun } from './run.js';
import { uid } from './registry.js';

const API = 1;

// id -> { id, name, manifest, base, state: 'active'|'disabled', error, offs: [], procs: Set }
const loaded = new Map();

const isUnder = (path, folder) => {
  const p = clean(path);
  const f = clean(folder);
  return !f || p === f || p.startsWith(f + '/');
};

const notAllowed = (what) => Object.assign(new Error(`not allowed by module.json: ${what}`), { code: 'ENOTALLOWED' });

/** Extensions that are part of a program's name on Windows and not part of what `run` allows. */
const PROGRAM_EXTS = new Set(['exe', 'bat', 'cmd', 'com']);

/**
 * The name a caller means when it allows a program: the file name, without a directory and
 * without a Windows program extension, lowercased on Windows. This is the host's own
 * normalisation — `program_key` in src-tauri/src/run.rs and `programKey` in
 * dev/bridge-plugin.mjs — spelled here so the facade refuses exactly what the host refuses and
 * nothing more. `tools/python.exe`, `C:\Python313\python.exe` and `python` are one key;
 * `python3` is not.
 */
export function programKey(name, windows = true) {
  const base = String(name ?? '').split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 && PROGRAM_EXTS.has(base.slice(dot + 1).toLowerCase()) ? base.slice(0, dot) : base;
  return windows ? stem.toLowerCase() : stem;
}

/**
 * A module's own folder as a vault path (docs/MODULES.md: a module is a folder under
 * `.ose/app/modules/<id>/`). Read-only to the module, and where MODULES.md rule 6 has it ship
 * the scripts `run` starts, so it is a legal `cwd` as well as the module's `data`. A host
 * started with `--rice <dir>` serves the rice from outside the vault; there this path is not
 * where the module lives, and a `cwd` has to be one of its `data` folders instead.
 */
export const moduleHome = (id) => `.ose/app/modules/${id}`;

/* --------------------------------------------------------------------------- where the rice is */

/**
 * The folder the rice is served from. In the host this is `app.localhost` (or `app://localhost`
 * on macOS), which the host tells us through `platformInfo().appOrigin`. In the browser dev
 * server the rice is a folder of the repo served by Vite, so the base is a path on the same
 * origin. Nothing above this line spells an origin; this is the only function that knows one.
 */
let baseUrl = null;
export function setRiceBase(url) { baseUrl = String(url || '').replace(/\/+$/, ''); }
export function riceBase() { return baseUrl; }

async function resolveBase() {
  if (baseUrl !== null) return baseUrl;
  try {
    const info = await bridge.platformInfo();
    if (info && info.appOrigin) { baseUrl = String(info.appOrigin).replace(/\/+$/, ''); return baseUrl; }
  } catch { /* the browser dev server, or a host that does not answer it */ }
  // Browser dev: the page itself is the rice's index.html, so the rice is the folder it is in.
  baseUrl = typeof location !== 'undefined' ? location.href.replace(/[^/]*$/, '').replace(/\/+$/, '') : '';
  return baseUrl;
}

const json = async (url) => {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  // The dev server answers a missing file with the rice's index.html and a 200 (the SPA
  // fallback); say what is missing instead of failing on a '<'.
  const type = res.headers.get('content-type') || '';
  if (!/json/.test(type)) throw new Error(`no module.json at ${new URL(res.url).pathname}`);
  return res.json();
};

/**
 * Which modules the rice has. `cockpit.json` may name them (`"modules": ["day", "nsi"]`),
 * which is one request instead of a directory listing; otherwise the rice's `modules/` folder
 * is listed. In the host we can list it through the vault (the rice is `.ose/app`), and in the
 * browser dev the Vite middleware answers a directory with JSON; either way a rice that names
 * its modules is the reliable path and the one the stock rice takes.
 */
async function discover(base) {
  try {
    const cockpit = await json(`${base}/cockpit.json`);
    if (Array.isArray(cockpit.modules)) return cockpit.modules.map(String);
  } catch { /* no cockpit.json, or it does not list them */ }
  try {
    const listing = await json(`${base}/modules/index.json`);
    if (Array.isArray(listing)) return listing.map(String);
    if (listing && Array.isArray(listing.modules)) return listing.modules.map(String);
  } catch { /* no index */ }
  // The vault path, for a host that serves the rice out of `.ose/app`.
  try {
    const rows = await bridge.list('.ose/app/modules');
    return rows.filter((r) => r.kind === 'dir' && !r.name.startsWith('.')).map((r) => r.name);
  } catch { /* the rice is not in this vault */ }
  return [];
}

/* ------------------------------------------------------------------------------- the facade */

/**
 * Build the object a module's `activate` receives. `ose` is the unscoped kernel object;
 * `entry` is the loader's record for this module and collects every unsubscribe.
 */
export function makeFacade(ose, entry) {
  const { manifest, id } = entry;
  const data = (manifest.data || []).map(clean).filter((p) => p !== '');
  const allow = (manifest.run || []).map(String);
  const readAll = data.length === 0;   // no `data`: read the vault, write nothing

  const canRead = (path) => readAll || data.some((d) => isUnder(path, d));
  const canWrite = (path) => !readAll && data.some((d) => isUnder(path, d));
  const guardRead = (path) => { if (!canRead(path)) throw notAllowed(`read ${clean(path)}`); return clean(path); };
  const guardWrite = (path) => { if (!canWrite(path)) throw notAllowed(`write ${clean(path)}`); return clean(path); };
  // Where a process may start: the module's data, or the module's own folder — the one
  // MODULES.md rule 6 tells it to ship its scripts in, so `ose.run('python', ['-m', …],
  // { cwd: ose.module.folder })` is the documented invocation and not a violation.
  const home = moduleHome(id);
  const canRunIn = (path) => canRead(path) || isUnder(path, home);

  // Every registration is remembered so `unload` can take it all back.
  const keep = (off) => { if (typeof off === 'function') entry.offs.push(off); return off; };

  const files = {};
  // `assetUrl` is the one synchronous call in `files`: it goes straight into an `<img src>`,
  // so it throws where the others reject.
  files.assetUrl = (path) => ose.files.assetUrl(guardRead(path));
  for (const name of ['read', 'readBinary', 'list', 'stat', 'exists', 'reveal', 'open']) {
    files[name] = (path, ...rest) => {
      let p;
      try { p = guardRead(path); } catch (e) { return Promise.reject(e); }
      return ose.files[name](p, ...rest);
    };
  }
  for (const name of ['write', 'append', 'writeBinary', 'mkdir', 'trash']) {
    files[name] = (path, ...rest) => {
      let p;
      try { p = guardWrite(path); } catch (e) { return Promise.reject(e); }
      return ose.files[name](p, ...rest);
    };
  }
  files.rename = (from, to) => {
    try { guardWrite(from); guardWrite(to); } catch (e) { return Promise.reject(e); }
    return ose.files.rename(clean(from), clean(to));
  };
  files.tree = () => ose.files.tree();
  files.versions = {
    keep: (path, text, force) => { try { guardWrite(path); } catch (e) { return Promise.reject(e); } return ose.files.versions.keep(clean(path), text, force); },
    list: (path) => { try { guardRead(path); } catch (e) { return Promise.reject(e); } return ose.files.versions.list(clean(path)); },
    read: (path, vid) => { try { guardRead(path); } catch (e) { return Promise.reject(e); } return ose.files.versions.read(clean(path), vid); },
    restore: (path, vid) => { try { guardWrite(path); } catch (e) { return Promise.reject(e); } return ose.files.versions.restore(clean(path), vid); },
  };

  // `watch(fn)` for a module means "my own data", never the whole vault.
  const watch = (a, b) => {
    const asked = typeof a === 'function' ? null : (Array.isArray(a) ? a : [a]).map(clean).filter(Boolean);
    const fn = typeof a === 'function' ? a : b;
    const folders = asked === null ? data : asked.filter((f) => canRead(f));
    return keep(folders.length ? ose.watch(folders, fn) : ose.watch(() => {}));
  };

  // The id is minted here rather than inside `ose.run`, so the module's own process table is
  // right from before the call leaves: `run.kill` can only ever reach a process this module
  // started, and `unload` kills exactly those.
  const run = (cmd, args, opts = {}) => {
    // The host's normalisation, not an exact string match: a settings field that says "a full
    // path works" has to work on this side too, and a facade stricter than the host refuses
    // calls the host would have run.
    const windows = ose.platform !== 'macos' && ose.platform !== 'linux';
    const key = programKey(cmd, windows);
    if (!allow.some((a) => programKey(a, windows) === key)) return Promise.reject(notAllowed(`run ${cmd}`));
    if (opts.cwd !== undefined && !canRunIn(opts.cwd)) return Promise.reject(notAllowed(`run in ${clean(opts.cwd)}`));
    const pid = opts.id || `${entry.id}.${uid()}`;
    entry.procs.add(pid);
    return kernelRun(cmd, args, { ...opts, id: pid, allow })
      .finally(() => entry.procs.delete(pid));
  };
  run.kill = (pid) => (entry.procs.has(pid) ? kernelRun.kill(pid) : Promise.reject(notAllowed(`kill ${pid}`)));

  const routes = (manifest.routes || []).map(String);
  const ownsPattern = (pattern) => !routes.length || routes.includes(String(pattern));

  return {
    ...ose,
    // `folder` is the module's own folder as a vault path, so a `run` call can name it without
    // spelling `.ose/app/modules/<id>` itself.
    module: { id, name: manifest.name || id, manifest, folder: home },
    files,
    watch,
    run,
    // One key in .ose/state.json, named after the module, and the module cannot reach another.
    state: (key) => ose.state(`modules.${id}${key ? '.' + key : ''}`),
    commands: {
      ...ose.commands,
      register: (cmd) => keep(ose.commands.register({ ...cmd, module: id })),
    },
    views: { ...ose.views, register: (name, def) => keep(ose.views.register(name, { ...def, module: id })) },
    tiles: { ...ose.tiles, register: (def) => keep(ose.tiles.register({ ...def, module: id })) },
    keys: { ...ose.keys, bind: (...a) => keep(ose.keys.bind(...a)) },
    bus: { ...ose.bus, on: (...a) => keep(ose.bus.on(...a)) },
    status: ose.status,
    settings: {
      ...ose.settings,
      section: (def) => keep(ose.settings.section({ ...def, module: id })),
    },
    route: {
      ...ose.route,
      own: (pattern, mount) => {
        if (!ownsPattern(pattern)) throw notAllowed(`route ${pattern}`);
        return keep(ose.route.own(pattern, mount));
      },
      index: (pattern, fn) => {
        if (!ownsPattern(pattern)) throw notAllowed(`route ${pattern}`);
        return keep(ose.route.index(pattern, fn));
      },
      on: (fn) => keep(ose.route.on(fn)),
    },
    schedule: (sid, spec, fn) => keep(ose.schedule(`${id}.${sid}`, spec, fn)),
  };
}

/* -------------------------------------------------------------------------------- loading */

async function loadOne(ose, base, id) {
  const entry = { id, name: id, manifest: null, base: `${base}/modules/${id}`, state: 'disabled', error: null, offs: [], procs: new Set(), mod: null };
  loaded.set(id, entry);
  const manifest = await json(`${entry.base}/module.json`);
  entry.manifest = manifest;
  entry.name = manifest.name || id;
  if (manifest.id && String(manifest.id) !== id) throw new Error(`module.json id "${manifest.id}" is not the folder name "${id}"`);
  const requires = Number.isFinite(manifest.requires) ? manifest.requires : 1;
  if (requires > API) throw new Error(`needs ose.api ${requires}, this kernel is ${API}`);
  const mod = await import(/* @vite-ignore */ `${entry.base}/${manifest.entry || 'index.js'}`);
  entry.mod = mod;
  if (typeof mod.activate !== 'function') throw new Error('the entry exports no activate()');
  await mod.activate(makeFacade(ose, entry));
  entry.state = 'active';
  return entry;
}

/** Take back everything a module registered, kill what it started, call `deactivate`. */
export function unload(id) {
  const entry = loaded.get(id);
  if (!entry) return false;
  for (const off of entry.offs.reverse()) { try { off(); } catch (e) { console.error(`[module:${id}] unsubscribe`, e); } }
  entry.offs = [];
  for (const pid of entry.procs) { try { void kernelRun.kill(pid); } catch { /* going away */ } }
  entry.procs.clear();
  if (entry.mod && typeof entry.mod.deactivate === 'function') {
    try { entry.mod.deactivate(); } catch (e) { console.error(`[module:${id}] deactivate`, e); }
  }
  entry.state = 'disabled';
  return true;
}

export function unloadAll() { for (const id of [...loaded.keys()]) unload(id); }

/**
 * `ose.modules.load()` (docs/RICE.md step 4): the rice calls it once, after its shell exists.
 * Every module is loaded independently: one that throws is disabled, named in a toast and in
 * `list()`, and the others still activate. Resolves to the same rows `list()` answers.
 */
export async function load(ose, ids = null) {
  const base = await resolveBase();
  const names = ids || await discover(base);
  await Promise.all(names.map(async (id) => {
    try {
      await loadOne(ose, base, id);
    } catch (e) {
      const entry = loaded.get(id) || { id, name: id, state: 'disabled', offs: [], procs: new Set() };
      // Half a module is worse than none: whatever it managed to register before it threw is
      // taken back, so a failed activate leaves no orphan command in the palette.
      entry.error = String(e && e.message ? e.message : e);
      loaded.set(id, entry);
      unload(id);
      entry.error = String(e && e.message ? e.message : e);
      entry.state = 'disabled';
      console.error(`[module:${id}]`, e);
      try { toast(`module ${id} is disabled: ${entry.error}`, 'err', 6000); } catch { /* no DOM */ }
    }
  }));
  return list();
}

export function list() {
  return [...loaded.values()].map((m) => {
    const row = { id: m.id, name: m.name, state: m.state };
    if (m.error) row.error = m.error;
    return row;
  });
}

export function get(id) { return loaded.get(id) || null; }
