// The planner's settings (9.2, M29): four paths, the (Q1) week anchor and the journal mode, kept in
// `.ose/state.json` under `planner` so they travel with the vault. Nothing else in the planner
// spells a path; the views ask the store.
//
// The first time there is no `planner` key, the choices the old plugins saved are copied over
// (`plugins.day.paths.*`, `plugins.week.paths.calendar`, `plugins.month.paths.reports`,
// `plugins.journal.paths.journal`, `plugins.journal.mode`), never deleted from where they were.
// While the paths are not confirmed, detection (`detect.ts`) fills whatever is still missing at
// every start; "These look right" stops that, and "Detect again" asks once more on demand.
//
// (Q1) weeks are `q1Anchor`, a Monday that starts a Q1 week; the weeks alternate from it. The
// old `q1Parity` (odd or even ISO weeks) broke after every 53-week year, so it is only read
// once, turned into an anchor on the week it is read, and cleared.
//
// The fragment Settings › Planner draws is `renderSettings`. Every control in it is a button or
// a segmented control, so it is reachable from the keyboard like the rest of the settings.

import { esc, pickFile, pickFolder, toast } from 'ose:ui';
import { detectPaths } from './detect.ts';
import { anchorFromParity, isQ1Week, parseYmd, q1AnchorFor, ymd } from './dates.ts';

export type PlannerSettings = {v: 1, calendar: string|null, todo: string[], reports: string|null, journal: string|null, q1Parity: 'odd'|'even'|null, q1Anchor?: string, journalMode: 'full'|'compact', confirmed: boolean};

const KEY = 'planner';
const clean = (p) => (typeof p === 'string' && p.trim() ? p.replace(/\\/g, '/').trim().replace(/^\/+/, '').replace(/\/+$/, '') : null);

/**
 * Any stored or half-built value -> a complete `PlannerSettings`.
 */
export function normalize(raw: any): PlannerSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const todo: string[] = (Array.isArray(r.todo) ? r.todo : typeof r.todo === 'string' ? [r.todo] : [])
    .map(clean).filter((p): p is string => !!p);
  const anchor = parseYmd(r.q1Anchor);
  const out: PlannerSettings = {
    v: 1,
    calendar: clean(r.calendar),
    todo: [...new Set(todo)],
    reports: clean(r.reports),
    journal: clean(r.journal),
    q1Parity: r.q1Parity === 'odd' || r.q1Parity === 'even' ? r.q1Parity : null,
    journalMode: r.journalMode === 'compact' ? 'compact' : 'full',
    confirmed: r.confirmed === true,
  };
  // present only when known, so a vault that never set it stores nothing for it
  if (anchor) out.q1Anchor = ymd(anchor);
  return out;
}

/**
 * What the views hand `blockApplies`: the anchor, else an old parity not yet migrated, else null.
 */
export const q1Of = (s: PlannerSettings): string | null => (s && (s.q1Anchor || s.q1Parity)) || null;

/**
 * What the old plugins had saved, as planner settings (only the fields they knew).
 * @param plugins the `plugins` key of `.ose/state.json`
 */
export function migrate(plugins: any): Partial<PlannerSettings> {
  const p = plugins && typeof plugins === 'object' ? plugins : {};
  const at = (id, key) => { const v = p[id] && p[id].paths && p[id].paths[key]; return clean(v); };
  const out: Record<string, any> = {};
  const calendar = at('day', 'calendar') || at('week', 'calendar');
  if (calendar) out.calendar = calendar;
  const todo = at('day', 'todo');
  if (todo) out.todo = [todo];
  const reports = at('day', 'reports') || at('month', 'reports');
  if (reports) out.reports = reports;
  const journal = at('journal', 'journal');
  if (journal) out.journal = journal;
  const mode = p.journal && p.journal.mode;
  if (mode === 'full' || mode === 'compact') out.journalMode = mode;
  return out;
}

/**
 * Fill what is missing from a detection (`detectPaths`), keeping what is there.
 */
export function fillMissing(s: PlannerSettings, found: { calendar: string | null; todo: string[]; reports: string | null; journal: string | null; }): PlannerSettings {
  return normalize({
    ...s,
    calendar: s.calendar || found.calendar,
    todo: s.todo.length ? s.todo : found.todo,
    reports: s.reports || found.reports,
    journal: s.journal || found.journal,
  });
}

/** `from` moved to `to`: the path itself, or anything under it, follows. */
function follow(p, from, to) {
  if (!p) return p;
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return p;
}

/**
 * The store. One per `initPlanner`.
 */
