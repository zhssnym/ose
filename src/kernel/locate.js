// `ose.paths` (docs/PLUGINS.md): a plugin never spells a vault path.
//
// A plugin says what it needs by name (`export const paths = { journal: { folder: 'journal' } }`)
// and the kernel finds it in the tree. Folders get renamed and files get moved; the name is what
// survives, and when the name is not enough the user is asked once and the answer is kept.
//
// Resolution order, the first that answers wins:
//   1. the path this owner chose before, if it still exists and is of the declared kind;
//   2. the path another owner chose for the same thing, if it still exists: one question per
//      file, not one per plugin, so answering it in Week answers it in Day;
//   3. the one file or folder whose name is exactly the name asked for;
//   4. nothing resolves. `ambiguous` when step 3 found several, `missing` otherwise, and in
//      either case the near misses ride along as `candidates` for the box to offer.
//
// A near miss is never adopted: a name that only contains the one asked for is a guess, and a
// plugin reading the wrong folder in silence is worse than a box with a button in it.
//
// `resolvePath(tree, spec, saved)` is that order and nothing else: no bridge, no DOM, no state,
// so it can be run over a tree literal in Node. Everything below it is bookkeeping — the tree
// cache, the saved choices in `.ose/state.json`, the box a view draws when the answer is null.
//
// Saved choices live under `plugins.<id>.paths.<key>`, and under `app.paths.<key>` for the
// owner `app`, which is the shell's own (its `scratch` folder).

import { bridge } from './bridge/index.js';
import { bus, debounce, esc } from './registry.js';
import { patchState, stateCache } from './state.js';
import { watch } from './watch.js';
import { clean } from './paths.js';

/* ---------------------------------------------------------------------- the pure resolver */

const lower = (s) => String(s ?? '').toLowerCase();
const stemOf = (name) => { const i = String(name).lastIndexOf('.'); return i > 0 ? String(name).slice(0, i) : String(name); };
const extOfName = (name) => { const i = String(name).lastIndexOf('.'); return i > 0 ? String(name).slice(i + 1).toLowerCase() : ''; };

/**
 * A `paths` entry as the rest of this file reads it. `file` or `folder` is the name to look
 * for, `ext` defaults to `md` and means nothing for a folder, `label` defaults to the key.
 *
 * Idempotent: a spec that has already been through here (a row) comes back unchanged, so
 * `resolvePath` may be handed either one.
 */
export function normalizeSpec(spec, key = '') {
  const s = spec && typeof spec === 'object' ? spec : {};
  if ((s.kind === 'folder' || s.kind === 'file') && typeof s.name === 'string') {
    return { kind: s.kind, name: s.name, ext: s.ext ?? null, label: s.label || key || s.name, hint: s.hint || '' };
  }
  const folder = typeof s.folder === 'string' && s.folder.trim();
  const kind = folder ? 'folder' : 'file';
  const name = String((folder || s.file || key) ?? '').trim();
  return {
    kind,
    name,
    ext: kind === 'file' ? String(s.ext || 'md').replace(/^\./, '').toLowerCase() : null,
    label: String(s.label || key || name),
    hint: typeof s.hint === 'string' ? s.hint : '',
  };
}

/**
 * Every entry of the tree, deepest last, as flat rows. The tree the host answers already leaves
 * out what it hides; a name starting with `.` is dropped here as well, with everything under it,
 * so a dotfolder is never a candidate (PLUGINS.md: "Hidden entries are never candidates").
 */
function flatten(node, out = []) {
  const kids = node && Array.isArray(node.children) ? node.children : [];
  for (const c of kids) {
    const name = String((c && c.name) || '');
    if (!name || name.startsWith('.')) continue;
    out.push(c);
    if (c.kind === 'dir') flatten(c, out);
  }
  return out;
}

/** Two specs asking the same question: same kind, same name, same extension. Case is ignored. */
export function sameSpec(a, b) {
  const x = normalizeSpec(a);
  const y = normalizeSpec(b);
  return x.kind === y.kind && lower(x.name) === lower(y.name) && (x.kind === 'folder' || x.ext === y.ext);
}

