// Tauri 2 adapter: one typed command per host operation, called through the functions
// tauri-specta generated (`./bindings.ts`), and Tauri's own APIs for the window. See
// docs/HOST.md "Commands".
//
// The facade (bridge/index.js) needs `invoke` and `subscribe`; `win`, `platform`, `assetUrl`
// and `dragOut` are extras it delegates to, because window control and drag out are not host
// commands and the vault asset origin differs per platform. This is the only file that imports
// the bindings, so a browser never loads `@tauri-apps/api` for nothing.
import { commands } from './bindings.ts';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { assetPath } from '../paths.js';
import { HostError } from './errors.js';

/** @typedef {import('../types.js').Adapter} Adapter */

/**
 * A command's answer as the facade reads it. A generated function answers
 * `{status:'ok', data}` or `{status:'error', error}` for a command that returns a Result, and
 * the value itself for one that cannot fail.
 * @typedef {{ status: 'ok', data: unknown } | { status: 'error', error: unknown }} Outcome
 */

/**
 * Why a call failed, as a HostError. The host's own refusal is `{code, message}`. Tauri itself
 * rejects with a string: "invalid args `x` for command `y`: …" when serde could not read an
 * argument (`bad_arg`), "command y not found" when the name is not registered
 * (`unknown_command`). Anything else is `io`.
 * @param {string} name
 * @param {unknown} e
 * @returns {HostError}
 */
export function rejected(name, e) {
  if (e instanceof HostError) return e;
  if (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' && e.code) {
    const message = 'message' in e ? String(e.message ?? '') : '';
    return new HostError(message || e.code, e.code, name);
  }
  const text = e instanceof Error ? e.message : String(e ?? 'host error');
  if (/invalid args|missing (required|field)|invalid type|unknown variant/i.test(text)) return new HostError(text, 'bad_arg', name);
  if (/command \S+ not found|unknown command/i.test(text)) return new HostError(text, 'unknown_command', name);
  return new HostError(text, 'io', name);
}

/**
 * One command by its JS name (Rust `read_file` is `readFile`), arguments positional. An unknown
 * name is a hard error, never a null.
 * @param {string} name
 * @param {unknown[]} [args]
 * @returns {Promise<unknown>}
 */
export async function invoke(name, args = []) {
  const table = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (commands));
  const fn = Object.hasOwn(table, name) ? table[name] : undefined;
  if (typeof fn !== 'function') throw new HostError(`no such command: ${name}`, 'unknown_command', name);
  /** @type {unknown} */
  let r;
  try {
    r = await fn(...args);
  } catch (e) {
    throw rejected(name, e);
  }
  if (r && typeof r === 'object' && 'status' in r) {
    const o = /** @type {Outcome} */ (r);
    // The generated wrapper hands back whatever Tauri rejected with that is not an Error: the
    // host's `{code, message}`, or Tauri's own string for an argument it could not read.
    if (o.status === 'error') throw rejected(name, o.error);
    if (o.status === 'ok' && 'data' in o) return o.data;
  }
  return r;
}

