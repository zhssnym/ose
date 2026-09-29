// The leave gate (docs/CORE.md "Leaving the window"). Everything that throws the window's
// document away — the close button, a reload, a change of vault — asks here first, and asks
// the same question: can everything that holds unsaved work let go? The editor answers with its
// `saveAll`; any other module that keeps a buffer may answer too. One `false` and the window
// stays.
//
// Before this there were five ways out and each did its own thing: the close fan-out awaited
// the save, Ctrl+R and Change vault fired it and walked off, and a second launch or the host's
// `reloadShell` did not ask at all (C5). Now there is one gate and every one of them goes
// through it, so a save that fails or a question the user has not answered keeps the window.
//
// The core draws nothing: the notices below are toasts, and "Show" runs a command the page
// owner registers (`page.show-problem`).

import { bus, commands } from './registry.js';
import { toast } from './dialog.js';
import { unmountOnUnload, reopenCurrent, currentRoute, openTab } from './router.js';
import { pageHost } from './pagehost.js';
import { records, currentOf } from './tabs.js';
import { display } from './names.js';
import { flushState } from './state.js';
import { flushLocal } from './local.js';
import { flushSession } from './session.js';
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

// One sticky toast however many waits want it: the leave gate's own and the adapter's close
// fan-out's (src/host/adapter.ts) are the same notice, not two.
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
  /** @type {{ fn: (() => void) | null }} */
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

/**
 * The pages the page host says could not be let go (`PageHost.problems()`: vault paths), in its
 * order. None when it does not say.
 * @returns {string[]}
 */
function problemPages() {
  const host = pageHost();
  /** @type {unknown} */
  let list = [];
  try { list = host && typeof host.problems === 'function' ? host.problems() : []; } catch (e) { console.error('[leave] problems', e); }
  return (Array.isArray(list) ? list : [])
    .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && typeof p.path === 'string' ? p.path : ''))
    .filter(Boolean);
}

/**
 * A page that holds unsaved work and that no tab shows: a background tab's page left parked
 * when its tab was taken back by an overtaken navigation. It has to be listed by name, and
 * "Show" has to bring it back into a tab, or it is neither saved nor reachable (wave 2, open).
 * @param {string[]} paths
 */
function orphansOf(paths) {
  const shown = new Set(records().map((rec) => {
    const r = currentOf(rec);
    return r && r.type === 'page' ? r.path : null;
  }));
  return paths.filter((p) => !shown.has(p));
}

/** "a.md", "a.md and b.md", "a.md, b.md and 2 more". @param {string[]} paths */
function namesOf(paths) {
  const names = paths.map((p) => display(p) || p);
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * @param {LeaveReason} reason
 * @param {string} why
 */
function refuse(reason, why) {
  stayWindow();
  bus.emit('window:refused', { reason });
  const problems = problemPages();
  const orphans = orphansOf(problems);
  logLine(`leave ${reason} refused: ${why}${problems.length ? ` (${problems.join(', ')})` : ''}`, 'warn');
  // "Show" goes to the page with the problem: a page no tab shows first, brought back into a
  // tab of its own (the editor reattaches the page it kept, buffer and all), then the banner.
  const show = async () => {
    const target = orphans[0];
    if (target) {
      try { await openTab({ type: 'page', path: target }, { reuse: true }); } catch (e) { console.error('[leave] show', e); }
    }
    return commands.run('page.show-problem');
  };
  const actions = [{ label: 'Show', run: () => { void show(); } }];
  if (reason === 'close') actions.push({ label: 'Close anyway', run: () => commands.run('app.close-anyway') });
  if (refusal) refusal();
  const what = problems.length ? `${namesOf(problems)} could not be saved` : 'a page could not be saved';
  const hidden = orphans.length ? ` (${orphans.length === 1 ? 'it is' : `${orphans.length} are`} not open in a tab)` : '';
  try {
    refusal = toast(`Not ${NOT[reason] || 'left'}: ${what}${hidden}.`, 'err', 0, { actions });
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
 * 3. Otherwise the session and the per-machine store are written; then, for every reason but
 *    `close`, the view on screen is unmounted and the state file flushed (a close does both in
 *    the router's own `closing` handler). Bus
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
    } catch (err) {
      const e = /** @type {{ code?: string, message?: string }} */ (err);
      ok = false;
      problem = String((e && e.message) || e);
    }
    if (!ok) { refuse(why, problem); return false; }
    // The session and the per-machine store are written before anything is unmounted, so the
    // next start finds the tabs, the scroll and the selection exactly as they were left.
    try { await flushSession({ live: true }); } catch (e) { console.error('[leave] session', e); }
    try { await flushLocal(); } catch (e) { console.error('[leave] local', e); }
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
 * Nothing is refused here and nothing is frozen by the core; a handler that froze its pages
 * to answer is thawed by `stayWindow()` when the caller decides to stay.
 * @returns {Promise<(string|null)[]>}
 */
export async function abandonWindow() {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<{ late: true }>} */
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ late: true }), ABANDON_MS); });
  /** @typedef {{ late?: true, v?: unknown, e?: unknown, failed?: true }} Answer */
  const answers = [...handlers].map((fn) => {
    /** @type {Promise<unknown>} */
    let p;
    try { p = Promise.resolve(fn({ reason: 'abandon' })); } catch (e) { p = Promise.reject(e); }
    /** @type {Promise<Answer>} */
    const answer = p.then((v) => ({ v }), (e) => ({ e, failed: true }));
    return Promise.race([answer, late]);
  });
  /** @type {Answer[]} */
  let settled = [];
  try { settled = await Promise.all(answers); } finally { clearTimeout(timer); }
  /** @type {(string | null)[]} */
  const lost = [];
  for (const s of settled) {
    if (s.late) { lost.push(null); continue; }
    if (s.failed) { console.error('[leave] abandon', s.e); lost.push(null); continue; }
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
