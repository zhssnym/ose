// Today: one day, side by side, all from the planner folder. Left, the day's blocks from its
// month file's `# Timetable`, 07:00 to 23:30. Right, the systems due that day (from the month's
// plan and the check log) and the tasks of `todo.md` that belong on it.
//
// It opens on today (M32), or on the day `route.arg` names (`2026-10-05`, from the Planner): a
// check lands on the day in front of you, and left open overnight it moves to the new today with
// the date. The arrows and `t` move and come back; nothing is remembered.
//
// Writes, one line each: a system check is appended to `<plannings>/systems.jsonl` with
// `appendLine` (M30); a task toggle replaces its one line with `replaceLine`, only if the line
// still reads what was shown (M31); a new task is appended to todo.md.

import { esc, loadingLine, toast } from '../../ui/index.ts';
import {
  addDays, blockApplies, dayIndex, dayTitle, ddmm, hhmm, isSameDay, minutesOf, monthTitle, parseYmd, startOfDay, ym, ymd,
} from '../shared/dates.ts';
import { chooseTimetable } from '../shared/timetable.ts';
import {
  applies, blockId, checkRecord, logKey, logPath, parseMonthlyPlan, parseSystemsLog, resolvePlanPath, systemsFor,
} from '../shared/plans.ts';
import { groupsForDay, PRIORITY_RANK, taskDepth } from '../shared/tasks.ts';
import { createTodoIndex } from '../shared/todo.ts';
import {
  bindLinks, bindNav, detectedHtml, displayName, missingHtml, navHtml,
} from '../shared/nav.ts';
import { q1Of } from '../shared/settings.ts';

const LIMIT = 8;         // rows shown per todo file before "Show all"

/** `Wednesday 30 September`, with the year only when it is not this one. */
const titleOf = (d: Date): string => (d.getFullYear() === new Date().getFullYear() ? dayTitle(d).replace(/ \d{4}$/, '') : dayTitle(d));

/** The one `.empty` line of DESIGN.md. */
const note = (text) => `<div class="empty">${esc(text)}</div>`;

/** What is said beside a task, in quiet words: late or today, the date, a high priority. */
function taskChips(t) {
  const out: any[] = [];
  const today = ymd(new Date());
  if (t.due) {
    if (t.due < today) out.push(`<span class="td-late" title="Due ${esc(t.due)}">late</span>`);
    else if (t.due === today) out.push(`<span class="td-due" title="Due ${esc(t.due)}">today</span>`);
    else out.push(`<span class="td-meta mono-sm" title="Due">${esc(ddmm(parseYmd(t.due) || new Date()))}</span>`);
  } else if (t.scheduled) {
    out.push(`<span class="td-meta mono-sm" title="Scheduled">${esc(t.scheduled)}</span>`);
  }
  if (t.priority !== 'none' && PRIORITY_RANK[t.priority] <= 1) out.push('<span class="td-meta" title="Priority">high</span>');
  if (t.recurrence) out.push(`<span class="td-meta" title="Repeats">${esc(t.recurrence)}</span>`);
  return out.join('');
}

/** One task row: check, text, chips, and the line it came from (which opens the file there). */
function taskRow(t) {
  const depth = taskDepth(t);
  const source = `${t.path}:${t.line + 1}`;
  return `<div class="tk-row${t.done ? ' done' : ''}${depth ? ' sub' : ''}" style="--tk-depth:${depth}" title="${esc(source)}">
    <button type="button" class="tk-check" data-toggle="${esc(t.id)}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${esc(t.text)}"><span class="check${t.done ? ' on' : ''}"></span></button>
    <div class="tk-body"><span class="tk-text">${esc(t.text)}</span>${taskChips(t)}</div>
  </div>`;
}

/**
 * The Day view.
 * @param store the planner settings store
 * @returns the view definition
 */
