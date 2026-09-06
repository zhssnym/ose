// The terminal itself: one xterm.js instance bound to one pty from the bridge.
// This file owns the xterm options and theme, the fit/resize loop, the pty wiring
// (ptyStart / ptyWrite / ptyResize / ptyKill and the `pty` event), the key handling and the
// vault-path link provider. `index.js` owns where the element lives and which commands exist.
//
// Nothing here knows about the view or the dock: it is a element with a `start(cwd)` on it.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { bus } from '../registry.js';
import { bridge } from '../bridge/index.js';

const FIT_DEBOUNCE = 60;
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.3;
const SCROLLBACK = 5000;

/* ------------------------------------------------------------------ colours */

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n) => clamp255(n).toString(16).padStart(2, '0');

/**
 * Token values come out of getComputedStyle as the raw text of the custom property
 * (`#D97757`, `rgba(217, 119, 87, .22)`), so they are parsed here rather than handed to xterm,
 * which only understands `#rgb` / `#rrggbb` / `#rrggbbaa`.
 */
function toHex(value, fallback) {
  const v = String(value || '').trim();
  if (!v) return fallback;
  if (v[0] === '#') {
    if (v.length === 4 || v.length === 5) return '#' + v.slice(1).split('').map((c) => c + c).join('');
    if (v.length === 7 || v.length === 9) return v.toLowerCase();
    return fallback;
  }
  const m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return fallback;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return fallback;
  const [r, g, b] = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p)));
  let out = '#' + hex2(r) + hex2(g) + hex2(b);
  if (parts.length > 3) {
    const a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if (Number.isFinite(a) && a < 1) out += hex2(a * 255);
  }
  return out;
}