/**
 * The resolution order above. Pure: `tree` is what `bridge.tree()` answers, `spec` is one
 * `paths` entry, `saved` is the path this owner chose before or null, and `shared` is what the
 * other owners chose, `[{ owner, path, spec }]`.
 * -> `{ status: 'ok' | 'missing' | 'ambiguous', path, candidates, from }`
 *
 * `from` is the owner a shared answer came from, and null when the answer is this owner's own.
 *
 * Matching ignores case. For a file the **stem** is matched and the extension has to be the one
 * asked for, so `{ file: 'systems', ext: 'jsonl' }` never answers `systems.md`.
 *
 * Only an exact name resolves anything. A name that merely *contains* the one asked for is a
 * **candidate** and nothing more: with `drills/math` gone, `{ folder: 'math' }` used to land
 * silently on `school/1-math`, and a plugin quietly reading the wrong folder is worse than a box
 * asking one question. Candidates are handed back for the box to draw as buttons, one click each.
 */
export function resolvePath(tree, spec, saved = null, shared = []) {
  const s = normalizeSpec(spec);
  const rows = flatten(tree).filter((c) => (s.kind === 'folder' ? c.kind === 'dir' : c.kind !== 'dir'));
  const found = (path) => {
    const want = lower(clean(path));
    return rows.find((c) => lower(clean(c.path)) === want) || null;
  };

  // 1. the choice made before. It has to still exist and still be a folder when a folder was
  // asked for; its extension is not checked, because an explicit choice outranks the `ext` rule.
  if (typeof saved === 'string') {
    const want = lower(clean(saved));
    if (s.kind === 'folder' && want === '') return { status: 'ok', path: '', candidates: [], from: null };
    const hit = want ? found(saved) : null;
    if (hit) return { status: 'ok', path: clean(hit.path), candidates: [], from: null };
  }

  // 2. the answer another owner already gave to the same question. The calendar is one file: Day
  // and Week both ask for it, and the owner should be asked once, not once per plugin. Nothing is
  // written here — the choice stays the one who made it, and releasing it releases everyone.
  for (const other of shared) {
    if (!other || typeof other.path !== 'string' || !other.path) continue;
    if (!sameSpec(s, other.spec)) continue;
    const hit = found(other.path);
    if (hit) return { status: 'ok', path: clean(hit.path), candidates: [], from: other.owner || null };
  }

  const pool = (s.kind === 'folder' ? rows : rows.filter((c) => extOfName(c.name) === s.ext))
    .map((c) => ({ path: clean(c.path), match: lower(s.kind === 'folder' ? c.name : stemOf(c.name)) }));
  const name = lower(s.name);
  if (!name) return { status: 'missing', path: null, candidates: [], from: null };

  // 3. the one named exactly that. Alone, it is the answer.
  const exact = pool.filter((c) => c.match === name);
  if (exact.length === 1) return { status: 'ok', path: exact[0].path, candidates: [], from: null };
  // Several of them: ambiguous, and the ones that only contain the name are not even looked at,
  // because they are a weaker answer to a question that already has too many.
  if (exact.length > 1) return { status: 'ambiguous', path: null, candidates: exact.map((c) => c.path), from: null };

  // 4. nothing is named that: the ones whose name contains it are offered, never adopted.
  return {
    status: 'missing', path: null, from: null,
    candidates: pool.filter((c) => c.match.includes(name)).map((c) => c.path),
  };
}

/* ------------------------------------------------------------------------- the tree cache */

// One tree for every row of every owner, marked stale by any watcher event. Reading it again is
// one RPC, and the alternative is every view asking for the whole vault on every mount.
//
// A stale tree is kept rather than dropped, because the synchronous callers (`peek`, `list`)
// have nothing else to answer from: a file saved anywhere in the vault marks it stale, and a
// second of "missing" on a folder that is right there is a worse answer than a second-old one.
// `get` always waits for a fresh tree, so what a view acts on is never stale.
let cached = null;
let cachedGen = -1;
let pending = null;
let gen = 0;
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  try {
    // Any change in the vault may have moved something a row points at. The tree is stale from
    // this moment, and the new one is fetched a beat later — debounced, so a burst of events
    // (an autosave, a folder dropped in) costs one read and one sweep, not one per event.
    watch(() => { gen += 1; soon(); });
  } catch (e) { console.warn('[paths] watch', e); }
}

function tree() {
  wire();
  if (cached && cachedGen === gen) return Promise.resolve(cached);
  if (!pending) {
    const my = gen;
    pending = bridge.tree().then(
      (t) => { pending = null; cached = t; cachedGen = my; sweep(); return t; },
      (e) => { pending = null; throw e; },
    );
  }
  return pending;
}

