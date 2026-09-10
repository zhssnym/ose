// Self-update. The host does the network and the swap (src-tauri/src/update.rs); this module
// decides when to ask, says what it found, and drives the one dialog. It is the app's only
// network call, and `settings.updates` switches it: with it off no automatic request is ever
// made — the manual command still works, and says the automatic check is off.
//
// Schedule: 10 s after boot (a vault is open, or this module never runs), then every 6 hours
// while the window is open. Silent unless the release was built from a different commit than
// this executable: then a status-bar item and the `Update now…` command lead to the dialog.
// A dev build (no CI stamp) never checks; the host answers at once with `current: null`.
import { store, commands, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { openOverlay, toast } from './dialog.js';
import { stateCache, flushState } from './state.js';

const FIRST_CHECK_MS = 10_000;
const PERIOD_MS = 6 * 60 * 60 * 1000;

let timer = null;
let checking = null;      // the running check, so two callers share one request
let lastError = null;     // the last error logged to the console, so it is logged once
let build;                // platform.build: undefined until asked, null for a dev build
let dialog = null;        // { ov, ok, cancel, busy }

const mb = (bytes) => (Number(bytes || 0) / 1048576).toFixed(1);

/** `settings.updates`, default on. Read at call time: the settings dialog may have just flipped it. */
export function updatesEnabled() {
  const s = stateCache().settings || {};
  return s.updates !== false;
}

function current() { return store.get('update') || { behind: false, commits: [] }; }

/** The settings line: `build a45404e · 2026-09-09`, or `dev build · updates off`. */
export function buildLine() {
  if (build === undefined) return '—';
  if (build === null) return 'dev build · updates off';
  return `build ${build.short}${build.date ? ` · ${build.date}` : ''}`;
}

/** The settings line: `last checked 14:02`, or `not checked yet`. */
export function checkedLine() {
  const at = current().checkedAt;
  if (!at) return 'not checked yet';
  return `last checked ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/* ------------------------------------------------------------------ the check */

/**
 * One check. Never throws: a failed call becomes `error`, and the result is put in the store
 * under `update` for the status bar and the settings dialog. `behind` is what the host said;
 * the dialog explains a release with no asset for this platform rather than hiding it.
 */
export async function check() {
  if (checking) return checking;
  checking = (async () => {
    let r;
    try {
      r = await bridge.updateCheck();
    } catch (e) {
      r = { current: null, latest: null, behind: false, commits: [], asset: null, error: String(e && e.message ? e.message : e) };
    }
    if (!r || typeof r !== 'object') r = { current: null, latest: null, behind: false, commits: [], asset: null, error: 'bad reply' };
    if (r.current === null || r.current === undefined) build = null;
    else if (build == null) build = r.current;
    const next = {
      current: r.current || null,
      latest: r.latest || null,
      behind: !!r.behind,
      commits: Array.isArray(r.commits) ? r.commits : [],
      asset: r.asset || null,
      error: r.error || null,
      checkedAt: Date.now(),
    };
    store.set('update', next);
    // Quiet in the UI, once in the console: a laptop off the network for a day must not toast
    // four times about it.
    if (next.error && next.error !== lastError) { lastError = next.error; console.warn('[update] check failed:', next.error); }
    return next;
  })().finally(() => { checking = null; });
  return checking;
}

/** The command: check, then say so — the dialog when behind, a toast otherwise. */
async function checkNow() {
  const r = await check();
  const off = updatesEnabled() ? '' : ' · automatic checks are off';
  if (!r.current) { toast('dev build · nothing to update', 'info'); return; }
  if (r.error) { toast(`update check failed: ${r.error}`, 'warn'); return; }
  if (r.behind) { openUpdateDialog(); return; }
  if (!r.latest) { toast('no release right now' + off, 'info'); return; }
  toast('up to date' + off, 'info');
}

/* ------------------------------------------------------------------ schedule */

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    if (!updatesEnabled() || build === null) return;
    await check();
    if (build !== null) schedule(PERIOD_MS);
  }, ms);
}

/** Called by settings after `updates` changes: stop, or start again from where the clock was. */
export function reschedule() {
  clearTimeout(timer);
  timer = null;
  if (!updatesEnabled() || build === null) return;
  const at = current().checkedAt;
  schedule(at ? Math.max(0, at + PERIOD_MS - Date.now()) : FIRST_CHECK_MS);
}

/* ------------------------------------------------------------------ the dialog */

function statusLabel(u) {
  const n = u.commits.length;
  return n ? `update · ${n} commit${n === 1 ? '' : 's'}` : 'update available';
}

export function openUpdateDialog() {
  if (dialog) { dialog.ok.focus(); return; }
  const u = current();
  if (!u.behind) { toast('up to date', 'info'); return; }
  const ov = openOverlay({ width: 480, className: 'dlg-ov', title: 'Update available', onClose: () => { dialog = null; } });
  ov.box.classList.add('dlg');
  const from = u.current ? u.current.short : '?';
  const to = u.latest ? u.latest.short : '?';
  const what = u.asset ? `${u.asset.name} · ${mb(u.asset.size)} MB` : 'no build is published for this platform';
  const rows = u.commits.map((c) =>
    `<div class="upd-row"><span class="upd-sha">${esc(c.short)}</span><span class="grow" title="${esc(c.subject)}">${esc(c.subject)}</span></div>`).join('');
  ov.box.innerHTML = `
    <div class="dlg-head">Update available</div>
    <div class="dlg-body">
      <p class="dlg-text">build ${esc(from)} → ${esc(to)} · ${esc(what)}</p>
      ${rows ? `<div class="upd-list">${rows}</div>` : '<p class="dlg-text">the commit list could not be fetched</p>'}
    </div>
    <div class="dlg-foot">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="ok">Update now</button>
    </div>`;
  const ok = ov.box.querySelector('[data-act="ok"]');
  const cancel = ov.box.querySelector('[data-act="cancel"]');
  dialog = { ov, ok, cancel, busy: false };
  if (!u.asset) ok.disabled = true;
  cancel.addEventListener('click', () => ov.close());
  ok.addEventListener('click', () => void install());
  requestAnimationFrame(() => (u.asset ? ok : cancel).focus());
}

/**
 * Update now: download (the button is the progress line), save the page and flush the state
 * file — a restart gives neither the `closing` notice the editor relies on — then apply. The
 * host swaps, relaunches and exits; the call never resolves on success. An error toasts and
 * the dialog stays.
 */
async function install() {
  const d = dialog;
  if (!d || d.busy) return;
  d.busy = true;
  d.ok.disabled = true;
  d.cancel.disabled = true;
  d.ok.textContent = 'downloading…';
  try {
    await bridge.updateDownload();
    d.ok.textContent = 'installing…';
    try { await commands.run('page.save'); } catch (e) { console.warn('[update] save before restart', e); }
    await flushState();
    await bridge.updateApply();
  } catch (e) {
    toast(String(e && e.message ? e.message : e), 'err');
    if (dialog === d) {
      d.busy = false;
      d.ok.disabled = false;
      d.cancel.disabled = false;
      d.ok.textContent = 'Update now';
    }
  }
}

function onUpdateEvent(ev) {
  const d = dialog;
  if (!d || !d.busy || !ev) return;
  if (ev.phase === 'download') d.ok.textContent = `downloading · ${mb(ev.received)} / ${mb(ev.total)} MB`;
  else if (ev.phase === 'apply') d.ok.textContent = 'installing…';
}

/* ------------------------------------------------------------------ boot */

export function initUpdate() {
  bridge.on('update', onUpdateEvent);

  commands.register({
    id: 'app.update-check', title: 'Check for updates', group: 'app',
    hint: 'against the latest release', run: () => void checkNow(),
  });
  commands.register({
    id: 'app.update', title: 'Update now…', group: 'app',
    hint: 'a newer build is published',
    when: () => !!current().behind,
    run: openUpdateDialog,
  });

  // The stamp, so the settings line can say `build …` before any check has run; a dev build
  // is known at once and never scheduled.
  bridge.platformInfo()
    .then((p) => { build = p && p.build ? p.build : null; reschedule(); })
    .catch(() => { build = undefined; reschedule(); });
}

/** For the status bar: the label of the item, or null when there is nothing to show. */
export function statusItem() {
  const u = current();
  return u.behind ? statusLabel(u) : null;
}