export function createTodayView(ose: any, store: any): any {
  let live: { unmount(): void; refresh(): void; } | null = null;

  function mount(host, route) {
    const todo = createTodoIndex(ose);
    const asked = parseYmd(route && route.arg);
    const st: {
      cursor: Date; events: import('../shared/timetable.ts').TimetableEvent[];
      systems: Array<{ name: string; days: Set<number>; }>;
      log: { done: Map<string, boolean>; first: Map<string, string>; names: string[]; };
      planFile: string; planMissing: boolean; calMissing: boolean; logFile: string;
      ttFrom: 'month' | 'calendar' | null; ttPath: string;
      unknown: Array<{ line: number; text: string; }>; expanded: Set<string>; busy: boolean;
      seq: number; taskNote: string; shown: Map<string, any>;
    } = {
      cursor: startOfDay(asked || new Date()),
      events: [], systems: [], log: { done: new Map(), first: new Map(), names: [] },
      planFile: '', planMissing: false, calMissing: false, logFile: '', ttFrom: null, ttPath: '',
      unknown: [], expanded: new Set<any>(), busy: false, seq: 0, taskNote: '', shown: new Map(),
    };
    const offs: any[] = [];
    let tickTimer: ReturnType<typeof setTimeout> | null = null, alive = true;

    host.innerHTML = `
<div class="view-root" tabindex="-1">
  <div class="page-col td-col">
    <div class="v-head">
      <h1 class="page-title view-title" data-el="title">${esc(titleOf(st.cursor))}</h1>
      ${navHtml('day')}
    </div>
    <div class="page-meta" data-el="meta"></div>
    <div data-el="detected"></div>
    <div class="td">
      <div class="td-now" data-el="nowbox" hidden></div>
      <div class="td-grid">
        <section class="td-day">
          <div class="label">The day <span class="td-count" data-el="daycount"></span></div>
          <div class="td-list" data-el="tl"></div>
        </section>
        <div class="td-side">
          <section class="td-box">
            <div class="label">Tasks</div>
            <div class="td-list td-tasks" data-el="tasks"></div>
          </section>
          <section class="td-box">
            <div class="label">Systems <span class="td-count" data-el="syscount"></span></div>
            <div class="td-list" data-el="sys"></div>
          </section>
        </div>
      </div>
    </div>
  </div>
</div>`;
    const root = host.querySelector('.view-root');
    const $ = (name) => host.querySelector(`[data-el="${name}"]`);
    const settings = () => store.get();
    const isDone = (name, d) => st.log.done.get(logKey(ymd(d), name)) === true;

    /* ------------------------------------------------------------ timeline */

    function renderTimeline() {
      const box = $('tl');
      if (!box) return;
      const s = settings();
      if (!st.ttFrom) {
        box.classList.add('is-empty');
        box.innerHTML = !settings().reports ? missingHtml('reports')
          : st.planMissing ? `<div class="pl-quiet">No timetable: ${esc(monthTitle(st.cursor))} has no file yet. <button type="button" class="v-link" data-start-month>Start it</button> in the Planner.</div>`
          : `<div class="pl-quiet">No timetable: ${esc(monthTitle(st.cursor))}'s file has no # Timetable.</div>`;
        return;
      }
      box.classList.remove('is-empty');
      const d = dayIndex(st.cursor);
      const list = st.events.filter((e) => e.d === d && blockApplies(e, st.cursor, q1Of(s))).sort((a, b) => a.sm - b.sm);
      const count = $('daycount');
      if (!list.length) { box.innerHTML = note('Nothing in the timetable for this day'); if (count) count.textContent = ''; tick(); return; }
      // The day as a checklist of its blocks: a block is ticked where it is listed.
      let done = 0;
      box.innerHTML = list.map((e) => {
        const id = blockId(e.t, e.sm);
        const dn = isDone(id, st.cursor);
        if (dn) done++;
        return `<button type="button" class="td-blk t-${e.type}${dn ? ' done' : ''}" data-block="${esc(id)}" data-s="${e.sm}" data-e="${e.em}" aria-pressed="${dn}">
          <span class="check${dn ? ' on' : ''}"></span>
          <span class="td-time mono-sm">${hhmm(e.sm)} – ${hhmm(e.em % 1440)}</span>
          <span class="td-bar"></span>
          <span class="td-name">${esc(e.t)}</span>${e.sub ? `<span class="td-sub">${esc(e.sub)}</span>` : ''}${e.q ? `<span class="td-meta mono-sm">${e.q}</span>` : ''}
          <span class="td-nowtag">now</span>
        </button>`;
      }).join('');
      if (count) { count.textContent = `${done} of ${list.length}`; count.classList.toggle('ok', done === list.length); }
      tick();
    }

    function tick() {
      if (!alive) return;
      const box = $('nowbox');
      const today = isSameDay(st.cursor, new Date());
      const m = minutesOf();
      for (const node of host.querySelectorAll('.td-blk')) {
        const s = +node.dataset.s, e = +node.dataset.e;
        node.classList.toggle('past', today && e <= m);
        node.classList.toggle('live', today && s <= m && m < e);
      }
      if (!box) return;
      const d = dayIndex(st.cursor);
      const list = st.events.filter((e) => e.d === d && blockApplies(e, st.cursor, q1Of(settings()))).sort((a, b) => a.sm - b.sm);
      if (!today || !list.length) { box.hidden = true; return; }
      const cur = list.find((e) => e.sm <= m && m < e.em);
      const nxt = list.find((e) => e.sm > m);
      box.hidden = false;
      box.innerHTML = `
        <div class="td-now-row"><span class="td-now-k">Now</span>${cur
          ? `<span class="td-now-v">${esc(cur.t)}</span><span class="td-meta mono-sm">until ${hhmm(cur.em % 1440)}</span>`
          : '<span class="td-meta">Nothing scheduled</span>'}</div>
        <div class="td-now-row"><span class="td-now-k">Next</span>${nxt
          ? `<span class="td-now-v">${esc(nxt.t)}</span><span class="td-meta mono-sm">at ${hhmm(nxt.sm)}</span>`
          : '<span class="td-meta">Nothing else today</span>'}</div>`;
    }

    /* ------------------------------------------------------------- systems */

    function renderSystems() {
      const box = $('sys');
      if (!box) return;
      const s = settings();
      if (!s.reports) { box.innerHTML = missingHtml('reports'); return; }
      const list = st.systems.filter((x) => applies(x, st.cursor));
      if (!list.length) {
        box.innerHTML = (!st.systems.length && st.planMissing)
          ? note(`No plan for this month at ${st.planFile}`)
          : note(`No system is due on ${ddmm(st.cursor)}`);
        return;
      }
      const k = list.filter((x) => isDone(x.name, st.cursor)).length;
      const count = $('syscount');
      if (count) { count.textContent = `${k} of ${list.length}`; count.classList.toggle('ok', k === list.length); }
      box.innerHTML = `
          ${list.map((x) => {
            const dn = isDone(x.name, st.cursor);
            return `<button type="button" class="dy-sys-row${dn ? ' done' : ''}" data-system="${esc(x.name)}" aria-pressed="${dn}">
              <span class="check${dn ? ' on' : ''}"></span>
              <span class="dy-sys-name">${esc(x.name)}</span>
            </button>`;
          }).join('')}`;
    }

    async function toggleSystem(name) {
      if (st.busy || !st.logFile) return;
      st.busy = true;
      const date = ymd(st.cursor), k = logKey(date, name);
      const prev = st.log.done.get(k);
      const next = prev !== true;
      st.log.done.set(k, next);                                // optimistic
      const firstBefore = st.log.first.get(name);
      if (!firstBefore || date < firstBefore) st.log.first.set(name, date);
      renderSystems();
      renderTimeline();
      try {
        await ose.files.appendLine(st.logFile, JSON.stringify(checkRecord(st.cursor, name, next)));
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        console.error('[planner] system write', e);
        if (prev === undefined) st.log.done.delete(k); else st.log.done.set(k, prev);
        if (firstBefore === undefined) st.log.first.delete(name); else st.log.first.set(name, firstBefore);
        renderSystems();
        renderTimeline();
        toast(`The check was not written: ${(e && e.message) || e}`, 'err');
      } finally {
        st.busy = false;
      }
    }

    /* --------------------------------------------------------------- tasks */

    function group(g, labelled) {
      const list = [...g.overdue, ...g.due, ...g.undated];
      const open = st.expanded.has(g.path);
      const shown = open ? list : list.slice(0, LIMIT);
      const rest = list.length - shown.length;
      const head = labelled
        ? `<div class="dy-box-head">
             <button type="button" class="dy-grp-head" data-path="${esc(g.path)}" title="${esc(g.path)}">${esc(displayName(ose, g.path))}</button>
             <span class="mono-sm faint">${list.length}</span>
           </div>`
        : '';
      const body = g.missing ? note(`Nothing at ${g.path}`)
        : g.error ? note(`Could not read ${g.path}: ${g.error}`)
        : list.length ? shown.map(taskRow).join('')
        : note('Nothing due, nothing late');
      return `<div class="td-group">${head}${body}
        ${rest ? `<button type="button" class="dy-more mono-sm" data-more="${esc(g.path)}">Show all ${list.length}</button>` : ''}
      </div>`;
    }

    function renderTasks() {
      const box = $('tasks');
      if (!box) return;
      const s = settings();
      if (!s.todo.length) { box.innerHTML = missingHtml('todo'); return; }
      // the card is rebuilt whole; what is half typed in the foot line, and the caret, survive
      const was = box.querySelector('[data-el="add"]');
      const draft = was ? was.value : '';
      const hadFocus = !!was && document.activeElement === was;
      const caret = was ? was.selectionStart : 0;
      const files = todo.files();
      const byPath = new Map<string, any>(files.map((f) => [f.path, f]));
      st.shown = new Map(files.flatMap((f) => f.tasks).map((t) => [t.id, t]));
      const groups = groupsForDay(st.cursor, files).map((g) => ({ ...g, missing: byPath.get(g.path)?.missing, error: byPath.get(g.path)?.error }));
      const labelled = s.todo.length > 1;
      const target = s.todo[0];
      box.innerHTML = (st.taskNote ? `<div class="pl-quiet">${esc(st.taskNote)}</div>` : '')
        + groups.map((g) => group(g, labelled)).join('')
        + `<div class="dy-add">
            <input type="text" class="input dy-add-in" data-el="add" autocomplete="off" spellcheck="false"
              aria-label="New task in ${esc(displayName(ose, target))}" placeholder="New task${labelled ? ` in ${esc(displayName(ose, target))}` : ''}" value="${esc(draft)}">
          </div>`;
      if (hadFocus) {
        const now = box.querySelector('[data-el="add"]');
        now.focus({ preventScroll: true });
        now.setSelectionRange(caret, caret);
      }
    }

    async function onAddTask(input) {
      if (st.busy) return;
      const text = input.value.trim();
      const target = settings().todo[0];
      if (!text || !target) return;
      st.busy = true;
      input.value = '';                       // a second Enter on a slow write sends nothing twice
      try {
        let r = await todo.add(target, text);
        if (r === 'missing') {
          // The planner folder has no todo.md yet: the first task makes it (never over a file).
          const cut = target.lastIndexOf('/');
          try { await ose.fileops.create(cut < 0 ? '' : target.slice(0, cut), target.slice(cut + 1), { text: '# Todo\n\n' }); } catch { /* there after all */ }
          r = await todo.add(target, text);
        }
        if (r === 'missing') {
          input.value = text;
          toast(`Nothing to add to at ${target}`, 'warn');
        }
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        input.value = text;
        console.error('[planner] add task', e);
        toast(`The task was not written: ${(e && e.message) || e}`, 'err');
      } finally {
        st.busy = false;
        renderTasks();
      }
    }

    async function onToggleTask(id) {
      if (st.busy) return;
      st.busy = true;
      try {
        // the task as drawn, never as the index reads now: a newer read may have shifted the
        // lines under the rows, and replaceLine must expect what the click was on (M31)
        const res = await todo.toggle(st.shown.get(id) || null);
        st.taskNote = res === 'changed' ? 'The todo file changed; reloaded.' : '';
        renderTasks();
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        console.error('[planner] task write', e);
        toast(`The task was not written: ${(e && e.message) || e}`, 'err');
      } finally {
        st.busy = false;
      }
    }

    /* -------------------------------------------------------------- render */

    function renderMeta() {
      const box = $('meta');
      if (!box) return;
      const s = settings();
      // The files are named in Settings › Views; the page only says when a line could not be read.
      const links: string[] = [];
      if (st.unknown.length) {
        const where = st.unknown.map((u) => u.line).join(', ');
        links.push(`<button type="button" class="v-link pl-unknown" data-path="${esc(st.ttPath)}" data-line="${st.unknown[0]?.line}" title="Timetable lines ${esc(where)}">${st.unknown.length} line${st.unknown.length === 1 ? '' : 's'} not understood</button>`);
      }
      box.innerHTML = links.join('');
      box.hidden = !links.length;
      $('detected').innerHTML = s.confirmed ? '' : detectedHtml();
    }

    function render({ tasks = true } = {}) {
      if (!alive) return;
      $('title').textContent = titleOf(st.cursor);
      host.querySelector('[data-nav="today"]').hidden = isSameDay(st.cursor, new Date());
      renderMeta();
      renderTimeline();
      renderSystems();
      if (tasks) renderTasks();
    }

    async function load() {
      await store.ready;
      const my = ++st.seq;
      const at = st.cursor;
      const s = settings();
      st.logFile = s.reports ? logPath(s.reports) : '';
      todo.setPaths(s.todo);
      const stops: [() => boolean, () => boolean, () => boolean] = [
        loadingLine(s.calendar || s.reports ? $('tl') : null),
        loadingLine(s.reports ? $('sys') : null),
        loadingLine(s.todo.length ? $('tasks') : null),
      ];
      const stop = () => stops.forEach((f) => f());
      try {
        const readIf = async (p) => {
          if (!p) return { exists: false, text: '' };
          if (!(await ose.files.exists(p))) return { exists: false, text: '' };
          return { exists: true, text: await ose.files.read(p) };
        };
        const [cal, found, logText] = await Promise.all([
          readIf(s.calendar),
          s.reports ? resolvePlanPath((f) => ose.files.list(f), at, s.reports) : { path: '', exists: false },
          readIf(st.logFile),
        ]);
        const planText = found.exists ? await ose.files.read(found.path) : '';
        if (my !== st.seq || !alive) return;
        const tt = chooseTimetable(
          found.exists ? { path: found.path, text: planText } : null,
          s.calendar ? { path: s.calendar, exists: cal.exists, text: cal.text } : null,
        );
        st.ttFrom = tt.from;
        st.ttPath = tt.path || '';
        st.calMissing = tt.from === 'calendar' && !tt.exists;
        st.events = tt.events;
        st.unknown = tt.unknown;
        st.planFile = found.path;
        st.planMissing = !!s.reports && !found.exists;
        st.log = parseSystemsLog(logText.text);
        st.systems = systemsFor(planText ? parseMonthlyPlan(planText) : null, st.log, at);
        stops[0](); stops[1]();
        render({ tasks: false });
        await todo.load();
        if (my !== st.seq || !alive) return;
        stops[2]();
        renderTasks();
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        console.error('[planner] day', e);
        toast(`Day: ${(e && e.message) || e}`, 'err');
      } finally {
        stop();
      }
    }

    function go(delta) {
      st.cursor = delta === 0 ? startOfDay(new Date()) : addDays(st.cursor, delta);
      st.expanded = new Set<any>();
      st.taskNote = '';
      load();
    }

    function onClick(ev) {
      const sys = ev.target.closest('[data-system]');
      if (sys) { toggleSystem(sys.dataset.system); return; }
      // a block of the strip is ticked where it is drawn
      const blk = ev.target.closest('[data-block]');
      if (blk) { toggleSystem(blk.dataset.block); return; }
      const tg = ev.target.closest('[data-toggle]');
      if (tg) { onToggleTask(tg.dataset.toggle); return; }
      const more = ev.target.closest('[data-more]');
      if (more) { st.expanded.add(more.dataset.more); renderTasks(); }
    }

    function onKeydown(ev) {
      const input = ev.target.closest ? ev.target.closest('[data-el="add"]') : null;
      if (!input) return;
      if (ev.key === 'Enter') { ev.preventDefault(); void onAddTask(input); return; }
      if (ev.key === 'Escape' && input.value) { ev.preventDefault(); ev.stopPropagation(); input.value = ''; }
    }

    host.addEventListener('click', onClick);
    host.addEventListener('keydown', onKeydown);
    offs.push(() => host.removeEventListener('click', onClick));
    offs.push(() => host.removeEventListener('keydown', onKeydown));
    offs.push(bindNav(root, { prev: () => go(-1), next: () => go(1), today: () => go(0) }));
    offs.push(bindLinks(root, ose));
    // "Start it": the Planner's month page, where the Start button is.
    const onStart = (ev) => {
      if (ev.target instanceof Element && ev.target.closest('[data-start-month]')) {
        ose.route.navigate({ type: 'view', name: 'planner', arg: `month:${ym(st.cursor)}` });
      }
    };
    root.addEventListener('click', onStart);
    offs.push(() => root.removeEventListener('click', onStart));
    offs.push(store.on(() => load()));
    // one of the files this day reads changed on disk: read again; anything else is not ours
    offs.push(ose.watch((d) => {
      const s = settings();
      const mine = (p) => !!p && (p === s.calendar || todo.touches(p)
        || (!!s.reports && (p === s.reports || p.startsWith(`${s.reports}/`))));
      if (!d || d.lost || d.rescan || (d.changes || []).some((c) => c && (mine(c.path) || mine(c.to)))) {
        todo.markStale();
        load();
      }
    }));

    // Left open past midnight: a view that was on today moves to the new today, so a check lands
    // on the day in front of you (M32); one that was on another day stays and only redraws.
    let lastDay = startOfDay(new Date());
    tickTimer = setInterval(() => {
      const today = startOfDay(new Date());
      if (!isSameDay(today, lastDay)) {
        const wasToday = isSameDay(st.cursor, lastDay);
        lastDay = today;
        if (wasToday) { go(0); return; }
        render();
      }
      tick();
    }, 30000);
    root.focus({ preventScroll: true });
    load();

    const handle = {
      unmount() {
        alive = false;
        clearInterval(tickTimer);
        for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
        if (live === handle) live = null;
      },
      // The router calls this on every change anywhere in the vault and on a settings change;
      // the files this view reads are its own watch's business, so a refresh only redraws.
      refresh() { if (alive) render(); },
    };
    live = handle;
    return handle;
  }

  return {
    title: 'Today',
    order: 10,
    icon: 'day',
    section: 'planner',
    mount: (el, route) => mount(el, route),
    unmount: () => live && live.unmount(),
    refresh: () => live && live.refresh(),
  };
}