/** Warm the cache, so `list()` and `peek()` can answer without waiting. Never throws. */
const warm = () => { void tree().catch(() => {}); };
const soon = debounce(warm, 250);

/** What a row answers, as one string: the three things a subscriber would notice changing. */
const stamp = (row) => `${row.status} ${row.path} ${row.from}`;

/**
 * Every declared row against the tree that just landed. A row keeps a resolved path until
 * something says otherwise, and the watcher is what says otherwise: without this, a folder
 * renamed under the app leaves Settings printing a path that is gone and `peek` answering it.
 * A saved choice that has vanished falls through the ordinary order here, like any other.
 *
 * `all` re-resolves even the rows the current tree has already answered: that is what a choice
 * or a reset needs, because one owner's answer is another owner's step 2. `skip` is the row the
 * caller has just set by hand and does not want resolved out from under itself.
 *
 * Only a row whose answer actually changed is emitted, so a save that touched nothing a row
 * points at is silent, and Day hears about it exactly when Week's choice moved its own path.
 */
function sweep(all = false, skip = null) {
  if (!cached) return;
  for (const row of rows.values()) {
    if (row === skip || (!all && row.seen === cachedGen)) continue;
    const was = stamp(row);
    try { resolveInto(row, cached); } catch { continue; }
    if (stamp(row) !== was) emit(row);
  }
}

/* ------------------------------------------------------------------------ saved choices */

const stateKey = (owner) => (owner === 'app' ? ['app', 'paths'] : ['plugins', owner, 'paths']);

function readSaved(owner, key) {
  const at = stateKey(owner).reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), stateCache());
  const v = at && typeof at === 'object' ? at[key] : undefined;
  return typeof v === 'string' ? clean(v) : null;
}

/** `undefined` deletes the line rather than writing an empty one. */
function writeSaved(owner, key, path) {
  const segs = stateKey(owner);
  const root = segs[0];
  const next = { ...(stateCache()[root] || {}) };
  let at = next;
  for (let i = 1; i < segs.length; i++) { at[segs[i]] = { ...(at[segs[i]] || {}) }; at = at[segs[i]]; }
  if (path === undefined) delete at[key]; else at[key] = path;
  patchState({ [root]: next });
}

/* ------------------------------------------------------------------------------ the rows */

// `<owner>::<key>` -> { owner, key, kind, name, ext, label, hint, path, status, candidates,
//                        from, seen }
// `from` is the owner a shared answer came from, null when the row answered for itself.
// `seen` is the tree generation the row was last resolved against, or -1 for never.
const rows = new Map();
const rowId = (owner, key) => `${owner}::${key}`;
const subs = new Set();   // { owner: string | null, fn }

/**
 * `ose.paths.declare(owner, specs)`: the loader calls it with a plugin's `paths` export, the
 * shell with its own. Declaring again replaces the spec and keeps the saved choice, so editing
 * a plugin's hint does not lose the folder the user picked.
 */
export function declare(owner, specs) {
  const o = String(owner ?? '').trim();
  if (!o || !specs || typeof specs !== 'object') return [];
  const out = [];
  for (const [key, spec] of Object.entries(specs)) {
    if (!key || !spec || typeof spec !== 'object') continue;
    const row = { owner: o, key, ...normalizeSpec(spec, key), path: null, status: 'missing', candidates: [], from: null, seen: -1 };
    rows.set(rowId(o, key), row);
    out.push(key);
  }
  if (out.length) warm();
  return out;
}

/**
 * What the other owners have chosen, for step 2: `[{ owner, path, spec }]`, sorted so two owners
 * holding different answers to the same question resolve the same way every time.
 */
function sharedFor(row) {
  const out = [];
  for (const other of rows.values()) {
    if (other === row) continue;
    const path = readSaved(other.owner, other.key);
    if (typeof path !== 'string' || !path) continue;
    out.push({ owner: other.owner, path, spec: other });
  }
  out.sort((a, b) => String(a.owner).localeCompare(String(b.owner)) || String(a.path).localeCompare(String(b.path)));
  return out;
}