export function createStore(ose: any): { ready: Promise<void>; get: () => PlannerSettings; set: (partial: Partial<PlannerSettings>) => void; on: (fn: Function) => () => void; detect: (opts?: { replace?: boolean; }) => Promise<PlannerSettings>; dispose: () => void; } {
  const subs = new Set<any>();
  let cur = normalize(ose.state(KEY).get());
  const emit = () => { for (const fn of [...subs]) { try { fn(cur); } catch (e) { console.error('[planner] settings listener', e); } } };
  const write = (next) => {
    const n = normalize(next);
    if (JSON.stringify(n) === JSON.stringify(cur)) return;
    cur = n;
    ose.state(KEY).set(cur);
    emit();
  };

  async function tree() {
    try { return await ose.files.tree(); } catch (e) { console.warn('[planner] tree', e); return null; }
  }

  async function detect({ replace = false } = {}) {
    const t = await tree();
    if (!t) return cur;
    const found = detectPaths(t);
    write(replace ? normalize({ ...cur, ...found, todo: found.todo }) : fillMissing(cur, found));
    return cur;
  }

  const ready = (async () => {
    const stored = ose.state(KEY).get();
    if (!stored || typeof stored !== 'object') {
      // once: the old plugins' choices, copied, never removed from where they are
      const old = migrate(ose.state('plugins').get());
      cur = normalize({ ...old, confirmed: false });
      ose.state(KEY).set(cur);
    }
    if (cur.q1Parity && !cur.q1Anchor) {
      // once: the parity as it reads this week, then the anchor alone
      write({ ...cur, q1Anchor: anchorFromParity(cur.q1Parity, new Date()), q1Parity: null });
    }
    if (!cur.confirmed) await detect();
  })().catch((e) => console.error('[planner] settings', e));

  // A planner file renamed or moved, in the app or outside it: the choice follows it.
  const moveAll = (pairs) => {
    let next = cur;
    for (const { from, to } of pairs) {
      if (!from || !to) continue;
      next = {
        ...next,
        calendar: follow(next.calendar, from, to),
        todo: next.todo.map((p) => follow(p, from, to)),
        reports: follow(next.reports, from, to),
        journal: follow(next.journal, from, to),
      };
    }
    write(next);
  };
  const offMoved = ose.bus && ose.bus.on ? ose.bus.on('paths:moved', (d) => moveAll((d && d.moves) || [])) : null;
  const offWatch = ose.watch((d) => {
    const pairs = ((d && d.changes) || []).filter((c) => c && c.to).map((c) => ({ from: c.path, to: c.to }));
    if (pairs.length) moveAll(pairs);
  });

  return {
    ready,
    get: () => cur,
    set: (partial) => write({ ...cur, ...partial }),
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    detect,
    dispose() {
      subs.clear();
      if (typeof offMoved === 'function') offMoved();
      if (typeof offWatch === 'function') offWatch();
    },
  };
}

/* ------------------------------------------------------------------ Settings › Planner */

const ROWS = [
  { key: 'calendar', name: 'Calendar', kind: 'file', note: 'One heading per weekday and one line per block. Day and Week draw it.' },
  { key: 'reports', name: 'Reports folder', kind: 'folder', note: 'Holds <year>/<YYYY-MM>.md, the monthly plans, and systems.jsonl, the checks. Day and Month read it.' },
  { key: 'journal', name: 'Journal folder', kind: 'folder', note: 'One file per day, named YYYY-MM-DD.md.' },
];

function seg(name, options, value) {
  return `<div class="seg" role="group" data-pl-seg="${name}">${options.map((o) =>
    `<button type="button" class="seg-b${o.value === value ? ' on' : ''}" aria-pressed="${o.value === value}" data-v="${esc(String(o.value))}">${esc(o.label)}</button>`,
  ).join('')}</div>`;
}

function pathValue(p, kind) {
  return p
    ? `<span class="pl-set-path mono-sm text-select">${esc(p)}</span>`
    : `<span class="pl-set-none">${kind === 'folder' ? 'No folder chosen' : 'No file chosen'}</span>`;
}

/** 'q1' | 'q2' | 'unknown' for the week in front of you. */
function thisWeek(s) {
  const q = isQ1Week(new Date(), q1Of(s));
  return q === null ? 'unknown' : q ? 'q1' : 'q2';
}

