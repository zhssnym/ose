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

// Closing: the window is destroyed once every `closing` handler has settled, and not before.
// CLOSE_FLOOR is the minimum (a handler that returns nothing, like the router's state flush,
// still gets the time the old flat delay gave it). There is deliberately no ceiling any more
// (S28): a save that is slow — a big file, a sync client holding it, a network drive — used to
// be cut off at three seconds along with the process, which is the one thing an editor must
// never do. After CLOSE_NOTICE the window says it is still saving and keeps waiting; the save
// itself decides when it is done, and a save that fails vetoes the close with its own message.
const CLOSE_FLOOR = 400;
const CLOSE_NOTICE = 3000;
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
  // A second launch that named another folder: the host has adopted it and the page reloads
  // into it (S14). One window per vault, so this is how the other vault arrives.
  forward('vault');
  // `ose.run` (K1a): one event per line of a child's stdout or stderr, then one with
  // `done: true`. The http adapter forwards whatever the SSE stream names, so this list is
  // the only place the Tauri side has to be told.
  forward('run');

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
    // A second attempt while the first is still settling is vetoed too, and says so. Falling
    // through used to let Tauri destroy the window with the first attempt's save still in
    // flight — the exact failure S28 exists to remove, with an impatient second click as the
    // trigger instead of a timer. The first attempt's `finally` does the destroy.
    if (closing) {
      e.preventDefault();
      console.warn('[bridge] close is already in progress; the save decides when it is done');
      return;
    }
    closing = true;
    e.preventDefault();
    const pending = fanout({ event: 'window', data: { closing: true } })
      .filter((r) => r && typeof r.then === 'function');

    // Past three seconds the window is still there and nothing on screen says why. One toast,
    // which stays up until the save settles, is the whole notice.
    let dismiss = null;
    const notice = setTimeout(async () => {
      try {
        const { toast } = await import('../dialog.js');
        dismiss = toast('still saving…', 'warn', 10 * 60 * 1000);
      } catch { /* no shell (the self-test page): the console line is enough */ }
      console.warn('[bridge] a closing handler is taking longer than 3s; waiting');
    }, CLOSE_NOTICE);

    let outcome;
    try {
      [outcome] = await Promise.all([Promise.allSettled(pending), delay(CLOSE_FLOOR)]);
    } finally {
      clearTimeout(notice);
      if (dismiss) dismiss();
    }

    // A handler that resolved `false` vetoes the close: the editor does this when the last
    // save needs an answer (the file changed on disk), and when the save itself failed. Its
    // dialog or its toast is up; the user answers and closes again, which starts this over.
    if (outcome.some((r) => r.status === 'fulfilled' && r.value === false)) {
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
      // The window title says what is open, the way every editor's does (S13). The document
      // title follows it too, so the two never disagree.
      setTitle: (text) => {
        const s = String(text ?? '');
        try { document.title = s; } catch { /* no document: nothing to mirror */ }
        return w.setTitle(s);
      },
    },
  };
}
