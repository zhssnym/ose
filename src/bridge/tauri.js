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

export async function create() {
  const w = getCurrentWindow();
  const subs = new Set();
  const fanout = (msg) => {
    for (const fn of [...subs]) {
      try { fn(msg); } catch (e) { console.error('[bridge] subscriber threw', e); }
    }
  };

  const rpc = (cmd, args = []) => invoke('rpc', { cmd, args });

  // ---------------------------------------------------------------- host events
  // Payloads are already the contract's `data`; the facade wants {event, data}.
  const forward = (name) =>
    listen(name, (e) => fanout({ event: name, data: e.payload }))
      .catch((err) => console.error(`[bridge] listen(${name}) failed`, err));
  forward('fs');

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

  // The app needs a moment to flush pending saves and state, so the first close attempt is
  // turned into a 'closing' notice and the window is destroyed 400ms later (TAURI.md).
  let closing = false;
  w.onCloseRequested((e) => {
    if (closing) return; // a second attempt: let Tauri close it
    closing = true;
    e.preventDefault();
    fanout({ event: 'window', data: { closing: true } });
    setTimeout(() => { w.destroy().catch((err) => console.error('[bridge] destroy', err)); }, 400);
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