function html(s) {
  const rows = ROWS.map((r) => `
    <div class="pl-set-row" data-key="${r.key}">
      <div class="pl-set-name">${esc(r.name)}</div>
      <div class="pl-set-value">${pathValue(s[r.key], r.kind)}</div>
      <div class="pl-set-act">
        <button type="button" class="btn sm" data-act="choose" data-key="${r.key}">Choose…</button>
        <button type="button" class="btn sm" data-act="clear" data-key="${r.key}"${s[r.key] ? '' : ' disabled'}>Clear</button>
      </div>
      <div class="pl-set-note">${esc(r.note)}</div>
    </div>`);

  const todo = `
    <div class="pl-set-row" data-key="todo">
      <div class="pl-set-name">Todo files</div>
      <div class="pl-set-value">${s.todo.length
        ? `<ul class="pl-set-list">${s.todo.map((p, i) => `<li><span class="pl-set-path mono-sm text-select">${esc(p)}</span>
            <button type="button" class="btn sm" data-act="remove-todo" data-i="${i}" aria-label="Remove ${esc(p)}">Remove</button></li>`).join('')}</ul>`
        : pathValue(null, 'file')}</div>
      <div class="pl-set-act">
        <button type="button" class="btn sm" data-act="add-todo">Add a file…</button>
      </div>
      <div class="pl-set-note">Markdown files of <code>- [ ]</code> lines. Day lists what is late, due and undated, file by file.</div>
    </div>`;

  return `
    <div class="pl-set">
      ${s.confirmed ? '' : '<div class="pl-quiet">These were found automatically. Check them, then confirm.</div>'}
      ${rows.slice(0, 1).join('')}
      ${todo}
      ${rows.slice(1).join('')}
      <div class="pl-set-row">
        <div class="pl-set-name">This week is</div>
        <div class="pl-set-value">${seg('q1', [
          { value: 'q1', label: 'Q1' }, { value: 'q2', label: 'Q2' }, { value: 'unknown', label: "Don't know" },
        ], thisWeek(s))}</div>
        <div class="pl-set-note">Which of the calendar's (Q1) and (Q2) blocks apply this week. The weeks alternate from here, year ends included; after a break that restarts the count, set it again. Not knowing draws both, side by side.</div>
      </div>
      <div class="pl-set-row">
        <div class="pl-set-name">Journal</div>
        <div class="pl-set-value">${seg('mode', [{ value: 'full', label: 'Full' }, { value: 'compact', label: 'Compact' }], s.journalMode)}</div>
        <div class="pl-set-note">Every entry in full, or one line per day.</div>
      </div>
      <div class="pl-set-foot">
        <button type="button" class="btn${s.confirmed ? '' : ' primary'} sm" data-act="confirm"${s.confirmed ? ' disabled' : ''}>${s.confirmed ? 'Confirmed' : 'These look right'}</button>
        <button type="button" class="btn sm" data-act="detect">Detect again</button>
      </div>
    </div>`;
}

const TITLES = {
  calendar: 'Choose the calendar file…',
  reports: 'Choose the reports folder…',
  journal: 'Choose the journal folder…',
};

/**
 * Draw Settings › Planner into `el` and keep it live.
 */
export function renderSettings(el: HTMLElement, store: ReturnType<typeof createStore>): { unmount: () => void; } {
  let alive = true;
  const draw = () => {
    if (!alive) return;
    // redraws keep the focused control focused, so a keyboard user never loses their place
    // what can hold the focus in `el` is its buttons: HTML elements
    const focus = document.activeElement && el.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const act = focus && (focus.dataset.act || '') + (focus.dataset.key || '') + (focus.dataset.v || '');
    el.innerHTML = html(store.get());
    if (act) {
      const again = [...el.querySelectorAll('button')].find((b) => (b.dataset.act || '') + (b.dataset.key || '') + (b.dataset.v || '') === act);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }
  };

  async function onClick(ev) {
    const b = ev.target.closest('button');
    if (!b || !el.contains(b) || b.disabled) return;
    const s = store.get();
    const segEl = b.closest('[data-pl-seg]');
    if (segEl) {
      const v = b.dataset.v;
      if (segEl.dataset.plSeg === 'q1') {
        const anchor = v === 'q1' || v === 'q2' ? q1AnchorFor(new Date(), v === 'q1') : undefined;
        store.set({ q1Anchor: anchor, q1Parity: null });
      }
      else if (segEl.dataset.plSeg === 'mode') store.set({ journalMode: v === 'compact' ? 'compact' : 'full' });
      return;
    }
    const key = b.dataset.key;
    switch (b.dataset.act) {
      case 'choose': {
        const row = ROWS.find((r) => r.key === key);
        if (!row) break;
        const picked = row.kind === 'folder'
          ? await pickFolder({ title: TITLES[key], current: s[key], enterLabel: 'choose' })
          : await pickFile({ title: TITLES[key], ext: 'md', current: s[key] });
        if (picked !== null && picked !== undefined && alive) store.set({ [key]: picked || null });
        break;
      }
      case 'clear': store.set({ [key]: null }); break;
      case 'add-todo': {
        const picked = await pickFile({ title: 'Add a todo file…', ext: 'md' });
        if (picked && alive) store.set({ todo: [...store.get().todo, picked] });
        break;
      }
      case 'remove-todo': {
        const i = Number(b.dataset.i);
        store.set({ todo: store.get().todo.filter((_, j) => j !== i) });
        break;
      }
      case 'confirm': store.set({ confirmed: true }); break;
      case 'detect': {
        const before = JSON.stringify(store.get());
        await store.detect();
        if (alive) toast(JSON.stringify(store.get()) === before ? 'Nothing new found.' : 'Filled in what was missing.', 'info', 3000);
        break;
      }
      default: break;
    }
  }

  el.addEventListener('click', onClick);
  const off = store.on(draw);
  draw();
  return {
    unmount() {
      alive = false;
      off();
      el.removeEventListener('click', onClick);
    },
  };
}
