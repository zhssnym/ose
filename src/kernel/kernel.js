// `ose:kernel` (docs/KERNEL.md). One object, composed from the files beside this one, and
// nothing else exported. The kernel never draws and knows no view and no file of the shell: it
// serves and it answers.
//
// Everything that touches the host is async and goes through `./bridge/index.js`. Everything
// that is a registry (commands, views, tiles, status, settings sections) lives in
// `./registry.js` and `./settings-core.js`. The router is `./router.js`, which reaches the
// page editor through `./pagehost.js` so that `ose:editor` stays a separate bundle.

import { bus, store, commands, views, tiles, status, uid, debounce, esc } from './registry.js';
import { bridge } from './bridge/index.js';
import * as router from './router.js';
import * as linksLib from './links.js';
import { linkTarget, relativeHref } from './href.js';
import * as locate from './locate.js';
import * as settingsCore from './settings-core.js';
import { patchState, stateCache, loadState, flushState } from './state.js';
import { themePref, setTheme, resolvedTheme, initTheme } from './theme.js';
import { KEYMAP, BODY_KEYS, shortcutFor, bindKey, comboLabel, initKeys } from './keys.js';
import { watch } from './watch.js';
import { run, killAll } from './run.js';
import { schedule, cancelAll as cancelSchedules } from './schedule.js';
import * as plugins from './plugins.js';
import { setPageHost, setPageList, pageList } from './pagehost.js';
import * as focusLib from './focus.js';
import { toast } from './dialog.js';

// `ose:ui` is a facade over this bundle (see ./ui-surface.js): the names are exported here so
// there is one overlay stack, one toast queue and one icon set in a running Ose.
export * from './ui-surface.js';

export const API = 2;

/* ------------------------------------------------------------------------------- the stamp */

// Vite replaces these at build time (vite.kernel.config.js `define`). In the browser dev
// server they are the dev defaults, which is the honest answer there.
const VERSION = {
  kernel: typeof __OSE_VERSION__ === 'string' ? __OSE_VERSION__ : '0.0.0-dev',
  sha: typeof __OSE_SHA__ === 'string' ? __OSE_SHA__ : 'dev',
  short: typeof __OSE_SHORT__ === 'string' ? __OSE_SHORT__ : 'dev',
  date: typeof __OSE_DATE__ === 'string' ? __OSE_DATE__ : '',
};

/* ------------------------------------------------------------------------------ the origins */

// The one place in the whole JavaScript side that holds an origin, and it is told one by the
// host rather than spelling it (docs/KERNEL.md "Origins"). Until `ready` resolves, an asset
// URL falls back to the page's own origin, which is right in the browser dev server.
let origins = { kernel: '', app: '', vault: '' };

const assets = {
  url(name) {
    const base = origins.kernel || (typeof location !== 'undefined' ? location.origin : '');
    return `${base}/${String(name || '').replace(/^\/+/, '')}`;
  },
  origins: () => ({ ...origins }),
};

/* ---------------------------------------------------------------------------------- bytes */

