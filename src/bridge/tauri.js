// Tauri 2 adapter: one `rpc` command for everything the host owns, Tauri's own APIs for the
// window. See TAURI.md ("The RPC", "Events", "Window") and CONTRACT.md for the shapes.
//
// The facade (bridge/index.js) only needs `call` and `subscribe`; `win`, `platform` and
// `assetUrl` are extras it delegates to when an adapter provides them, because window control
// is not routed through rpc here and the vault asset origin differs per platform.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// CONTRACT.md edge names -> Tauri's ResizeDirection strings.
const RESIZE = {
  top: 'North',
  bottom: 'South',
  left: 'West',
  right: 'East',
  topleft: 'NorthWest',
  topright: 'NorthEast',
  bottomleft: 'SouthWest',
  bottomright: 'SouthEast',
};

const encodePath = (path) =>
  String(path ?? '').replace(/^\.?\//, '').split('/').map(encodeURIComponent).join('/');

// Tauri serves custom protocols over http://<scheme>.localhost on Windows and <scheme>:// elsewhere.
export function vaultUrl(path, platform) {
  const p = encodePath(path);
  return platform === 'windows' ? `http://vault.localhost/${p}` : `vault://localhost/${p}`;
}

// Closing: the window is destroyed once every `closing` handler has settled, but never before
// CLOSE_FLOOR (a handler that returns nothing, like the router's state flush today, still
// gets the time the old flat delay gave it) and never later than CLOSE_CEILING (a hung save
// must not make the window unclosable).
const CLOSE_FLOOR = 400;
const CLOSE_CEILING = 3000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function create() {
  const w = getCurrentWindow();
  const subs = new Set();
  // Returns the flat list of what the subscribers returned; the facade's dispatch returns its
  // handlers' results as an array, so the closing path below can await them.
  const fanout = (msg) => {
    const out = [];
    for (const fn of [...subs]) {
      try {
        const r = fn(msg);
        if (Array.isArray(r)) out.push(...r); else if (r !== undefined) out.push(r);
      } catch (e) { console.error('[bridge] subscriber threw', e); }
    }
    return out;
  };

  const rpc = (cmd, args = []) => invoke('rpc', { cmd, args });

  // ---------------------------------------------------------------- host events
  // Payloads are already the contract's `data`; the facade wants {event, data}.
  const forward = (name) =>
    listen(name, (e) => fanout({ event: name, data: e.payload }))
      .catch((err) => console.error(`[bridge] listen(${name}) failed`, err));
  forward('fs');
  forward('update');

  // ---------------------------------------------------------------- window events
  let maximized = false;
  let focused = typeof document !== 'undefined' ? document.hasFocus() : true;
  try { maximized = await w.isMaximized(); } catch { /* window API not ready */ }

  const pushWindow = () => fanout({ event: 'window', data: { maximized, focused } });

  // Resize fires per frame while dragging; isMaximized is an IPC round trip, so ask once the
  // gesture settles and only tell the app when the answer actually changed.
  let resizeTimer = null;
  const queryMaximized = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      resizeTimer = null;
      let m;
      try { m = await w.isMaximized(); } catch { return; }
      if (m === maximized) return;
      maximized = m;
      pushWindow();
    }, 120);
  };

  w.onResized(queryMaximized).catch((e) => console.error('[bridge] onResized', e));
  w.onFocusChanged(({ payload }) => { focused = !!payload; pushWindow(); })
    .catch((e) => console.error('[bridge] onFocusChanged', e));

  // The first close attempt is turned into a 'closing' notice; the window is destroyed once
  // the handlers' promises have settled (floor and ceiling above). A flat 400ms used to be
  // the whole wait, and a save that took longer — a slow disk, a sync client holding the
  // file — was cut off with the process (batch 9, B2). `preventDefault` has to run before the
  // first await: Tauri reads the flag when the handler returns.
  let closing = false;
  w.onCloseRequested(async (e) => {
    if (closing) return; // a second attempt while the first is still settling: let Tauri close it
    closing = true;
    e.preventDefault();
    const pending = fanout({ event: 'window', data: { closing: true } })
      .filter((r) => r && typeof r.then === 'function');
    const [outcome] = await Promise.all([
      Promise.race([Promise.allSettled(pending), delay(CLOSE_CEILING).then(() => 'timeout')]),
      delay(CLOSE_FLOOR),
    ]);
    if (outcome === 'timeout') console.warn('[bridge] closing handlers did not settle in time');
    // A handler that resolved `false` vetoes the close: the editor does this when the last
    // save needs an answer (the file changed on disk). Its dialog is up; the user answers and
    // closes again, which starts this over.
    if (Array.isArray(outcome) && outcome.some((r) => r.status === 'fulfilled' && r.value === false)) {
      closing = false;
      return;
    }
    w.destroy().catch((err) => console.error('[bridge] destroy', err));
  }).catch((e) => console.error('[bridge] onCloseRequested', e));

  // ---------------------------------------------------------------- platform
  let platform = 'windows';
  try {
    const info = await rpc('platform');
    if (info && typeof info.os === 'string') platform = info.os;
  } catch (e) {
    console.warn('[bridge] platform lookup failed, assuming windows:', e?.message || e);
  }

  return {
    call: (cmd, args) => rpc(cmd, args || []),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

    platform,
    assetUrl: (path) => vaultUrl(path, platform),

    // Window commands never reach the Rust rpc dispatcher.
    win: {
      minimize: () => w.minimize(),
      maximize: () => w.toggleMaximize(),
      close: () => w.close(),
      isMaximized: () => w.isMaximized(),
      startDrag: () => w.startDragging(),
      startResize: (edge) => {
        const dir = RESIZE[String(edge || '').toLowerCase()];
        if (!dir) return Promise.reject(new Error('unknown resize edge: ' + edge));
        return w.startResizeDragging(dir);
      },
      setTheme: (theme) => w.setTheme(theme === 'light' || theme === 'dark' ? theme : null),
    },
  };
}
