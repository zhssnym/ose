// Day: one day, side by side. Left, the calendar's blocks for that weekday, 07:00 to 23:30.
// Right, the systems due that day (from the month's plan and the check log) and the tasks that
// belong on it, file by file (M34).
//
// It always opens on today (M32): a check lands on the day in front of you, never on the last
// day someone navigated to, and left open overnight it moves to the new today with the date.
// The arrows and `t` move and come back; nothing is remembered.
//
// Writes, one line each: a system check is appended to `<reports>/systems.jsonl` with
// `appendLine` (M30); a task toggle replaces its one line with `replaceLine`, only if the line
// still reads what was shown (M31); a new task is appended to the first todo file.

import { esc, loadingLine, toast } from 'ose:ui';
import {
  addDays, blockApplies, dayIndex, dayTitle, ddmm, hhmm, isSameDay, minutesOf, startOfDay, ymd,
} from '../shared/dates.ts';
import { lanes, parseTimetable, TIMETABLE } from '../shared/timetable.ts';
import {
  applies, checkRecord, logKey, logPath, parseMonthlyPlan, parseSystemsLog, resolvePlanPath, systemsFor,
} from '../shared/plans.ts';
import { groupsForDay, PRIORITY_RANK, taskDepth } from '../shared/tasks.ts';
import { createTodoIndex } from '../shared/todo.ts';
import {
  bindLinks, bindNav, detectedHtml, displayName, goneHtml, missingHtml, navHtml,
} from '../shared/nav.ts';
import { q1Of } from '../shared/settings.ts';

const { START, END, HOUR_H } = TIMETABLE;
const BODY_H = (END - START) * HOUR_H;
const NARROW = 900;      // main-column width below which the two columns stack
const TIME_MIN = 40;     // px of block height before the times fit under the name
const SUB_MIN = 72;      // and before the room or note fits under those
const NAME_H = 17, PAD_MIN = 25;
const LIMIT = 8;         // rows shown per todo file before "Show all"

/** The one `.empty` line of DESIGN.md. */
const note = (text) => `<div class="empty">${esc(text)}</div>`;

/** The date and priority chips for one task. */
function taskChips(t) {
  const out: any[] = [];
  const today = ymd(new Date());
  if (t.due) {
    const cls = t.due < today ? 'err' : t.due === today ? 'accent' : '';
    out.push(`<span class="chip ${cls}" title="Due">${esc(t.due)}</span>`);
  } else if (t.scheduled) {
    out.push(`<span class="chip" title="Scheduled">${esc(t.scheduled)}</span>`);
  }
  if (t.priority !== 'none') {
    const cls = PRIORITY_RANK[t.priority] <= 1 ? 'err' : t.priority === 'medium' ? 'accent' : '';
    out.push(`<span class="chip ${cls}" title="Priority">${esc(t.priority)}</span>`);
  }
  if (t.recurrence) out.push(`<span class="chip" title="Repeats">${esc(t.recurrence)}</span>`);
  return out.join('');
}

/** One task row: check, text, chips, and the line it came from (which opens the file there). */
function taskRow(t) {
  const depth = taskDepth(t);
  const source = `${t.path}:${t.line + 1}`;
  return `<div class="tk-row${t.done ? ' done' : ''}${depth ? ' sub' : ''}" style="--tk-depth:${depth}">
    <button type="button" class="tk-check" data-toggle="${esc(t.id)}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${esc(t.text)}"><span class="check${t.done ? ' on' : ''}"></span></button>
    <div class="tk-body"><span class="tk-text">${esc(t.text)}</span>${taskChips(t)}</div>
    <button type="button" class="tk-src mono-sm" data-path="${esc(t.path)}" data-line="${t.line + 1}" title="${esc(source)}">:${t.line + 1}</button>
  </div>`;
}

/**
 * The Day view.
 * @param store the planner settings store
 * @returns the view definition
 */