function resolveInto(row, t, at = cachedGen) {
  const answer = resolvePath(t, row, readSaved(row.owner, row.key), sharedFor(row));
  row.path = answer.path;
  row.status = answer.status;
  row.candidates = answer.candidates;
  row.from = answer.from;
  row.seen = at;
  return answer;
}

/** Resolve off the cached tree when the row has not been answered against it yet. */
function refresh(row) {
  if (cached && row.seen !== cachedGen) {
    try { resolveInto(row, cached); } catch { /* the row keeps what it had */ }
  }
  if (!cached || cachedGen !== gen) warm();
}

function emit(row) {
  const payload = { owner: row.owner, key: row.key, path: row.status === 'ok' ? row.path : null };
  for (const s of [...subs]) {
    if (s.owner && s.owner !== row.owner) continue;
    try { s.fn(payload); } catch (e) { console.error('[paths] subscriber', e); }
  }
  bus.emit('paths', payload);
}

/**
 * The route on screen is mounted again, so the view that drew the box reads the path it now has.
 * The router is imported at call time: by the time anybody picks a folder it is long since
 * evaluated, and the module graph stays acyclic.
 *
 * Only a choice made **in the box** asks for this. A `choose(key)` or `reset(key)` called from
 * code — the Settings dialog's own rows — saves and emits and leaves the route alone: the box is
 * part of the page and finishing it means the page can draw, while a dialog is over a page that
 * did not ask for anything and must not be torn down under it. Whoever changed a path from a
 * dialog knows when its own dialog closes, and `ose.paths.on` tells it what changed.
 */
async function remount() {
  try {
    const router = await import('./router.js');
    await router.reopenCurrent();
  } catch (e) { console.warn('[paths] remount', e); }
}

async function commit(row, path, { remount: again = false } = {}) {
  writeSaved(row.owner, row.key, path);
  row.path = path;
  row.status = 'ok';
  row.candidates = [];
  row.from = null;
  // The user picked it out of the vault, so it exists; `seen` is left where it was and the next
  // tree confirms it.
  emit(row);
  // Every other owner asking the same question has just been answered too (step 2), so the ones
  // whose path moved say so: Day repaints because Week chose.
  sweep(true, row);
  if (again) await remount();
  return path;
}

/* --------------------------------------------------------------------------- the box */

/**
 * What a view gets when `get(key, { el })` cannot answer: the title, the hint, the one line
 * saying what was looked for, the candidates as buttons when the match was ambiguous, and
 * Choose…, which opens the vault picker. Everything is a real button and focus lands on
 * Choose…, so the box is finished with the keyboard alone. Drawn with `ui.css` tokens only.
 */
function drawBox(row, answer, el) {
  if (!el || typeof el.appendChild !== 'function' || typeof document === 'undefined') return;
  for (const old of el.querySelectorAll ? [...el.querySelectorAll('.path-box')] : []) old.remove();

  const ambiguous = answer.status === 'ambiguous';
  const near = answer.candidates || [];
  const what = row.kind === 'folder'
    ? `a folder named <code>${esc(row.name)}</code>`
    : `a file named <code>${esc(row.name)}.${esc(row.ext)}</code>`;
  // Several things are named exactly that, and the kernel will not pick between them; or nothing
  // is, and what is offered is only close. Either way it is one click, and it is the user's.
  const picks = near.length ? `
    ${ambiguous ? '' : `<div class="path-box-near">Closest match${near.length > 1 ? 'es' : ''}:</div>`}
    <div class="path-box-picks">${near
      .map((p, i) => `<button type="button" class="btn path-box-pick" data-i="${i}">${esc(p)}</button>`).join('')}</div>` : '';
  const box = document.createElement('div');
  box.className = 'path-box';
  box.innerHTML = `
    <div class="path-box-title">${esc(ambiguous ? `Several matches for ${row.label}` : `${row.label} not found`)}</div>
    ${row.hint ? `<div class="path-box-hint">${esc(row.hint)}</div>` : ''}
    <div class="path-box-what">Looked for ${what} in the vault.</div>
    ${picks}
    <div class="path-box-actions">
      <button type="button" class="btn primary path-box-choose">Choose…</button>
    </div>`;

  // The box is inside the mounted route, so a choice made here mounts it again: that is what
  // takes the box off the screen and puts the view in its place.
  box.addEventListener('click', (e) => {
    const pick = e.target.closest('.path-box-pick');
    if (pick) { void commit(row, answer.candidates[+pick.dataset.i], { remount: true }); return; }
    if (e.target.closest('.path-box-choose')) void choose(row.owner, row.key, { remount: true });
  });
  el.appendChild(box);
  try { box.querySelector('.path-box-choose').focus({ preventScroll: true }); } catch { /* not on screen */ }
}

