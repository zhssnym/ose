// The leave gate (docs/KERNEL.md "Leaving the window"). Everything that throws the window's
// document away — the close button, a reload, a change of vault — asks here first, and asks
// the same question: can everything that holds unsaved work let go? The editor answers with its
// `saveAll`; a plugin that keeps a buffer may answer too. One `false` and the window stays.
//
// Before this there were five ways out and each did its own thing: the close fan-out awaited
// the save, Ctrl+R and Change vault fired it and walked off, and a second launch or the host's
// `reloadShell` did not ask at all (C5). Now there is one gate and every one of them goes
// through it, so a save that fails or a question the user has not answered keeps the window.
//
// The kernel draws nothing: the notices below are toasts, and "Show" runs a command the page
// owner registers (`page.show-problem`).

import { bus, commands } from './registry.js';
import { toast } from './dialog.js';
import { unmountOnUnload, reopenCurrent, currentRoute } from './router.js';
import { flushState } from './state.js';
import { logLine } from './log.js';

/** @typedef {'close'|'reload'|'vault-change'} LeaveReason */

/** After this long a leave that is still waiting says so, and keeps waiting. */
const NOTICE_MS = 3000;

/** How long "Close window without saving" waits for the handlers to keep what they hold. */
const ABANDON_MS = 5000;

const handlers = new Set();
let inflight = null;
let refusal = null;          // the kill of the last "Not closed…" toast
let unmounted = false;       // a leave took the view on screen down; a stay puts it back

/** What the refusal toast says the window was not. */
const NOT = { close: 'closed', reload: 'reloaded', 'vault-change': 'switched' };

/**
 * `fn({ reason }) -> boolean | Promise<boolean>`: `false` (or a rejection) keeps the window.
 * A handler that answers anything else lets it go. Answers the unsubscribe.
 *
 * The same handlers hear `reason: 'abandon'` from `abandonWindow` ("Close window without
 * saving"): the window goes whatever they answer, so a handler keeps what it holds somewhere
 * that outlives the window (a draft) and answers true once it is kept. `false`, a rejection or
 * no answer within five seconds means it is not; a string (or an array of strings) means the
 * same and names what would be lost, which the question before the close quotes.
 * @param {(e: {reason: LeaveReason|'abandon'}) => boolean | string | string[] | Promise<boolean | string | string[]>} fn
 */
export function onLeave(fn) {
  if (typeof fn !== 'function') throw new Error('window.onLeave: a function is required');
  handlers.add(fn);
  return () => handlers.delete(fn);
}

/* -------------------------------------------------------------- the "still saving" notice */

// One sticky toast however many waits want it: the leave gate's own and the Tauri close
// fan-out's (./bridge/tauri.js) are the same notice, not two.
let holders = 0;
let stillKill = null;

/**
 * Put up the "still saving…" toast, or join the one that is up. Answers the release; the toast
 * goes when the last holder releases it. Idempotent per release.
 */
export function holdStillSaving() {
  holders += 1;
  if (!stillKill) {
    try { stillKill = toast('Still saving…', 'warn', 0); } catch { stillKill = null; }
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holders -= 1;
    if (holders <= 0) {
      holders = 0;
      const kill = stillKill;
      stillKill = null;
      if (kill) kill();
    }
  };
}

/* ------------------------------------------------------------------------------ the gate */

async function runHandlers(reason) {
  const results = [...handlers].map((fn) => {
    try { return Promise.resolve(fn({ reason })); } catch (e) { return Promise.reject(e); }
  });
  // No ceiling (S28): a save that is slow — a big file, a sync client holding it — is waited for.
  const release = { fn: null };
  const notice = setTimeout(() => { release.fn = holdStillSaving(); }, NOTICE_MS);
  let settled;
  try {
    settled = await Promise.allSettled(results);
  } finally {
    clearTimeout(notice);
    if (release.fn) release.fn();
  }
  return settled.every((r) => r.status === 'fulfilled' && r.value !== false);
}

function refuse(reason, why) {
  stayWindow();
  bus.emit('window:refused', { reason });
  logLine(`leave ${reason} refused: ${why}`, 'warn');
  const actions = [{ label: 'Show', run: () => commands.run('page.show-problem') }];
  if (reason === 'close') actions.push({ label: 'Close anyway', run: () => commands.run('app.close-anyway') });
  if (refusal) refusal();
  try {
    refusal = toast(`Not ${NOT[reason] || 'left'}: a page could not be saved.`, 'err', 0, { actions });
  } catch { refusal = null; }
}