export function createDayView(ose: any, store: any): any {
  let live: { unmount(): void; refresh(): void; } | null = null;

  function mount(host) {
    const todo = createTodoIndex(ose);
    const st: {
      cursor: Date; events: import('../shared/timetable.ts').TimetableEvent[];
      systems: Array<{ name: string; days: Set<number>; }>;
      log: { done: Map<string, boolean>; first: Map<string, string>; names: string[]; };
      planFile: string; planMissing: boolean; calMissing: boolean; logFile: string;
      unknown: Array<{ line: number; text: string; }>; expanded: Set<string>; busy: boolean;
      seq: number; taskNote: string; shown: Map<string, any>;
    } = {
      cursor: startOfDay(new Date()),
      events: [], systems: [], log: { done: new Map(), first: new Map(), names: [] },
      planFile: '', planMissing: false, calMissing: false, logFile: '',
      unknown: [], expanded: new Set<any>(), busy: false, seq: 0, taskNote: '', shown: new Map(),
    };
    const offs: any[] = [];
    let tickTimer: ReturnType<typeof setTimeout> | null = null, ro: ResizeObserver | null = null, alive = true;

    host.innerHTML = `
<div class="view-root" tabindex="-1">
  <div class="page-col">
    <div class="v-head">
      <h1 class="page-title view-title" data-el="title">${esc(dayTitle(st.cursor))}</h1>
      ${navHtml('day')}
    </div>
    <div class="page-meta" data-el="meta">&nbsp;</div>
    <div data-el="detected"></div>
    <div class="dy-split">
      <div class="dy-left">
        <div class="label">Timeline</div>
        <div class="dy-tl" data-el="tl" style="--dy-body:${BODY_H}px"></div>
      </div>
      <div class="dy-right">
        <div class="label">Systems</div>
        <div class="dy-card" data-el="sys"></div>
        <div class="label">Tasks</div>
        <div class="dy-card dy-tasks" data-el="tasks"></div>
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
      if (!s.calendar) { box.classList.add('is-empty'); box.innerHTML = missingHtml('calendar'); return; }
      if (st.calMissing) { box.classList.add('is-empty'); box.innerHTML = goneHtml(s.calendar); return; }
      box.classList.remove('is-empty');
      const d = dayIndex(st.cursor);
      const list = st.events.filter((e) => e.d === d && blockApplies(e, st.cursor, q1Of(s)));
      const out = ['<div class="dy-times">'];
      for (let h = Math.ceil(START); h <= Math.floor(END); h++) {
        const y = (h - START) * HOUR_H;
        out.push(`<div class="dy-t mono-sm" style="top:${Math.max(0, y - 6)}px">${String(h).padStart(2, '0')}h</div>`);
      }
      out.push('</div><div class="dy-track">');
      for (let h = Math.ceil(START) + 1; h <= Math.floor(END); h++) {
        out.push(`<div class="dy-line" style="top:${(h - START) * HOUR_H}px"></div>`);
      }
      for (const { e, lane, lanes: n } of lanes(list)) {
        const top = (e.sm / 60 - START) * HOUR_H;
        const h = Math.max(NAME_H, (e.em - e.sm) / 60 * HOUR_H - 2);
        const time = h >= TIME_MIN ? `<span class="dy-ev-t mono-sm">${hhmm(e.sm)} to ${hhmm(e.em)}</span>` : '';
        const sub = e.sub && h >= SUB_MIN ? `<span class="dy-ev-s mono-sm">${esc(e.sub)}</span>` : '';
        const q = e.q ? `<span class="dy-ev-q mono-sm">${e.q}</span>` : '';
        const title = `${e.q ? `${e.q} · ` : ''}${e.t}${e.sub ? ` · ${e.sub}` : ''} · ${hhmm(e.sm)} to ${hhmm(e.em)}`;
        out.push(`<div class="dy-ev t-${e.type}${h < PAD_MIN ? ' tight' : ''}" data-s="${e.sm}" data-e="${e.em}" style="top:${top}px;height:${h}px;--lane:${lane};--lanes:${n}" title="${esc(title)}"><span class="dy-ev-n">${q}${esc(e.t)}</span>${time}${sub}</div>`);
      }
      out.push('<div class="dy-now" data-el="now" hidden><span class="dy-now-dot"></span></div></div>');
      box.innerHTML = out.join('');
      if (!list.length) box.insertAdjacentHTML('beforeend', '<div class="dy-tl-empty empty">Nothing in the calendar for this day</div>');
      tick();
    }

    function tick() {
      if (!alive) return;
      const line = $('now');
      if (!line) return;
      if (!isSameDay(st.cursor, new Date())) { line.hidden = true; return; }
      const m = minutesOf();
      const y = (m / 60 - START) * HOUR_H;
      line.hidden = y < 0 || y > BODY_H;
      line.style.top = `${y}px`;
      for (const node of host.querySelectorAll('.dy-ev')) {
        const s = +node.dataset.s, e = +node.dataset.e;
        node.classList.toggle('past', e <= m);
        node.classList.toggle('live', s <= m && m < e);
      }
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
      box.innerHTML = `
        <div class="dy-box">
          <div class="dy-box-head">
            <span class="mono-sm faint">${esc(ddmm(st.cursor))}</span>
            <span class="mono-sm${k === list.length ? ' ok' : ''}">${k} / ${list.length}</span>
          </div>
          ${list.map((x) => {
            const dn = isDone(x.name, st.cursor);
            return `<button type="button" class="dy-sys-row${dn ? ' done' : ''}" data-system="${esc(x.name)}" aria-pressed="${dn}">
              <span class="check${dn ? ' on' : ''}"></span>
              <span class="dy-sys-name">${esc(x.name)}</span>
            </button>`;
          }).join('')}
        </div>`;
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
      try {
        await ose.files.appendLine(st.logFile, JSON.stringify(checkRecord(st.cursor, name, next)));
      } catch (err) {
        const e = (err as { code?: string, message?: string });
        console.error('[planner] system write', e);
        if (prev === undefined) st.log.done.delete(k); else st.log.done.set(k, prev);
        if (firstBefore === undefined) st.log.first.delete(name); else st.log.first.set(name, firstBefore);
        renderSystems();
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
      return `<div class="dy-box">${head}${body}
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
        if (await todo.add(target, text) === 'missing') {
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
      const files = [s.calendar && !st.calMissing ? s.calendar : '', st.planMissing ? '' : st.planFile, st.logFile, ...s.todo];
      const links = files.filter(Boolean).map((p) => `<button type="button" class="v-link" data-path="${esc(p)}">${esc(p)}</button>`);
      if (st.unknown.length) {
        const where = st.unknown.map((u) => u.line).join(', ');
        links.push(`<button type="button" class="v-link pl-unknown" data-path="${esc(s.calendar)}" data-line="${st.unknown[0]?.line}" title="Calendar lines ${esc(where)}">${st.unknown.length} line${st.unknown.length === 1 ? '' : 's'} not understood</button>`);
      }
      box.innerHTML = links.join('') || '&nbsp;';
      $('detected').innerHTML = s.confirmed ? '' : detectedHtml();
    }

    function render({ tasks = true } = {}) {
      if (!alive) return;
      $('title').textContent = dayTitle(st.cursor);
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
        loadingLine(s.calendar ? $('tl') : null),
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
        st.calMissing = !!s.calendar && !cal.exists;
        const tt = parseTimetable(cal.text);
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

    const fit = (w) => root.classList.toggle('narrow', w < NARROW);
    fit(host.clientWidth);
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver((entries) => fit((entries[0] as ResizeObserverEntry).contentRect.width));
      ro.observe(host);
    }
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
        if (ro) ro.disconnect();
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
    title: 'Day',
    order: 10,
    icon: 'day',
    section: 'planner',
    mount: (el) => mount(el),
    unmount: () => live && live.unmount(),
    refresh: () => live && live.refresh(),
  };
}
