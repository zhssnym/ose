// The Tauri adapter: one typed command per host operation, called through the functions
// tauri-specta generated from the Rust host (`./bindings.ts`), and Tauri's own window API for
// the window. The facade (./index.ts) needs `invoke` and `subscribe`; `win`, `platform` and
// `assetUrl` are extras it delegates to.

import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { commands } from './bindings.ts';
import { HostError } from './errors.ts';
import { guessPlatform, vaultUrl } from './tauri-urls.ts';

type Adapter = import('../types.ts').Adapter;
type Msg = { event: string; data: any; };

/**
 * Why a call failed, as a HostError. The host's own refusal is `{code, message}`. Tauri itself
 * rejects with a string: "invalid args …" when serde could not read an argument (`bad_arg`),
 * "command y not found" when the name is not registered (`unknown_command`). Anything else is
 * `io`.
 */
export function rejected(name: string, e: unknown): HostError {
  if (e instanceof HostError) return e;
  if (e && typeof e === 'object' && 'code' in e && typeof (e as any).code === 'string' && (e as any).code) {
    const message = 'message' in e ? String((e as any).message ?? '') : '';
    return new HostError(message || (e as any).code, (e as any).code, name);
  }
  const text = e instanceof Error ? e.message : String(e ?? 'host error');
  if (/invalid args|missing (required|field)|invalid type|unknown variant/i.test(text)) return new HostError(text, 'bad_arg', name);
  if (/command \S+ not found|unknown command/i.test(text)) return new HostError(text, 'unknown_command', name);
  return new HostError(text, 'io', name);
}

/** One command by its JS name (Rust `read_file` is `readFile`), arguments positional. */
export async function invoke(name: string, args: unknown[] = []): Promise<unknown> {
  const table = commands as unknown as Record<string, unknown>;
  const fn = Object.hasOwn(table, name) ? table[name] : undefined;
  if (typeof fn !== 'function') throw new HostError(`no such command: ${name}`, 'unknown_command', name);
  let r: unknown;
  try {
    r = await (fn as (...a: unknown[]) => unknown)(...args);
  } catch (e) {
    throw rejected(name, e);
  }
  if (r && typeof r === 'object' && 'status' in r) {
    const o = r as { status: string; data?: unknown; error?: unknown; };
    if (o.status === 'error') throw rejected(name, o.error);
    if (o.status === 'ok' && 'data' in o) return o.data;
  }
  return r;
}

// Closing: the window is destroyed once every `closing` handler has settled, and not before.
// CLOSE_FLOOR is the minimum; there is no ceiling (S28): the save decides when it is done, and a
// save that fails vetoes the close with its own message. After CLOSE_NOTICE the window says it is
// still saving and keeps waiting.
const CLOSE_FLOOR = 400;
const CLOSE_NOTICE = 3000;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function create(): Promise<Adapter> {
  const w = getCurrentWebviewWindow();
  const subs: Set<(msg: Msg) => unknown> = new Set();
  // The flat list of what the subscribers returned, so the closing path can await them.
  const fanout = (msg: Msg): unknown[] => {
    const out: unknown[] = [];
    for (const fn of [...subs]) {
      try {
        const r = fn(msg);
        if (Array.isArray(r)) out.push(...r); else if (r !== undefined) out.push(r);
      } catch (e) { console.error('[bridge] subscriber threw', e); }
    }
    return out;
  };

  // Every event is emitted to its own window only, so this window listens on itself.
  const forward = (name: string) =>
    w.listen(name, (e) => fanout({ event: name, data: e.payload }))
      .catch((err) => console.error(`[bridge] listen(${name}) failed`, err));
  void forward('fs');
  // The OS asked this running window to open files or folders: `{ requests: OpenRequest[] }`.
  void forward('open');
  // A second launch that named another folder: the shell leaves the window and adopts it itself.
  void forward('vault');

  w.onFocusChanged(({ payload }) => { fanout({ event: 'window', data: { focused: !!payload } }); })
    .catch((e) => console.error('[bridge] onFocusChanged', e));

  // The first close attempt becomes a 'closing' notice; the window is destroyed once the
  // handlers' promises have settled. `preventDefault` runs before the first await.
  let closing = false;
  w.onCloseRequested(async (e) => {
    if (closing) {
      e.preventDefault();
      console.warn('[bridge] close is already in progress; the save decides when it is done');
      return;
    }
    closing = true;
    e.preventDefault();
    const pending = fanout({ event: 'window', data: { closing: true } })
      .filter((r) => !!r && typeof (r as { then?: unknown; }).then === 'function');

    let dismiss: null | (() => void) = null;
    const notice = setTimeout(async () => {
      try {
        const { holdStillSaving } = await import('../leave.ts');
        dismiss = holdStillSaving();
      } catch { /* no shell: the console line is enough */ }
      console.warn('[bridge] a closing handler is taking longer than 3s; waiting');
    }, CLOSE_NOTICE);

    let outcome: PromiseSettledResult<unknown>[] = [];
    try {
      [outcome] = await Promise.all([Promise.allSettled(pending), delay(CLOSE_FLOOR)]);
    } finally {
      clearTimeout(notice);
      const d = dismiss as null | (() => void);
      if (d) d();
    }

    // A handler that resolved `false` vetoes the close: its dialog or toast is up.
    if (outcome.some((r) => r.status === 'fulfilled' && r.value === false)) {
      closing = false;
      try { (await import('../leave.ts')).stayWindow(); } catch { /* nothing frozen */ }
      return;
    }
    w.destroy().catch((err) => console.error('[bridge] destroy', err));
  }).catch((e) => console.error('[bridge] onCloseRequested', e));

  let platform = guessPlatform();
  try {
    const info = (await invoke('platform')) as { os?: unknown; } | null;
    if (info && typeof info.os === 'string') platform = info.os;
  } catch (e) {
    console.warn('[bridge] platform lookup failed:', (e && (e as Error).message) || e);
  }

  return {
    invoke,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    platform,
    assetUrl: (path) => vaultUrl(path, platform),
    win: {
      close: () => w.close(),
      setTheme: (theme) => w.setTheme(theme === 'light' || theme === 'dark' ? theme : null),
      // No `closing` fan-out: `app.close-anyway`, after the user said so.
      destroy: () => w.destroy(),
      minimize: () => w.minimize(),
      toggleMaximize: () => w.toggleMaximize(),
      isMaximized: () => w.isMaximized(),
      onResized: (fn: () => void) => w.onResized(fn),
      startDragging: () => w.startDragging(),
      setTitle: (text) => {
        const s = String(text ?? '');
        try { document.title = s; } catch { /* no document */ }
        return w.setTitle(s);
      },
    },
  };
}