const rgbOf = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** Mix `hex` towards `target` (#rrggbb) by `amount` (0..1). Alpha, if any, is dropped. */
function mix(hex, target, amount) {
  if (!/^#[0-9a-f]{6,8}$/i.test(hex)) return hex;
  const a = rgbOf(hex), b = rgbOf(target);
  return '#' + a.map((c, i) => hex2(c + (b[i] - c) * amount)).join('');
}

/**
 * The sixteen ANSI slots, drawn from tokens.css (CONTRACT batch 6). `black`/`white` come from
 * the --bg/--fg family, the hues from the semantic tokens.
 *
 * "Bright" means away from the page ground, not literally lighter: on the dark theme that is
 * towards white, on the ivory light theme a lighter red or green is unreadable, so brights are
 * mixed towards the foreground instead. Same rule for both, opposite directions.
 */
export function buildTheme() {
  const cs = getComputedStyle(document.documentElement);
  const T = (name, fallback) => toHex(cs.getPropertyValue(name), fallback);
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';

  const bg = T('--bg', dark ? '#1a1917' : '#faf9f5');
  const fg = T('--fg', dark ? '#ece9e1' : '#1f1e1d');
  const fg2 = T('--fg-2', dark ? '#a9a497' : '#5c5952');
  const fg3 = T('--fg-3', dark ? '#77736a' : '#8f8b7f');
  const bg3 = T('--bg-3', dark ? '#2a2925' : '#e9e6dc');

  const red = T('--err', '#b5432f');
  const green = T('--ok', '#6e8b5a');
  const yellow = T('--warn', '#c29a2b');
  const blue = T('--info', '#5b7a9e');
  const magenta = T('--c-hum', '#9e6b8e');
  const cyan = T('--info', '#5b7a9e');
  const up = (h) => mix(h, dark ? '#ffffff' : '#000000', 0.24);

  return {
    background: bg,
    foreground: fg,
    cursor: T('--accent', '#d97757'),
    cursorAccent: bg,
    selectionBackground: T('--sel', 'rgba(217,119,87,.24)'),
    selectionInactiveBackground: T('--sel', 'rgba(217,119,87,.24)'),
    // the app's scrollbar rule, so the slider matches every other bar in the window
    scrollbarSliderBackground: T('--border-strong', dark ? '#4c493f' : '#b9b4a4'),
    scrollbarSliderHoverBackground: fg3,
    scrollbarSliderActiveBackground: fg3,
    black: dark ? bg3 : fg,
    red, green, yellow, blue, magenta, cyan,
    white: fg2,
    brightBlack: fg3,
    brightRed: up(red),
    brightGreen: up(green),
    brightYellow: up(yellow),
    brightBlue: up(blue),
    brightMagenta: up(magenta),
    brightCyan: up(cyan),
    brightWhite: dark ? fg : fg3,
  };
}

/* --------------------------------------------------------------------- misc */

/** base64 -> bytes. xterm decodes UTF-8 itself and keeps the state across chunks. */
function decode(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A vault-relative markdown path, optionally `:line`. Two shapes so a sentence like
 * "read the file Todo.md" does not swallow the words before the name: a path with folders may
 * hold spaces inside its segments (`Personal/4. Journal/2026-09-03 - Journal.md`), a bare file
 * name may not.
 */
const PATH_RE = /(?:[\w.~@%+-]+\/(?:[\w.~@%+ -]*\/)*[\w.~@%+ -]*|[\w.~@%+-]+)\.md(?::\d+)?/g;
// a path is a path only when it starts a word and is not part of a URL or a Windows path
const BEFORE_OK = /[\s"'`([<>|=,]/;

function findPaths(text) {
  const hits = [];
  PATH_RE.lastIndex = 0;
  let m;
  while ((m = PATH_RE.exec(text))) {
    const start = m.index;
    const before = start > 0 ? text[start - 1] : ' ';
    if (start > 0 && !BEFORE_OK.test(before)) continue;
    const raw = m[0];
    if (raw.includes('//') || /^[a-z]:/i.test(raw)) continue;
    hits.push({ start, end: start + raw.length, text: raw });
  }
  return hits;
}

/* ---------------------------------------------------------------- the thing */

/**
 * @param {object} o
 * @param {(status:'off'|'running'|'exited') => void} o.onStatus
 * @param {(path:string) => void} o.onNavigate      Ctrl+click on a vault path
 * @param {() => void} o.onRestart                  Enter on an exited terminal
 */
export function createTerminal({ onStatus, onNavigate, onRestart } = {}) {
  const el = document.createElement('div');
  el.className = 'c-term';

  const host = document.createElement('div');
  host.className = 'c-term-host';

  const exited = document.createElement('button');
  exited.type = 'button';
  exited.className = 'c-exited mono-sm';
  exited.hidden = true;
  exited.textContent = 'press Enter or click new session';
  exited.addEventListener('click', () => onRestart?.());

  el.append(host, exited);

  const cs = getComputedStyle(document.documentElement);
  const term = new Terminal({
    fontFamily: cs.getPropertyValue('--font-mono').trim() || 'Cascadia Mono, Consolas, monospace',
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    cursorBlink: false,
    cursorStyle: 'block',
    scrollback: SCROLLBACK,
    drawBoldTextInBrightColors: true,
    // The CLI paints some glyphs in literal truecolor white, which is invisible on the ivory
    // light theme; xterm nudges any pair below this ratio until it can be read. Low enough that
    // it leaves the palette alone on the dark theme.
    minimumContrastRatio: 3,
    convertEol: false,
    allowTransparency: false,
    macOptionIsMeta: true,
    theme: buildTheme(),
    ...(bridge.platform === 'windows' ? { windowsPty: { backend: 'conpty' } } : {}),
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(host);

  let id = null;          // current pty id
  let starting = false;
  let status = 'off';
  let disposed = false;
  let cwd = '';
  let pending = '';       // text written before the pty was up (claude.ask-page on first open)

  const setStatus = (s) => {
    if (status === s) return;
    status = s;
    exited.hidden = s !== 'exited';
    el.classList.toggle('is-exited', s === 'exited');
    onStatus?.(s);
  };

  /* ---- fit ----------------------------------------------------------- */

  let fitTimer = 0;
  function fitNow() {
    if (disposed || !host.isConnected) return;
    if (!host.clientWidth || !host.clientHeight) return;   // parked in the detached holder
    try { fitAddon.fit(); } catch { /* xterm not measurable yet */ }
    if (id) bridge.ptyResize(id, term.cols, term.rows).catch(() => { });
  }
  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitNow, FIT_DEBOUNCE);
  }
  const ro = new ResizeObserver(scheduleFit);
  ro.observe(host);

  /* ---- theme --------------------------------------------------------- */

  const offTheme = bus.on('theme', () => {
    if (disposed) return;
    term.options.theme = buildTheme();
    term.options.fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
      || term.options.fontFamily;
  });

  /* ---- pty ----------------------------------------------------------- */

  const offPty = bridge.on('pty', (d) => {
    if (disposed || !d || d.id !== id) return;
    if (d.data != null) { term.write(decode(d.data)); return; }
    if ('exit' in d) {
      const code = d.exit;
      id = null;
      term.write(`\r\n\x1b[2m— claude exited${typeof code === 'number' && code !== 0 ? ` (code ${code})` : ''} —\x1b[0m\r\n`);
      setStatus('exited');
    }
  });

  function fail(message) {
    pending = '';
    term.write(`\r\n\x1b[31m${String(message).replace(/\r?\n/g, '\r\n')}\x1b[0m\r\n`);
    setStatus('exited');
  }

  /** Start a session in `nextCwd` (vault-relative, '' is the root). No-op while one runs. */
  async function start(nextCwd = '') {
    if (disposed || id || starting) return;
    starting = true;
    cwd = nextCwd || '';
    try {
      if (typeof bridge.ptyStart !== 'function') throw new Error('pty unavailable in this build');
      fitNow();
      const r = await bridge.ptyStart({ cwd, cols: term.cols || 80, rows: term.rows || 24 });
      if (disposed) { if (r && r.id) bridge.ptyKill(r.id).catch(() => { }); return; }
      if (!r || !r.id) throw new Error('the bridge returned no pty id');
      id = r.id;
      setStatus('running');
      queueMicrotask(fitNow);
      if (pending) { const q = pending; pending = ''; bridge.ptyWrite(id, q).catch(() => { }); }
    } catch (e) {
      id = null;
      fail(e && e.message ? e.message : String(e));
    } finally {
      starting = false;
    }
  }

  async function kill() {
    const gone = id;
    id = null;
    pending = '';
    if (gone) { try { await bridge.ptyKill(gone); } catch { /* already dead */ } }
    setStatus('off');
  }

  /** `new session`: kill whatever runs, clear the screen, start again. */
  async function restart(nextCwd = cwd) {
    await kill();
    term.reset();
    exited.hidden = true;
    await start(nextCwd);
  }

  /**
   * Write straight to the pty (claude.ask-page). A session that is still starting keeps the
   * text and sends it as soon as it is up, so asking about a page from a cold pane works.
   */
  function write(text) {
    if (!text) return false;
    if (!id) {
      if (status === 'exited') return false;
      pending += text;
      return true;
    }
    bridge.ptyWrite(id, text).catch((e) => console.warn('[claude] ptyWrite', e));
    return true;
  }

  term.onData((data) => {
    if (id) { bridge.ptyWrite(id, data).catch((e) => console.warn('[claude] ptyWrite', e)); return; }
    if (status === 'exited' && /[\r\n]/.test(data)) onRestart?.();
  });

  /* ---- keys ---------------------------------------------------------- */

  // The shell binds these on window in the capture phase, so it already has them by the time
  // xterm would see the event; returning false keeps xterm's hands off them either way.
  const SHELL_KEYS = new Set(['k', 'p', 'f', ',']);

  function copySelection() {
    const text = term.getSelection();
    if (!text) return;
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).catch(() => { }); return; }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* nothing else to try */ }
    ta.remove();
  }

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl || e.altKey) return true;
    const k = (e.key || '').toLowerCase();
    if (e.shiftKey) {
      if (k === 'l') return false;                 // app.theme, the shell keeps it
      if (k === 'c') { e.preventDefault(); copySelection(); return false; }
      return true;
    }
    if (SHELL_KEYS.has(k)) return false;           // palette, quick open, search, settings
    // Ctrl+V: hand the keystroke back to the browser (no preventDefault) so the textarea's own
    // paste event fires and xterm writes it to the pty. Reading the clipboard by hand would ask
    // for a permission this never needs.
    if (k === 'v') return false;
    return true;
  });

  /* ---- links --------------------------------------------------------- */

  /** The whole logical line at `y` (1-based, absolute) plus where it starts. */
  function logicalLine(y) {
    const buf = term.buffer.active;
    let start = y - 1;
    while (start > 0 && buf.getLine(start)?.isWrapped) start--;
    let text = '';
    for (let i = start; ; i++) {
      const line = buf.getLine(i);
      if (!line) break;
      if (i > start && !line.isWrapped) break;
      text += line.translateToString(false);
      if (i - start > 200) break;                  // a runaway wrap is not a path
    }
    return { text: text.replace(/\s+$/, ''), start };
  }

  const linkDispose = term.registerLinkProvider({
    provideLinks(y, callback) {
      const { text, start } = logicalLine(y);
      if (!text || !text.includes('.md')) return callback(undefined);
      const cols = term.cols || 80;
      const links = [];
      for (const hit of findPaths(text)) {
        const s = { x: (hit.start % cols) + 1, y: start + Math.floor(hit.start / cols) + 1 };
        const lastIdx = hit.end - 1;
        const e = { x: (lastIdx % cols) + 1, y: start + Math.floor(lastIdx / cols) + 1 };
        if (y < s.y || y > e.y) continue;           // the hover is on another wrapped row
        links.push({
          range: { start: s, end: e },
          text: hit.text,
          decorations: { underline: true, pointerCursor: true },
          activate(ev, raw) {
            if (!(ev.ctrlKey || ev.metaKey)) return;   // plain clicks belong to the CLI
            ev.preventDefault();
            onNavigate?.(raw.replace(/:\d+$/, ''));
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  });

  /* ---- lifecycle ----------------------------------------------------- */

  function focus() { try { term.focus(); } catch { /* not attached yet */ } }
  function hasFocus() { return !!el.contains(document.activeElement); }

  function dispose() {
    disposed = true;
    clearTimeout(fitTimer);
    ro.disconnect();
    offTheme();
    offPty();
    linkDispose.dispose();
    if (id) bridge.ptyKill(id).catch(() => { });
    id = null;
    term.dispose();
  }

  return {
    el, term,
    get status() { return status; },
    get running() { return !!id; },
    get cwd() { return cwd; },
    start, kill, restart, write, focus, hasFocus, fit: scheduleFit, fitNow, dispose,
  };
}