/* ------------------------------------------------------------------------- the scoped API */

async function get(owner, key, { el } = {}) {
  const row = rows.get(rowId(owner, key));
  if (!row) { console.warn(`[paths] ${owner} has not declared "${key}"`); return null; }
  let answer = { status: row.status, path: row.path, candidates: row.candidates };
  try { answer = resolveInto(row, await tree()); } catch (e) { console.warn('[paths] tree', e); }
  if (answer.status === 'ok') return answer.path;
  if (el) drawBox(row, answer, el);
  return null;
}

/** The last resolved value, synchronously, or null. Resolves off the cached tree when it can. */
function peek(owner, key) {
  const row = rows.get(rowId(owner, key));
  if (!row) return null;
  refresh(row);
  return row.status === 'ok' ? row.path : null;
}

async function choose(owner, key, opts = {}) {
  const row = rows.get(rowId(owner, key));
  if (!row) return null;
  const { pickFile, pickFolder } = await import('./dialog.js');
  const picked = row.kind === 'folder'
    ? await pickFolder({ title: `Choose the ${row.label} folder…`, current: row.path })
    : await pickFile({ title: `Choose the ${row.label} file…`, ext: row.ext, current: row.path });
  if (picked === null || picked === undefined) return null;
  return commit(row, clean(picked), opts);
}

function reset(owner, key) {
  const row = rows.get(rowId(owner, key));
  if (!row) return;
  writeSaved(owner, key, undefined);
  // The name decides again: forgetting a choice is not the same as having no answer.
  row.seen = -1;
  row.path = null;
  row.status = 'missing';
  row.candidates = [];
  row.from = null;
  refresh(row);
  emit(row);
  // Releasing a choice releases everyone who was borrowing it.
  sweep(true, row);
}

/**
 * One row per declared path:
 * `{ owner, key, kind, name, ext, label, hint, path, saved, status, candidates, sharedFrom }`.
 * Synchronous, so Settings can draw it: a row nobody has asked for yet is resolved off the
 * cached tree, and a tree the watcher has marked stale still answers while the new one is on
 * its way. Before the very first tree arrives a row says `missing`, which is the only honest
 * answer available synchronously; the fetch is started and the next draw is right.
 */
function list(owner = null) {
  const out = [];
  for (const row of rows.values()) {
    if (owner && row.owner !== owner) continue;
    refresh(row);
    out.push({
      owner: row.owner, key: row.key, kind: row.kind, name: row.name, ext: row.ext,
      label: row.label, hint: row.hint,
      path: row.status === 'ok' ? row.path : null,
      saved: readSaved(row.owner, row.key),
      status: row.status,
      // What the box would offer: the several exact matches, or the near misses. Settings draws
      // them as the same one-click buttons.
      candidates: [...(row.candidates || [])],
      // Set when this row is answered by another owner's choice: `saved` is null (this owner has
      // chosen nothing) and resetting it there releases this row too.
      sharedFrom: row.from || null,
    });
  }
  return out;
}

function on(fn, owner = null) {
  if (typeof fn !== 'function') return () => {};
  const entry = { owner, fn };
  subs.add(entry);
  return () => subs.delete(entry);
}

/** A plugin's `ose.paths`, and what the shell asks for with the owner `app`. */
export function of(owner) {
  const o = String(owner ?? '');
  return {
    get: (key, opts) => get(o, key, opts),
    peek: (key) => peek(o, key),
    // No route is mounted again for this one: it is the caller's own surface that asked, and a
    // dialog must not tear down the page under itself. The box does its own remount.
    choose: (key) => choose(o, key),
    reset: (key) => reset(o, key),
    list: () => list(o),
    on: (fn) => on(fn, o),
  };
}

/** Every row of every owner, for Settings. */
export function all() { return list(null); }

/** Every change, whoever owns it. The scoped `on` only hears its own owner's. */
export const onAny = (fn) => on(fn, null);

/** The tree cache is the kernel's, not a caller's: a vault change drops it. */
export function invalidate() { cached = null; pending = null; gen += 1; }