const B64 = typeof atob === 'function';

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v);
  if (typeof v !== 'string') return new Uint8Array(0);
  if (!B64) return new Uint8Array(0);
  const bin = atob(v);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(v) {
  if (typeof v === 'string') return v;                 // already base64
  const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
  let bin = '';
  // In chunks: `String.fromCharCode(...bytes)` blows the argument limit on anything large.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* --------------------------------------------------------------------------------- booting */

let vaultInfo = { root: null, name: null };

const ready = (async () => {
  await bridge.ready;
  // The host's own description of itself, and the vault it resolved. Neither throws the boot:
  // a kernel that cannot reach the host still answers, and the shell shows what it shows.
  try {
    const info = await bridge.platformInfo();
    if (info) {
      if (info.os) ose.platform = info.os === 'win' ? 'windows' : info.os === 'mac' ? 'macos' : info.os;
      origins = {
        kernel: String(info.kernelOrigin || '').replace(/\/+$/, ''),
        app: String(info.appOrigin || '').replace(/\/+$/, ''),
        vault: String(info.vaultOrigin || '').replace(/\/+$/, ''),
      };
      if (origins.app) plugins.setBase(origins.app);
    }
  } catch (e) { console.warn('[kernel] platform', e); }
  try { await loadState(); } catch (e) { console.warn('[kernel] state', e); }
  try { focusLib.loadFocus(stateCache()); focusLib.initFocus(); } catch (e) { console.warn('[kernel] focus', e); }
  try {
    const info = await bridge.rootInfo();
    vaultInfo = { root: (info && info.root) || null, name: (info && info.name) || null };
    store.set('root', vaultInfo);
  } catch (e) { console.warn('[kernel] rootInfo', e); }
  // 0.5.0's boot handshake: the host armed a timer when it navigated the window to the page
  // and this call cancelled it. The 1.0.0 host does not implement `riceReady` any more, so it
  // answers null and nothing here depends on it. `riceReady` is that host command's
  // historical name.
  try { await bridge.riceReady(); } catch { /* a host that does not answer it, or the dev server */ }
})();

/* ------------------------------------------------------------------------------- the object */

export const ose = {
  api: API,
  version: VERSION,
  platform: 'windows',
  ready,

  /** 'tauri' | 'webview' | 'browser': whether the window buttons, quit and drag are live. */
  host: bridge.kind === 'http' ? 'browser' : bridge.kind,

  vault: {
    get root() { return vaultInfo.root; },
    get name() { return vaultInfo.name; },
    /** `{root, name, remembered, source, exeDir}`; exeDir is the chooser's suggestion. */
    info: async () => {
      const [v, p] = await Promise.all([bridge.vaultInfo(), bridge.platformInfo().catch(() => null)]);
      return { ...(v || {}), exeDir: (p && p.exeDir) || null };
    },
    /** A second launch named another folder and the host adopted it: the page reloads. */
    onChange: (fn) => bridge.on('vault', (d) => (d && d.changed ? fn(d) : undefined)),
    pick: () => bridge.pickVault(),
    recent: () => bridge.recentVaults(),
    open: (path) => bridge.openVault(path),
    forget: (path) => bridge.forgetVault(path),
  },

  files: {
    read: (path) => bridge.readText(path),
    write: (path, text) => bridge.writeText(path, text),
    append: (path, text) => bridge.appendText(path, text),
    // The host speaks base64 over the RPC; KERNEL.md promises bytes out and takes either in.
    readBinary: (path) => bridge.readBinary(path).then(toBytes),
    writeBinary: (path, bytes) => bridge.writeBinary(path, toBase64(bytes)),
    list: (path) => bridge.list(path),
    tree: () => bridge.tree(),
    stat: (path) => bridge.stat(path),
    exists: (path) => bridge.exists(path),
    mkdir: (path) => bridge.mkdir(path),
    rename: (from, to) => bridge.rename(from, to),
    // The destination is the user's setting, not the caller's: `system` (the recycle bin) or
    // `vault` (`.trash` inside the vault), exactly as the sidebar has always passed it.
    trash: (path) => bridge.trash(path, { mode: settingsCore.trashMode() }),
    reveal: (path) => bridge.reveal(path),
    open: (path) => bridge.openPath(path),
    assetUrl: (path) => bridge.assetUrl(path),
    versions: {
      keep: (path, text, force = false) => bridge.versionKeep(path, text, force),
      list: (path) => bridge.versionList(path),
      read: (path, id) => bridge.versionRead(path, id),
      restore: (path, id) => bridge.versionRestore(path, id),
    },
  },

  watch,
  run,
  schedule,
  assets,

  route: {
    current: () => router.currentRoute(),
    navigate: (route, opts) => router.navigate(route, opts),
    back: () => router.back(),
    forward: () => router.forward(),
    canBack: () => router.canBack(),
    canForward: () => router.canForward(),
    close: (opts) => router.clearRoute(opts),
    reopenClosed: () => router.reopenClosed(),
    recent: () => router.recentFiles(),
    own: (pattern, mount) => router.own(pattern, mount),
    index: (pattern, fn) => router.registerIndex(pattern, fn),
    // What every `route.index` registration answers right now: [{ path, title, pattern }].
    // Quick open is the shell's, so it reads this and offers the rows beside its own pages
    // (docs/KERNEL.md `route.index`).
    indexed: () => router.ownedIndex(),
    // The window title of the owned route on screen, once the plugin knows it.
    title: (text) => router.setOwnTitle(text),
    on: (fn) => router.onRoute(fn),
    // The shell mounts the router into its page column; nothing else may. `{ start: false }`
    // skips the empty surface the mount draws, for a shell that opens on a home of its own.
    init: (el, opts) => router.initRouter(el, opts),
  },

  commands,
  views,
  tiles,
  status,

  keys: {
    bind: (combo, commandId, opts) => bindKey(combo, commandId, opts),
    shortcutFor,
    defaults: () => KEYMAP.concat(BODY_KEYS),
    label: comboLabel,
  },

  settings: {
    get: () => settingsCore.settings(),
    set: (partial) => settingsCore.save(partial),
    on: (fn) => settingsCore.onSettings(fn),
    section: (def) => settingsCore.sections.register(def),
    sections: () => settingsCore.sections.list(),
    apply: () => settingsCore.applySettings(),
    zoom: settingsCore.zoom,
    setZoom: settingsCore.setZoom,
    onRepaint: settingsCore.onRepaint,
  },

  /**
   * `ose.state(key)` — editor-only state in `.ose/state.json`, one key per plugin or shell
   * concern, written debounced. A dotted key is a path into the object, so a plugin's
   * `plugins.<id>` subtree never collides with the shell's.
   */
  state(key) {
    const path = String(key).split('.').filter(Boolean);
    const readAt = () => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), stateCache());
    return {
      get: () => readAt(),
      set(value) {
        if (path.length === 1) { patchState({ [path[0]]: value }); return; }
        const rootKey = path[0];
        const next = { ...(stateCache()[rootKey] || {}) };
        let at = next;
        for (let i = 1; i < path.length - 1; i++) { at[path[i]] = { ...(at[path[i]] || {}) }; at = at[path[i]]; }
        at[path[path.length - 1]] = value;
        patchState({ [rootKey]: next });
      },
      flush: () => flushState(),
    };
  },

  bus,
  store,

  search: (query, opts = {}) => bridge.search(query, opts),

  links: {
    resolve: (fromPath, href) => linkTarget(fromPath, href),
    href: (fromPath, target) => relativeHref(fromPath, target),
    inbound: (path) => linksLib.findInbound(path),
    rewriteMoved: (pairs) => linksLib.rewriteInboundMany(pairs),
  },

  /**
   * `ose.paths` (docs/PLUGINS.md): nothing spells a vault path. An owner declares what it needs
   * by name and asks for it by key; the kernel finds it in the tree, asks the user once when the
   * name is not enough, and keeps the answer. A plugin is handed `of(<its id>)` and sees only
   * its own keys; the shell declares its own under the owner `app`.
   */
  paths: {
    declare: (owner, specs) => locate.declare(owner, specs),
    of: (owner) => locate.of(owner),
    all: () => locate.all(),
    /** Every change, whoever owns it; the scoped `on` only hears its own owner's. */
    on: (fn) => locate.onAny(fn),
  },

  theme: {
    get: () => themePref(),
    set: (next) => setTheme(next),
    resolved: () => resolvedTheme(),
    on: (fn) => bus.on('theme', fn),
  },

  /**
   * The markdown pages the shell offers: quick open, the page picker and the editor's `[[`
   * menu all ask here, so all three offer the same rows. The shell registers the list through
   * `setPageList` (the sidebar narrows it to the focused folder); with nothing registered the
   * vault is walked instead.
   */
  async pages({ owned = false } = {}) {
    const provider = pageList();
    const out = [];
    if (provider) {
      out.push(...(await provider()));
    } else {
      const walk = (n) => {
        if (!n || !n.children) return;
        for (const c of n.children) {
          if (c.kind === 'dir') walk(c);
          else if (/\.md$/i.test(c.name)) out.push(c.path);
        }
      };
      walk(await bridge.tree());
    }
    // A plugin's own pages are not files and are opened as `{ type:'own' }`, so they are off
    // by default: the editor's `[[` menu and the link picker write a wikilink out of whatever
    // this answers, and a wikilink to a route is a broken link. A caller that draws rows
    // rather than links — quick open — asks for them.
    if (owned) {
      const seen = new Set(out);
      for (const row of router.ownedIndex()) if (!seen.has(row.path)) { seen.add(row.path); out.push(row.path); }
    }
    return out;
  },

  /**
   * The focused folder: what narrows the tree, the page list and where a new page is created.
   * The kernel keeps it because `ose.pages()` and `page.new` both need it; the sidebar UI
   * that sets it is the shell's.
   */
  focus: {
    get: () => focusLib.getFocus(),
    set: (path) => focusLib.setFocus(path),
    exit: () => focusLib.exitFocus(),
    name: () => focusLib.focusName(),
    isUnder: (path) => focusLib.isUnderFocus(path),
    defaultNewFolder: () => focusLib.defaultNewFolder(),
    on: (fn) => bus.on('focus', fn),
  },

  /**
   * Paper. `toPdf()` writes the window's document to a PDF with the print stylesheet and
   * resolves with `{path, bytes}`; with no argument the host asks where through the native save
   * dialog, `opts` being `{name, folder}` for it, and answers `{cancelled:true}` if the user
   * says no. `dialog()` opens the system print dialog, which is also the way to "Microsoft
   * Print to PDF", and resolves `{shown:true}` as soon as it is up.
   *
   * Neither ever calls `window.print()`: in WebView2 that blocks the renderer. A host that
   * cannot print answers `null` to both, which is how the caller knows to say so instead.
   */
  print: {
    toPdf: (path, opts) => bridge.printToPdf(path, opts),
    dialog: () => bridge.showPrintUI(),
  },

  /** An http/https/mailto link inside a note. The host refuses every other scheme. */
  openExternal: (url) => bridge.openExternal(url),

  window: {
    title: (text) => bridge.setTitle(text),
    minimize: () => bridge.win.minimize(),
    maximize: () => bridge.win.maximize(),
    close: () => bridge.win.close(),
    quit: () => bridge.quit(),
    isMaximized: () => bridge.win.isMaximized(),
    /** The frameless window's own title bar: start a native move. */
    drag: () => bridge.win.startDrag(),
    /** One of top right bottom left topleft topright bottomleft bottomright. */
    resize: (edge) => bridge.win.startResize(edge),
    /** The maximised half of the window event, for the button's glyph. */
    onMaximize: (fn) => bridge.on('window', (d) => (d && typeof d.maximized === 'boolean' ? fn(d.maximized) : undefined)),
    /**
     * The window is closing. `fn()` may return a promise and the host **awaits it** before the
     * window is destroyed, so the open page's last save finishes; resolving `false` keeps the
     * window open, which is what the editor does when the save needs an answer from the user.
     * A handler that throws is logged and counts as done: the close must never hang on a bug.
     */
    onClose: (fn) => bridge.on('window', (d) => (d && d.closing ? fn(d) : undefined)),
  },

  /**
   * `ose.plugins` (docs/PLUGINS.md): what is in `.ose/plugins` is what is loaded. The shell
   * calls `load()` once at boot; `list()` is what the sidebar, the home page and Settings draw;
   * `unload(id)` takes one down whole. Editing a plugin is: save the file, Ctrl+R.
   */
  plugins: {
    load: () => plugins.load(ose),
    list: () => plugins.list(),
    unload: (id) => plugins.unload(id),
    get: (id) => plugins.get(id),
    folder: plugins.FOLDER,
  },

  log: (text) => bridge.log(text),
  /**
   * `ose.reload()` (Ctrl+R, `app.reload`): the page again, and therefore every plugin from
   * disk. Editing a plugin is: save the file, press Ctrl+R, see the change.
   *
   * In the host the window is navigated back to the app's index.html, which is the host's job
   * because only it knows where that is. `reloadRice` is the host command's historical name,
   * kept on both sides; the host answers `reloadShell` too (docs/HOST.md "RPC"). In a browser
   * there is no host to do it and the call answers null; F5 is not an escape either, because
   * the key engine binds `mod+r` and swallows it. So a null answer, or no host at all, means
   * the page reloads itself.
   */
  async reload() {
    if (ose.host !== 'browser' && typeof bridge.reloadRice === 'function') {
      try {
        const answer = await bridge.reloadRice();
        if (answer !== null && answer !== undefined) return answer;
      } catch (e) { console.warn('[kernel] reloadRice', e); }
    }
    location.reload();
    return null;
  },

  /* The seams the shell fills: whoever draws a markdown page, and whoever knows the page list.
     Both are documented in ./pagehost.js; neither is something a plugin may call. */
  setPageHost,
  setPageList,

  /**
   * What the shell calls once, after its own surfaces exist: the key engine and the theme.
   * `start: false` mounts the router without drawing the empty surface, for a shell that opens
   * on a surface of its own and would otherwise flash the kernel's on every boot.
   */
  init({ page, keys = true, theme = true, start = true } = {}) {
    if (theme) initTheme();
    if (keys) initKeys();
    if (page) router.initRouter(page, { start });
  },

  // Small shared helpers the shell would otherwise write again.
  uid,
  debounce,
  esc,
  toast,
};

// One kill switch for everything a page started, so a reload or a vault change leaves nothing
// running (docs/PLUGINS.md: the processes a plugin started are killed).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { cancelSchedules(); killAll(); });
  window.__ose = ose;   // debugging only, exactly as `window.__bridge` has always been
}

export default ose;