// Tauri serves custom protocols over http://<scheme>.localhost on Windows and <scheme>:// elsewhere.
/** @param {string} path @param {string} platform */
export function vaultUrl(path, platform) {
  const p = assetPath(path);
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
/** @param {number} ms */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {Promise<Adapter>} */
export async function create() {
  const w = getCurrentWebviewWindow();
  /** @type {Set<(msg: { event: string, data: any }) => unknown>} */
  const subs = new Set();
  // Returns the flat list of what the subscribers returned; the facade's dispatch returns its
  // handlers' results as an array, so the closing path below can await them.
  /** @param {{ event: string, data: any }} msg @returns {unknown[]} */
  const fanout = (msg) => {
    /** @type {unknown[]} */
    const out = [];
    for (const fn of [...subs]) {
      try {
        const r = fn(msg);
        if (Array.isArray(r)) out.push(...r); else if (r !== undefined) out.push(r);
      } catch (e) { console.error('[bridge] subscriber threw', e); }
    }
    return out;
  };

  // ---------------------------------------------------------------- host events
  // Every event is emitted to its own window only (`emit_to` the window's label), so this
  // window listens on itself: a global `listen` would also hear the other windows' vaults.
  // Payloads are already the contract's `data`; the facade wants {event, data}.
  /** @param {string} name */
  const forward = (name) =>
    w.listen(name, (e) => fanout({ event: name, data: e.payload }))
      .catch((err) => console.error(`[bridge] listen(${name}) failed`, err));
  forward('fs');
  // The OS asked this running window to open files or folders: `{ requests: OpenRequest[] }`
  // (../opens.js). A booting window takes its own with `takeOpens` instead.
  forward('open');
  // A second launch that named another folder: `{ requested:true, root, name }`. The host
  // only asks; the shell leaves the window and adopts it itself, so an unsaved page is never
  // switched out from under (C5). Kept until windows per vault pass G3.
  forward('vault');

  // ---------------------------------------------------------------- window events
  // The window has the platform's own title bar and buttons (X9): the page is told only
  // whether it has the focus, and when the window is closing (below).
  w.onFocusChanged(({ payload }) => { fanout({ event: 'window', data: { focused: !!payload } }); })
    .catch((e) => console.error('[bridge] onFocusChanged', e));

  // The first close attempt is turned into a 'closing' notice; the window is destroyed once
  // the handlers' promises have settled (floor above, no ceiling). `preventDefault` has to run
  // before the first await: Tauri reads the flag when the handler returns.
  let closing = false;
  w.onCloseRequested(async (e) => {
    // A second attempt while the first is still settling is vetoed too, and says so. Falling
    // through used to let Tauri destroy the window with the first attempt's save still in
    // flight — the exact failure S28 exists to remove. The first attempt does the destroy.
    if (closing) {
      e.preventDefault();
      console.warn('[bridge] close is already in progress; the save decides when it is done');
      return;
    }
    closing = true;
    e.preventDefault();
    const pending = fanout({ event: 'window', data: { closing: true } })
      .filter((r) => r && typeof (/** @type {{ then?: unknown }} */ (r)).then === 'function');

    // Past three seconds the window is still there and nothing on screen says why. One sticky
    // toast, shared with the leave gate's own (../leave.js), stays up until the save settles.
    /** @type {null | (() => void)} */
    let dismiss = null;
    const notice = setTimeout(async () => {
      try {
        const { holdStillSaving } = await import('../leave.js');
        dismiss = holdStillSaving();
      } catch { /* no shell: the console line is enough */ }
      console.warn('[bridge] a closing handler is taking longer than 3s; waiting');
    }, CLOSE_NOTICE);

    /** @type {PromiseSettledResult<unknown>[]} */
    let outcome = [];
    try {
      [outcome] = await Promise.all([Promise.allSettled(pending), delay(CLOSE_FLOOR)]);
    } finally {
      clearTimeout(notice);
      if (dismiss) (/** @type {() => void} */ (dismiss))();
    }

    // A handler that resolved `false` vetoes the close: the editor does this when the last
    // save needs an answer (the file changed on disk), and when the save itself failed. Its
    // dialog or its toast is up; the user answers and closes again, which starts this over.
    if (outcome.some((r) => r.status === 'fulfilled' && r.value === false)) {
      closing = false;
      // The leave gate may have said yes and frozen the pages before another handler said no:
      // the window stays, so they are handed back (idempotent when the gate itself refused).
      try { (await import('../leave.js')).stayWindow(); } catch { /* nothing frozen */ }
      return;
    }
    w.destroy().catch((err) => console.error('[bridge] destroy', err));
  }).catch((e) => console.error('[bridge] onCloseRequested', e));

  // ---------------------------------------------------------------- platform
  let platform = 'windows';
  try {
    const info = /** @type {{ os?: unknown } | null} */ (await invoke('platform'));
    if (info && typeof info.os === 'string') platform = info.os;
  } catch (e) {
    console.warn('[bridge] platform lookup failed, assuming windows:', (e && /** @type {Error} */ (e).message) || e);
  }

  return {
    invoke,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },

    platform,
    assetUrl: (path) => vaultUrl(path, platform),

    // Drag out (X8): the OS gets the files as copies, never as a move. `tauri-plugin-drag` is
    // loaded on the first drag, so a window that never drags never loads it.
    async dragOut(paths, icon) {
      if (!paths.length || !icon) return false;
      const { startDrag } = await import('@crabnebula/tauri-plugin-drag');
      await startDrag({ item: paths, icon, mode: 'copy' });
      return true;
    },

    // Window commands are Tauri's own window API, never host commands.
    win: {
      close: () => w.close(),
      setTheme: (theme) => w.setTheme(theme === 'light' || theme === 'dark' ? theme : null),
      // No `closing` fan-out: `app.close-anyway`, after the user said so.
      destroy: () => w.destroy(),
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
