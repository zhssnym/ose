// The web view's half of the log (M54, docs/HOST.md "Log"). The host keeps a rotating log file
// in every build; this is how what happens on the JavaScript side gets into it: `ose.log`, the
// kernel's own lines, and every error nobody caught. The stack of the bug that lost Hassan's
// notes existed nowhere, because a webview error never reached the disk.
//
// Nothing here throws and nothing here waits: a log line that cannot be written is dropped,
// never turned into an error of its own, and never into a loop of them.

import { bridge } from './bridge/index.js';

const LEVELS = new Set(['error', 'warn', 'info', 'debug']);

// A storm of the same error (a handler that throws on every frame) must not flood the host:
// at most this many forwarded errors per minute, then one line saying how many were dropped.
const ERROR_BUDGET = 30;
let budget = ERROR_BUDGET;
let dropped = 0;
let budgetTimer = null;

/**
 * One line into the host log, as `<stamp> <level> ui: <text>`. Fire and forget.
 * @param {string} text
 * @param {'error'|'warn'|'info'|'debug'} [level]
 */
export function logLine(text, level = 'info') {
  const lv = LEVELS.has(level) ? level : 'info';
  try { void bridge.log(String(text ?? ''), lv); } catch { /* no bridge: nothing to do */ }
}

function spend() {
  if (!budgetTimer) {
    budgetTimer = setTimeout(() => {
      budgetTimer = null;
      if (dropped) logLine(`${dropped} more errors were not logged`, 'warn');
      dropped = 0;
      budget = ERROR_BUDGET;
    }, 60000);
  }
  if (budget <= 0) { dropped += 1; return false; }
  budget -= 1;
  return true;
}

/** What an Error, or anything thrown, says: the message, then the stack when there is one. */
export function describeError(err) {
  if (err instanceof Error) {
    const head = `${err.name || 'Error'}: ${err.message}`;
    const code = err.code ? ` [${err.code}${err.cmd ? ' ' + err.cmd : ''}]` : '';
    // V8 and WebKit both start the stack with the message line; the frames are what matter.
    const frames = String(err.stack || '').split('\n').filter((l) => /^\s*at\s|@/.test(l)).join('\n');
    return head + code + (frames ? `\n${frames}` : '');
  }
  try { return typeof err === 'string' ? err : JSON.stringify(err); } catch { return String(err); }
}

let installed = false;

/**
 * `error` and `unhandledrejection` on the window, forwarded to the log at level error with the
 * message, the source file and line, and the stack. Once per document.
 */
export function forwardErrors(target = typeof window !== 'undefined' ? window : null) {
  if (installed || !target || typeof target.addEventListener !== 'function') return;
  installed = true;
  target.addEventListener('error', (e) => {
    if (!spend()) return;
    const where = e && e.filename ? ` at ${e.filename}:${e.lineno || 0}:${e.colno || 0}` : '';
    const body = e && e.error ? describeError(e.error) : String((e && e.message) || 'error');
    logLine(`uncaught${where}: ${body}`, 'error');
  });
  target.addEventListener('unhandledrejection', (e) => {
    if (!spend()) return;
    logLine(`unhandled rejection: ${describeError(e && e.reason)}`, 'error');
  });
}