/**
 * Ask everything that holds unsaved work to let the window go. One leave at a time: a call
 * while one is in flight answers the same promise.
 *
 * 1. Every `onLeave` handler runs and all of them are awaited (no ceiling; after 3 s a sticky
 *    "Still saving…" toast until they settle).
 * 2. A handler that answers `false`, or rejects: `stayWindow()`, bus `window:refused`
 *    `{ reason }`, a sticky error toast with [Show] (and [Close anyway] for `close`). Answers
 *    false.
 * 3. Otherwise, for every reason but `close`, the view on screen is unmounted and the state
 *    file flushed (a close does both in the router's own `closing` handler). Bus
 *    `window:leaving` `{ reason }`. Answers true, and the handlers stay frozen: the caller
 *    either goes, or calls `stayWindow()`.
 *
 * @param {LeaveReason} reason
 * @returns {Promise<boolean>}
 */
export function leaveWindow(reason) {
  if (inflight) return inflight;
  const why = NOT[reason] ? reason : 'close';
  inflight = (async () => {
    if (refusal) { refusal(); refusal = null; }
    let ok = false;
    let problem = 'a handler answered no';
    try {
      ok = await runHandlers(why);
    } catch (e) {
      ok = false;
      problem = String((e && e.message) || e);
    }
    if (!ok) { refuse(why, problem); return false; }
    if (why !== 'close') {
      const r = currentRoute();
      unmounted = !!(r && r.type !== 'page');
      try { await unmountOnUnload(); } catch (e) { console.error('[leave] unmount', e); }
      try { await flushState(); } catch (e) { console.error('[leave] state', e); }
    }
    bus.emit('window:leaving', { reason: why });
    logLine(`leave ${why}`);
    return true;
  })().finally(() => { inflight = null; });
  return inflight;
}

/**
 * The caller of a successful leave changed its mind (the new vault could not be opened, the
 * host refused the reload): everything a `true` froze is handed back. Bus `window:stay`.
 */
export function stayWindow() {
  bus.emit('window:stay');
  // A reload or a vault change that was let go took the view on screen down with it; the
  // window stays, so the view comes back (a page was only frozen, and 'window:stay' thawed it).
  if (unmounted) {
    unmounted = false;
    void reopenCurrent();
  }
}

/**
 * "Close window without saving" asks here before it destroys the window: every `onLeave`
 * handler hears `reason: 'abandon'` and is given five seconds to keep what it holds (the
 * editor writes the draft of every dirty page). Answers what would be lost: one entry per
 * handler that did not say its work is kept, its name when it gave one, else null. An empty
 * list means the window can go and nothing typed goes with it.
 *
 * Nothing is refused here and nothing is frozen by the kernel; a handler that froze its pages
 * to answer is thawed by `stayWindow()` when the caller decides to stay.
 * @returns {Promise<(string|null)[]>}
 */
export async function abandonWindow() {
  let timer = 0;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ late: true }), ABANDON_MS); });
  const answers = [...handlers].map((fn) => {
    let p;
    try { p = Promise.resolve(fn({ reason: 'abandon' })); } catch (e) { p = Promise.reject(e); }
    return Promise.race([p.then((v) => ({ v }), (e) => ({ e })), late]);
  });
  let settled;
  try { settled = await Promise.all(answers); } finally { clearTimeout(timer); }
  const lost = [];
  for (const s of settled) {
    if (s.late) { lost.push(null); continue; }
    if (s.e) { console.error('[leave] abandon', s.e); lost.push(null); continue; }
    const v = s.v;
    if (v === false) lost.push(null);
    else if (typeof v === 'string') lost.push(v || null);
    else if (Array.isArray(v)) { for (const n of v) lost.push(typeof n === 'string' && n ? n : null); }
  }
  logLine(lost.length ? `abandon: ${lost.length} not kept` : 'abandon: everything kept', lost.length ? 'warn' : 'info');
  return lost;
}

/** True while a leave is waiting on its handlers. */
export function leaving() { return !!inflight; }
