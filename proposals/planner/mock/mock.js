/* The mock: the planner's four pages (Day, Week, Month, Year) drawn from the example files by
   the reader in planner.js, inside a still picture of the app's frame. Nothing is written
   anywhere: a click changes the text held in memory with the same one-line replace the app
   would send to the host, and the status bar shows that line. */
(function () {
  'use strict';

  const P = window.Planner;
  const FILES = { ...window.PLANNER_FILES };
  const FOLDER = 'plannings';

  // The mock's clock, fixed so the pages always match the examples: Thursday 15 October 2026, 17h10.
  const NOW = new Date(2026, 9, 15, 17, 10);
  const TODAY = P.startOfDay(NOW);
  const NOW_MIN = NOW.getHours() * 60 + NOW.getMinutes();
  // Months kept before this format: goals and a review, no week, no days. Read, never changed.
  const OLD = new Set(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);

  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const ZOOMS = [['year', 'Year'], ['month', 'Month'], ['week', 'Week'], ['day', 'Day']];

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const svg = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
  const ICON = {
    chevron: '<path d="M6.25 3.5L10.75 8l-4.5 4.5"/>',
    folder: '<path d="M2.25 4.25A1.25 1.25 0 0 1 3.5 3h2.35l1.4 1.75h5.25A1.25 1.25 0 0 1 13.75 6v5.75A1.25 1.25 0 0 1 12.5 13h-9a1.25 1.25 0 0 1-1.25-1.25z"/>',
    page: '<path d="M3.75 2.25h8.5v11.5h-8.5z"/><path d="M6 5.75h4M6 8.25h4M6 10.75h2.5"/>',
    day: '<rect x="2.5" y="2.5" width="11" height="11"/><circle cx="8" cy="8" r="1.9" fill="currentColor" stroke="none"/>',
    month: '<g fill="currentColor" stroke="none">' + [1.5, 4.5, 7.5, 10.5].map((y) => [1.5, 4.5, 7.5, 10.5].map((x) => `<rect x="${x}" y="${y}" width="2" height="2"/>`).join('')).join('') + '</g>',
    journal: '<path d="M3.25 2.75h6.5a2 2 0 0 1 2 2v8.5h-6.5a2 2 0 0 1-2-2z"/><path d="M3.25 10.75h8.5M6 5.5h3.25"/>',
    plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
    close: '<path d="M3.75 3.75l8.5 8.5M12.25 3.75l-8.5 8.5"/>',
  };

  const pct = (done, due) => (due ? Math.round((100 * done) / due) : 0);
  const hm = (min) => `${Math.floor(min / 60)}h${P.two(min % 60)}`;
  const ord = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
  const shortDate = (d) => `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  const paras = (text) => String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  /* ------------------------------------------------------------------ the files, read */

  let months = new Map(), year = null, todo = [];

  /** `- [ ] text 📅 2026-10-12`: the task lines of todo.md, with the line each sits on. */
  function parseTodo(text) {
    const out = [];
    String(text || '').split('\n').forEach((raw, line) => {
      const m = /^(\s*)[-*]\s\[([ xX])\]\s+(.*)$/.exec(raw);
      if (!m) return;
      const body = m[3];
      const due = (/\u{1F4C5}️?\s*(\d{4}-\d{2}-\d{2})/u.exec(body) || [])[1] || null;
      const doneOn = (/✅️?\s*(\d{4}-\d{2}-\d{2})/u.exec(body) || [])[1] || null;
      const words = body.replace(/\s*[\u{1F4C5}✅⏳\u{1F6EB}➕]️?\s*\d{4}-\d{2}-\d{2}/gu, '').trim();
      out.push({ line, raw, depth: Math.floor(m[1].replace(/\t/g, '  ').length / 2), done: m[2] !== ' ', text: words, due, doneOn });
    });
    return out;
  }

  function load() {
    months = new Map();
    for (const name of Object.keys(FILES)) {
      const m = /^(\d{4}-\d{2})\.md$/.exec(name);
      if (m) months.set(m[1], P.parseMonth(FILES[name], m[1]));
    }
    year = P.parseYear(FILES['2026.md'], 2026);
    todo = parseTodo(FILES['todo.md']);
  }

  const monthOf = (date) => months.get(P.ymOf(date)) || null;

  /* ------------------------------------------------------------------ state, and the writes */

  const state = { zoom: 'day', date: TODAY, last: 'month', yday: false, said: '', path: '' };

  /** One line of one file, only if it still reads what was shown: the host's `replaceLine`. */
  function replaceLine(name, w) {
    if (!w) return;
    const lines = FILES[name].split('\n');
    if (lines[w.line] !== w.expected) { state.said = `${name} changed under the page; read again`; load(); return; }
    lines[w.line] = w.next;
    FILES[name] = lines.join('\n');
    state.said = `replaceLine  ${FOLDER}/${name}:${w.line + 1}  ${w.next}`;
    load();
  }

  /** A mark on a day: done and back, or (with `skip`) dropped for the day and back. */
  function tick(dayYmd, sys, skip) {
    const d = P.parseYmd(dayYmd);
    const month = d && monthOf(d);
    if (!month || !month.days || d > TODAY) return;
    const st = P.stateOf(month, d.getDate(), sys, TODAY);
    const planned = P.plannedSystems(month, d).includes(sys);
    const back = planned ? '.' : '';
    const mark = skip ? (st === 'skipped' ? back : '-') : (st === 'done' ? back : 'x');
    replaceLine(`${month.ym}.md`, P.writeMark(month, d.getDate(), sys, mark));
  }

  function toggleTask(line) {
    const t = todo.find((x) => x.line === line);
    if (!t) return;
    const next = t.done
      ? t.raw.replace(/\[[xX]\]/, '[ ]').replace(/\s*✅️?\s*\d{4}-\d{2}-\d{2}/u, '')
      : `${t.raw.replace(/\[ \]/, '[x]').replace(/\s+$/, '')} ✅ ${P.ymd(TODAY)}`;
    replaceLine('todo.md', { line, expected: t.raw, next });
  }

  function addTask(text) {
    const line = `- [ ] ${text.trim()}`;
    FILES['todo.md'] = `${FILES['todo.md'].replace(/\n*$/, '\n')}${line}\n`;
    state.said = `appendLine  ${FOLDER}/todo.md  ${line}`;
    load();
  }

  /* ------------------------------------------------------------------ the page's frame */

  function page({ zoom, title, unit, meta, body, here }) {
    return `<div class="view-root" tabindex="-1"><div class="page-col pv">
      <div class="pn-zoom" role="group" aria-label="Zoom">${ZOOMS.map(([z, label]) =>
        `<button type="button" class="pn-zoom-b${z === zoom ? ' on' : ''}" data-act="zoom" data-zoom="${z}" aria-pressed="${z === zoom}">${label}</button>`).join('')}</div>
      <div class="v-head">
        <h1 class="page-title view-title">${esc(title)}</h1>
        <div class="v-nav">
          <button type="button" class="btn sm" data-act="nav" data-nav="prev" aria-label="Previous ${unit}">&lsaquo;</button>
          <button type="button" class="btn sm" data-act="nav" data-nav="today"${here ? ' hidden' : ''}>Today</button>
          <button type="button" class="btn sm" data-act="nav" data-nav="next" aria-label="Next ${unit}">&rsaquo;</button>
        </div>
      </div>
      <div class="page-meta">${meta.filter(Boolean).map((m) => `<button type="button" class="v-link" title="Opens ${esc(FOLDER)}/${esc(m)}">${esc(m)}</button>`).join('')}</div>
      ${body}
    </div></div>`;
  }

  const head = (label, sum = '') => `<div class="pv-head"><span class="label">${esc(label)}</span><span class="pv-sum">${esc(sum)}</span></div>`;
  const prose = (text) => `<div class="md-render">${paras(text).map((p) => `<p>${esc(p.replace(/\s*\n\s*/g, ' '))}</p>`).join('')}</div>`;

  /* ------------------------------------------------------------------ day */

  /** One line of a day: its time, its box, its words, its run. */
  function lineHtml(month, d, l) {
    const key = P.ymd(d);
    const isToday = +d === +TODAY, future = d > TODAY;
    const when = l.start !== null ? P.hhmm(l.start) : '';
    const tip = l.start !== null ? `${P.hhmm(l.start)} to ${P.hhmm(l.end)}` : '';
    const what = `${esc(l.name)}${l.where ? ` <span class="pv-where">· ${esc(l.where)}</span>` : ''}`;
    if (!l.system) {
      return `<div class="pv-line is-plain" title="${tip}"><span class="pv-when">${when}</span><span></span><span class="pv-what">${what}</span><span></span></div>`;
    }
    const st = P.stateOf(month, d.getDate(), l.system, TODAY);
    const now = isToday && l.start !== null && l.start <= NOW_MIN && NOW_MIN < l.end;
    const run = st === 'missed' ? 0 : P.streak(months, l.system, TODAY, d);
    const box = st === 'done' ? ' on' : st === 'skipped' ? ' skip' : '';
    const inner = `<span class="pv-when">${when}</span><span class="check${box}"></span><span class="pv-what">${what}</span>`
      + `<span class="pv-much" title="${run >= 2 ? `${run} days in a row` : ''}">${run >= 2 ? `${run} days` : ''}</span>`;
    if (future) return `<div class="pv-line is-${st}" title="${tip}">${inner}</div>`;
    return `<button type="button" class="pv-line is-${st}${now ? ' is-now' : ''}" data-act="tick" data-day="${key}" data-sys="${esc(l.system)}" data-key="tick:${key}:${esc(l.system)}:${l.line}" aria-pressed="${st === 'done'}" title="${tip}">${inner}</button>`;
  }

  /** The lines of a day, with any system marked done that the week did not plan. */
  function linesOf(month, d) {
    const lines = P.linesFor(month, d);
    const planned = P.plannedSystems(month, d);
    const row = month.days ? month.days.rows.get(d.getDate()) : null;
    const extra = row ? Object.keys(row.marks).filter((s) => row.marks[s] === 'x' && !planned.includes(s)) : [];
    return [...lines, ...extra.map((s) => ({ name: s, where: '', start: null, end: null, system: s, line: -1 }))];
  }

  /** `done of due` for one day: a skipped line is out of both. */
  function dayCount(month, d) {
    const systems = [...new Set(linesOf(month, d).map((l) => l.system).filter(Boolean))];
    const states = systems.map((s) => P.stateOf(month, d.getDate(), s, TODAY));
    return { done: states.filter((s) => s === 'done').length, due: states.filter((s) => s && s !== 'skipped').length, skipped: states.filter((s) => s === 'skipped').length };
  }

  /** On today only: what yesterday left open, one quiet line that unfolds into its lines. */
  function yesterday(d) {
    if (+d !== +TODAY) return '';
    const y = P.addDays(d, -1), ym = monthOf(y);
    const open = ym ? linesOf(ym, y).filter((l) => l.system && P.stateOf(ym, y.getDate(), l.system, TODAY) === 'missed') : [];
    if (!open.length) return '';
    const yc = dayCount(ym, y);
    return `<div class="pv-day pv-yday"><div>
      <div class="pl-quiet">Yesterday closed at ${yc.done} of ${yc.due}. <button type="button" class="v-link" data-act="yday" data-key="yday" aria-expanded="${state.yday}">${state.yday ? 'Fold' : 'Fill it in'}</button></div>
      ${state.yday ? `<div class="pv-lines is-past">${open.map((l) => lineHtml(ym, y, l)).join('')}</div>` : ''}
    </div><div></div></div>`;
  }

  function dayColumn(month, d) {
    const isToday = +d === +TODAY, future = d > TODAY;
    const lines = linesOf(month, d);
    const c = dayCount(month, d);
    const row = month.days ? month.days.rows.get(d.getDate()) : null;
    const note = future ? '' : `<input type="text" class="pv-field pv-note" data-act="note" data-day="${P.ymd(d)}" data-key="note" autocomplete="off" spellcheck="false"
      aria-label="A line about ${isToday ? 'today' : 'this day'}" placeholder="A line about ${isToday ? 'today' : 'this day'}" value="${esc(row ? row.note : '')}">`;
    return `<section>
      ${head(isToday ? 'Today' : 'Day', !lines.length ? '' : future ? `${c.due} planned` : `${c.done} of ${c.due}`)}
      <div class="pv-lines${!isToday && !future ? ' is-past' : ''}">${lines.map((l) => lineHtml(month, d, l)).join('') || '<div class="pv-empty">Nothing planned on this day</div>'}</div>
      ${note}
    </section>`;
  }

  function tasksColumn(d) {
    const key = P.ymd(d);
    const open = todo.filter((t) => !t.done && (!t.due || t.due <= key));
    const closed = todo.filter((t) => t.done && t.doneOn === key);
    const rank = (t) => (t.due && t.due < key ? 0 : t.due === key ? 1 : 2);
    open.sort((a, b) => rank(a) - rank(b) || String(a.due || '').localeCompare(String(b.due || '')) || a.line - b.line);
    const rowOf = (t) => {
      const late = !t.done && t.due && t.due < key;
      const said = t.done ? '' : late ? `late · ${t.due.slice(8)}/${t.due.slice(5, 7)}` : t.due === key ? 'today' : '';
      return `<div class="pv-task${t.done ? ' is-done' : ''}" style="--d:${t.depth}">
        <button type="button" class="pv-task-box" data-act="task" data-line="${t.line}" data-key="task:${t.line}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${esc(t.text)}"><span class="check${t.done ? ' on' : ''}"></span></button>
        <span class="pv-what">${esc(t.text)}</span><span class="pv-much${late ? ' is-late' : ''}">${said}</span></div>`;
    };
    const late = open.filter((t) => t.due && t.due < key).length;
    return `<section>
      ${head('Tasks', late ? `${late} late` : open.length ? `${open.length} open` : '')}
      <div>${[...open, ...closed].map(rowOf).join('') || '<div class="pv-empty">Nothing due, nothing late</div>'}</div>
      <input type="text" class="pv-field pv-add" data-act="add" data-key="add" autocomplete="off" spellcheck="false" aria-label="New task" placeholder="New task">
    </section>`;
  }

  function dayPage() {
    const d = state.date, month = monthOf(d);
    const title = `${DAY_LONG[P.dayIndex(d)]} ${d.getDate()} ${MONTH[d.getMonth()]}${d.getFullYear() !== TODAY.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
    state.path = month ? `${FOLDER}/${month.ym}.md` : FOLDER;
    const body = month
      ? `${yesterday(d)}<div class="pv-day">${dayColumn(month, d)}${tasksColumn(d)}</div>`
      : `${noMonth(d)}<div class="pv-day"><section></section>${tasksColumn(d)}</div>`;
    return page({ zoom: 'day', title, unit: 'day', meta: [month ? `${month.ym}.md` : '', 'todo.md'], body, here: +d === +TODAY });
  }

  /** A month with no file, or one kept before this format: one quiet line. */
  function noMonth(d) {
    const name = `${MONTH[d.getMonth()]} ${d.getFullYear()}`;
    if (OLD.has(P.ymOf(d))) return `<div class="pl-quiet">${esc(name)} was kept before the planner had days: its goals and its review are in <button type="button" class="v-link">${P.ymOf(d)}.md</button>.</div>`;
    return `<div class="pl-quiet">${esc(name)} has no file yet. <button type="button" class="v-link" data-act="start" data-ym="${P.ymOf(d)}">Start it</button> from the last month.</div>`;
  }

  /* ------------------------------------------------------------------ week */

  function weekPage() {
    const monday = P.addDays(state.date, -P.dayIndex(state.date));
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => P.addDays(monday, i));
    const files = [...new Set(days.map((d) => monthOf(d)).filter(Boolean).map((m) => `${m.ym}.md`))];
    state.path = files.length ? `${FOLDER}/${files[files.length - 1]}` : FOLDER;
    const total = { done: 0, due: 0 };
    const bySys = new Map();          // system -> { done, due, minDone, minDue }
    const cols = days.map((d) => {
      const month = monthOf(d);
      const isToday = +d === +TODAY, future = d > TODAY;
      const hd = `<button type="button" class="pv-wday" data-act="open-day" data-day="${P.ymd(d)}" data-key="wday:${P.ymd(d)}" title="Open this day">${DAY_SHORT[P.dayIndex(d)]} <i>${d.getDate()}</i></button>`;
      if (!month) return `<div class="pv-wcol${isToday ? ' is-today' : ''}${future ? ' is-future' : ''}">${hd}</div>`;
      const lines = linesOf(month, d);
      const rows = lines.map((l) => {
        const when = l.start !== null ? `<span class="pv-wl-t">${P.hhmm(l.start)}</span>` : '';
        const name = l.name.split(',')[0];
        const tip = `${l.name}${l.where ? ` · ${l.where}` : ''}${l.start !== null ? ` · ${P.hhmm(l.start)} to ${P.hhmm(l.end)}` : ''}`;
        if (!l.system) return `<div class="pv-wl is-plain" title="${esc(tip)}"><span></span><span class="pv-wl-n">${esc(name)}</span>${when}</div>`;
        const st = P.stateOf(month, d.getDate(), l.system, TODAY);
        const s = bySys.get(l.system) || { done: 0, due: 0, minDone: 0, minDue: 0 };
        if (l.start !== null && st !== 'skipped') { s.minDue += l.end - l.start; if (st === 'done') s.minDone += l.end - l.start; }
        bySys.set(l.system, s);
        const inner = `<span class="pv-mk is-${st}"></span><span class="pv-wl-n">${esc(name)}</span>${when}`;
        return future
          ? `<div class="pv-wl" title="${esc(tip)}">${inner}</div>`
          : `<button type="button" class="pv-wl" data-act="tick" data-day="${P.ymd(d)}" data-sys="${esc(l.system)}" data-key="tick:${P.ymd(d)}:${esc(l.system)}:${l.line}" aria-pressed="${st === 'done'}" title="${esc(tip)}">${inner}</button>`;
      }).join('');
      const c = dayCount(month, d);
      for (const sys of new Set(lines.map((l) => l.system).filter(Boolean))) {
        const st = P.stateOf(month, d.getDate(), sys, TODAY);
        const s = bySys.get(sys);
        if (st === 'done') { s.done++; s.due++; } else if (st === 'missed' || st === 'open' || st === 'planned') s.due++;
      }
      if (!future) { total.done += c.done; total.due += isToday ? c.done : c.due; }
      const foot = !lines.length ? '' : future ? `${c.due} planned` : `${c.done} of ${c.due}`;
      return `<div class="pv-wcol${isToday ? ' is-today' : ''}${future ? ' is-future' : ''}">${hd}${rows}<div class="pv-wfoot">${foot}</div></div>`;
    }).join('');

    const order = [];
    for (const d of days) { const m = monthOf(d); if (m) for (const s of P.allSystems(m)) if (!order.includes(s)) order.push(s); }
    const table = [...bySys.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([sys, s]) =>
      `<span class="k">${esc(sys)}</span><span>${s.done} of ${s.due}</span><span class="dim">${s.minDue ? `${hm(s.minDone)} of ${hm(s.minDue)}` : ''}</span><span></span>`).join('');
    const body = `
      <div class="pv-sec">${head('Days', total.due ? `${total.done} of ${total.due} so far` : '')}
        <div class="pv-week">${cols}</div></div>
      <div class="pv-sec">${head('Systems', 'done of planned, this week')}
        <div class="pv-table" style="grid-template-columns: var(--pv-margin) 5rem 9rem minmax(0, 1fr)">${table}</div></div>`;
    const here = +monday === +P.addDays(TODAY, -P.dayIndex(TODAY));
    return page({ zoom: 'week', title: `Week of ${monday.getDate()} ${MONTH[monday.getMonth()]}`, unit: 'week', meta: [...files, `${shortDate(days[0])} to ${shortDate(days[6])}`], body, here });
  }

  /* ------------------------------------------------------------------ goals, shared by month and year */

  /**
   * @param file the file the goals are in (a tick replaces one of its lines)
   * @param countOf (system) -> { done, due } over the period the page shows
   */
  function goalsHtml(areas, file, countOf) {
    if (!areas.length) return '<div class="pv-empty">No goals written</div>';
    return areas.map((a) => `<div class="pv-area">
      <div class="pv-area-name pv-what">${esc(a.label)}</div>
      <div>${a.goals.map((g) => {
        const c = g.system ? countOf(g.system) : null;
        const much = c && c.due ? `${esc(g.system)} ${c.done} of ${c.due}` : '';
        const inner = `${g.box ? `<span class="check${g.box === 'done' ? ' on' : ''}"></span>` : '<span class="pv-bullet"></span>'}<span class="pv-what">${esc(g.text)}</span><span class="pv-much">${much}</span>`;
        return g.box
          ? `<button type="button" class="pv-goal${g.box === 'done' ? ' is-done' : ''}" data-act="goal" data-file="${esc(file)}" data-line="${g.line}" data-key="goal:${file}:${g.line}" aria-pressed="${g.box === 'done'}">${inner}</button>`
          : `<div class="pv-goal">${inner}</div>`;
      }).join('')}</div>
    </div>`).join('');
  }

  const goalsSum = (areas) => {
    const boxed = areas.flatMap((a) => a.goals).filter((g) => g.box);
    return boxed.length ? `${boxed.filter((g) => g.box === 'done').length} of ${boxed.length} met` : '';
  };

  /** The review, set like the goals: each area in the margin with its grade, its words beside it. */
  function reviewHtml(review) {
    if (!review.written) return '<div class="pv-empty">Not written yet</div>';
    const blocks = [];
    let cur = { label: '', grade: '', text: [] };
    for (const p of paras(review.text)) {
      const line = p.replace(/^\*\*|\*\*$/g, '');
      if (!/\s/.test(line) && /^[\p{L}]/u.test(line)) { cur = { label: line, grade: '', text: [] }; blocks.push(cur); continue; }
      const g = /^(?:grade|overall)\s*:\s*(.+)$/i.exec(line);
      if (g) { cur.grade = g[1].trim(); continue; }
      if (!blocks.includes(cur)) blocks.push(cur);
      cur.text.push(p);
    }
    return blocks.map((b) => `<div class="pv-area pv-review">
      <div class="pv-area-name pv-what">${esc(b.label)}${b.grade ? `<span class="pv-area-grade">${esc(b.grade)}</span>` : ''}</div>
      <div class="md-render">${b.text.map((p) => `<p>${esc(p.replace(/\s*\n\s*/g, ' '))}</p>`).join('')}</div>
    </div>`).join('');
  }

  /* ------------------------------------------------------------------ month */

  function ledger(month) {
    const systems = P.allSystems(month);
    const last = P.daysIn(month.year, month.month);
    const style = `style="--pv-n:${systems.length}"`;
    const rows = [`<div class="pv-g" ${style}><span></span>${systems.map((s) => `<span class="pv-gh"><span>${esc(s)}</span></span>`).join('')}<span></span></div>`];
    // the plan, in the same columns: what a week gives each system, one row per week written
    month.weeks.forEach((w, i) => {
      const from = w.from ? P.parseYmd(w.from) : P.dateOf(month, 1);
      const mins = P.weekMinutes(w);
      const cells = systems.map((s) => {
        const min = mins.get(s) || 0;
        const days = new Set(w.lines.filter((l) => l.system === s).flatMap((l) => [...l.days])).size;
        const said = min ? (min < 60 ? `${min}m` : `${Math.round(min / 60)}h`) : days ? `${days}d` : '';
        const tip = min ? `${s} · ${hm(min)} a week` : days ? `${s} · ${days} days a week` : '';
        return `<span class="pv-gf" title="${esc(tip)}">${said}</span>`;
      }).join('');
      rows.push(`<div class="pv-g is-plan" ${style}><button type="button" class="pv-gday" data-act="open-week" data-day="${P.ymd(from)}" data-key="week:${P.ymd(from)}" title="Open this week">${i === 0 ? 'a week' : `from the ${ord(from.getDate())}`}</button>${cells}<span></span></div>`);
    });
    for (let day = 1; day <= last; day++) {
      const d = P.dateOf(month, day), key = P.ymd(d);
      const wd = P.dayIndex(d), isToday = +d === +TODAY, future = d > TODAY;
      const row = month.days ? month.days.rows.get(day) : null;
      const cells = systems.map((s) => {
        const st = P.stateOf(month, day, s, TODAY);
        if (!st) return '<span class="pv-m"></span>';
        const tip = `${s} · ${DAY_SHORT[wd]} ${day} · ${st === 'idle' ? 'before the month was started' : st === 'open' ? 'open' : st}`;
        const mk = `<span class="pv-mk is-${st}"></span>`;
        return future
          ? `<span class="pv-m" title="${esc(tip)}">${mk}</span>`
          : `<button type="button" class="pv-m" data-act="tick" data-day="${key}" data-sys="${esc(s)}" data-key="tick:${key}:${esc(s)}:g" aria-pressed="${st === 'done'}" title="${esc(tip)}">${mk}</button>`;
      }).join('');
      rows.push(`<div class="pv-g${wd === 0 && day > 1 ? ' is-monday' : ''}${isToday ? ' is-today' : ''}${future ? ' is-future' : ''}" ${style}>
        <button type="button" class="pv-gday" data-act="open-day" data-day="${key}" data-key="gday:${key}" title="Open this day">${P.two(day)} <i>${DAY_SHORT[wd]}</i></button>
        ${cells}<span class="pv-gnote" title="${esc(row ? row.note : '')}">${esc(row ? row.note : '')}</span></div>`);
    }
    const counts = systems.map((s) => P.count(month, TODAY, { systems: [s] }));
    const closed = TODAY > P.dateOf(month, last);
    rows.push(`<div class="pv-g is-foot" ${style}><span class="pv-gf pv-gf-k">done</span>${counts.map((c) =>
      `<span class="pv-gf${c.due && c.done === c.due ? ' is-full' : ''}">${c.due ? `${c.done}/${c.due}` : ''}</span>`).join('')}<span></span></div>`);
    if (!closed) {
      rows.push(`<div class="pv-g is-foot" ${style}><span class="pv-gf pv-gf-k">days in a row</span>${systems.map((s) => {
        const n = P.streak(months, s, TODAY);
        return `<span class="pv-gf">${n >= 2 ? n : ''}</span>`;
      }).join('')}<span></span></div>`);
    }
    return `<div class="pv-ledger">${rows.join('')}</div>`;
  }

  function monthPage() {
    const d = state.date, ym = P.ymOf(d), month = months.get(ym);
    const title = `${MONTH[d.getMonth()]} ${d.getFullYear()}`;
    const here = ym === P.ymOf(TODAY);
    state.path = month ? `${FOLDER}/${ym}.md` : FOLDER;
    if (!month) return page({ zoom: 'month', title, unit: 'month', meta: [OLD.has(ym) ? `${ym}.md` : ''], body: noMonth(d), here });

    const t = P.monthTally(month, TODAY);
    const sum = !t.due ? '' : [
      `${t.done} of ${t.due}`, `${pct(t.done, t.due)}%`,
      t.skipped ? `${t.skipped} skipped` : '',
      t.blank ? `${t.blank} day${t.blank === 1 ? '' : 's'} with no mark` : '',
      t.from > 1 ? `counted from the ${ord(t.from)}` : '',
    ].filter(Boolean).join(' · ');
    const body = `
      ${month.intro ? prose(month.intro) : ''}
      <div class="pv-sec">${head('Goals', goalsSum(month.goals))}${goalsHtml(month.goals, `${ym}.md`, (s) => P.count(month, TODAY, { systems: [s] }))}</div>
      <div class="pv-sec">${head('Days', sum)}${month.days ? ledger(month) : '<div class="pv-empty">No days table in this file</div>'}</div>
      <div class="pv-sec">${head('Review', month.review.overall !== null ? `${month.review.overall}/10` : '')}${reviewHtml(month.review)}</div>`;
    return page({ zoom: 'month', title, unit: 'month', meta: [`${ym}.md`, String(d.getFullYear())], body, here });
  }

  /* ------------------------------------------------------------------ year */

  function yearPage() {
    const y = state.date.getFullYear();
    const here = y === TODAY.getFullYear();
    state.path = `${FOLDER}/${y}.md`;
    if (y !== 2026) return page({ zoom: 'year', title: String(y), unit: 'year', meta: [], body: `<div class="pl-quiet">${y} has no file in this mock.</div>`, here });

    const ledgers = [...months.values()].filter((m) => m.year === y && m.days);
    const yearCount = (sys) => ledgers.reduce((a, m) => {
      const c = P.count(m, TODAY, { systems: [sys] });
      return { done: a.done + c.done, due: a.due + c.due };
    }, { done: 0, due: 0 });
    const all = ledgers.reduce((a, m) => { const c = P.monthTally(m, TODAY); return { done: a.done + c.done, due: a.due + c.due }; }, { done: 0, due: 0 });

    const rows = MONTH.map((name, i) => {
      const ym = `${y}-${P.two(i + 1)}`, m = months.get(ym);
      const isNow = ym === P.ymOf(TODAY);
      const open = `data-act="open-month" data-ym="${ym}" data-key="month:${ym}"`;
      if (m && m.days) {
        const t = P.monthTally(m, TODAY), p = pct(t.done, t.due);
        const bar = `<span class="pv-bar" aria-hidden="true">${Array.from({ length: 10 }, (_, k) => `<i${k < Math.round(p / 10) ? ' class="on"' : ''}></i>`).join('')}</span>`;
        const grade = m.review.overall !== null ? `${m.review.overall}/10` : isNow ? 'in progress' : 'no review yet';
        return `<button type="button" class="pv-month${isNow ? ' is-now' : ''}" ${open} title="Open ${name}">
          <span class="pv-what">${name}</span>${bar}<span class="pv-much r">${p}%</span><span class="pv-much">&nbsp;&nbsp;${t.done} of ${t.due}</span><span class="pv-much r">${grade}</span></button>`;
      }
      if (OLD.has(ym)) {
        return `<button type="button" class="pv-month is-old" ${open} title="Open ${name}">
          <span class="pv-what">${name}</span><span></span><span></span><span class="pv-much">&nbsp;&nbsp;goals and a review</span><span></span></button>`;
      }
      return `<button type="button" class="pv-month is-none" ${open} title="Open ${name}">
        <span class="pv-what">${name}</span><span></span><span></span><span></span><span></span></button>`;
    }).join('');

    const systems = [];
    for (const m of ledgers) for (const s of P.allSystems(m)) if (!systems.includes(s)) systems.push(s);
    const cols = `calc(var(--pv-margin)) repeat(12, minmax(0, 1fr)) 5rem`;
    const table = `<span></span>${MONTH_SHORT.map((n) => `<span class="h c">${n[0]}</span>`).join('')}<span class="h r">in a row</span>`
      + systems.map((s) => {
        const cells = MONTH.map((_, i) => {
          const m = months.get(`${y}-${P.two(i + 1)}`);
          const c = m && m.days ? P.count(m, TODAY, { systems: [s] }) : null;
          return `<span class="c"${c && c.due ? ` title="${esc(s)} · ${MONTH[i]} · ${c.done} of ${c.due}"` : ''}>${c && c.due ? pct(c.done, c.due) : ''}</span>`;
        }).join('');
        const n = P.streak(months, s, TODAY);
        return `<span class="k">${esc(s)}</span>${cells}<span class="r dim">${n >= 2 ? `${n} days` : ''}</span>`;
      }).join('');

    const body = `
      ${year.intro ? prose(year.intro) : ''}
      <div class="pv-sec">${head('Goals', goalsSum(year.goals))}${goalsHtml(year.goals, `${y}.md`, yearCount)}</div>
      <div class="pv-sec">${head('Months', all.due ? `${all.done} of ${all.due} · ${pct(all.done, all.due)}% since ${MONTH[ledgers[0].month - 1]}` : '')}${rows}</div>
      <div class="pv-sec">${head('Systems', 'share of the days done, by month')}
        <div class="pv-table" style="grid-template-columns: ${cols}; column-gap: 0">${table}</div></div>
      <div class="pv-sec">${head('Review', year.review.overall !== null ? `${year.review.overall}/10` : '')}${reviewHtml(year.review)}</div>`;
    return page({ zoom: 'year', title: String(y), unit: 'year', meta: [`${y}.md`, `${ledgers.length + OLD.size} of 12 months written`], body, here });
  }

  /* ------------------------------------------------------------------ the frame, drawn once */

  const VAULT = [
    ['dir', 0, 'journal'], ['dir', 0, 'plannings', true],
    ['file', 1, '2026.md'], ['file', 1, '2026-09.md'], ['file', 1, '2026-10.md'], ['file', 1, 'README.md'], ['file', 1, 'todo.md'],
    ['dir', 0, 'profile'], ['dir', 0, 'projects'], ['dir', 0, 'readings'], ['dir', 0, 'scratchpad'],
  ];

  function frame() {
    const row = (cls, depth, glyph, text, chev, data = '') => `<button type="button" class="row sb-row ${cls}" style="--d:${depth}" ${data}>
      <span class="tw${chev ? ' open' : ''}">${chev === null ? '' : svg(ICON.chevron)}</span><span class="gl">${svg(glyph)}</span><span class="grow">${esc(text)}</span></button>`;
    document.getElementById('app').innerHTML = `
<div class="shell">
  <header class="titlebar">
    <div class="tb-corner">
      <span class="tb-mark" title="Ose"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2.25 23.25 21.75H.75z" fill="var(--accent)"/></svg></span>
      <span class="tb-space"></span>
      <button class="tb-fold on" type="button" aria-label="Sidebar"><svg viewBox="0 0 16 16" aria-hidden="true"><rect class="tb-side-fill" x="2.25" y="2.75" width="3.75" height="10.5"/><rect x="2.25" y="2.75" width="11.5" height="10.5"/><path d="M6 2.75v10.5"/></svg></button>
    </div>
    <div class="tabs"><div class="tab on"><span class="tab-name" id="tab-name"></span><span class="tab-x">${svg(ICON.close)}</span></div></div>
    <button class="tb-tab-add" type="button" aria-label="New tab">${svg(ICON.plus)}</button>
    <span class="tb-space"></span>
    <button type="button" class="mock-theme" id="theme" title="Mock only: switch the theme"></button>
    <div class="tb-win">
      <span class="tb-win-btn"><svg viewBox="0 0 10 10"><path d="M0 5.5h10"/></svg></span>
      <span class="tb-win-btn"><svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9"/></svg></span>
      <span class="tb-win-btn tb-win-close"><svg viewBox="0 0 10 10"><path d="M0.4 0.4l9.2 9.2M9.6 0.4L0.4 9.6"/></svg></span>
    </div>
  </header>
  <div class="body">
    <aside class="sidebar"><div class="sb-scroll">
      <div class="section-label">Views</div>
      ${row('sb-view', 0, ICON.day, 'Today', null, 'data-side="today"')}
      ${row('sb-view', 0, ICON.month, 'Planner', null, 'data-side="planner"')}
      ${row('sb-view', 0, ICON.journal, 'Journal', null, 'data-side="journal"')}
      <div class="section-label">Vault</div>
      ${VAULT.map(([kind, depth, name, open]) => row(kind, depth, kind === 'dir' ? ICON.folder : ICON.page, name, kind === 'dir' ? !!open : null)).join('')}
    </div></aside>
    <div class="maincol"><main class="main"><div class="main-scroll" id="scroll"><div class="page-host" id="page"></div></div></main></div>
  </div>
  <footer class="statusbar"><span class="st-left mock-write" id="said"></span><span class="st-right"><span class="st-path" id="path"></span></span></footer>
</div>`;
  }

  /* ------------------------------------------------------------------ draw, and the clicks */

  const PAGES = { day: dayPage, week: weekPage, month: monthPage, year: yearPage };

  function draw({ keep = true } = {}) {
    const host = document.getElementById('page');
    const scroll = document.getElementById('scroll');
    const top = scroll.scrollTop;
    const act = document.activeElement;
    const key = keep && act && act.dataset ? act.dataset.key : null;
    host.innerHTML = PAGES[state.zoom]();
    document.getElementById('tab-name').textContent = state.zoom === 'day' ? 'Today' : 'Planner';
    document.getElementById('said').textContent = state.said || 'Nothing written yet. A tick replaces one line of one file, and that line shows here.';
    document.getElementById('path').textContent = state.path;
    for (const b of document.querySelectorAll('[data-side]')) {
      b.classList.toggle('current', (b.dataset.side === 'today' && state.zoom === 'day') || (b.dataset.side === 'planner' && state.zoom !== 'day'));
    }
    scroll.scrollTop = keep ? top : 0;
    const again = key ? host.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
    if (again) again.focus({ preventScroll: true }); else host.querySelector('.view-root').focus({ preventScroll: true });
  }

  function go(zoom, date) {
    if (zoom !== 'day') state.last = zoom;
    state.zoom = zoom;
    if (date) state.date = P.startOfDay(date);
    draw({ keep: false });
  }

  function nav(dir) {
    const d = state.date;
    if (dir === 'today') state.date = TODAY;
    else {
      const k = dir === 'next' ? 1 : -1;
      if (state.zoom === 'day') state.date = P.addDays(d, k);
      else if (state.zoom === 'week') state.date = P.addDays(d, 7 * k);
      else if (state.zoom === 'month') state.date = new Date(d.getFullYear(), d.getMonth() + k, 1);
      else state.date = new Date(d.getFullYear() + k, d.getMonth(), 1);
    }
    draw({ keep: true });
  }

  function onClick(ev) {
    const side = ev.target.closest('[data-side]');
    if (side) {
      if (side.dataset.side === 'today') go('day', TODAY);
      else if (side.dataset.side === 'planner') go(state.last, state.date);
      return;
    }
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    if (a === 'zoom') go(el.dataset.zoom, state.date);
    else if (a === 'nav') nav(el.dataset.nav);
    else if (a === 'tick') { tick(el.dataset.day, el.dataset.sys, ev.shiftKey); draw(); }
    else if (a === 'task') { toggleTask(Number(el.dataset.line)); draw(); }
    else if (a === 'goal') {
      const file = el.dataset.file, line = Number(el.dataset.line);
      const areas = file === '2026.md' ? year.goals : months.get(file.slice(0, 7)).goals;
      replaceLine(file, P.writeGoal(areas.flatMap((x) => x.goals).find((g) => g.line === line)));
      draw();
    } else if (a === 'yday') { state.yday = !state.yday; draw(); }
    else if (a === 'open-day') go('day', P.parseYmd(el.dataset.day));
    else if (a === 'open-week') go('week', P.parseYmd(el.dataset.day));
    else if (a === 'open-month') go('month', P.parseYmd(`${el.dataset.ym}-01`));
    else if (a === 'start') { state.said = `create  ${FOLDER}/${el.dataset.ym}.md  from the last month: its goals unticked, its week, an empty table of days, the review's gap line`; draw(); }
  }

  function onKey(ev) {
    const t = ev.target;
    const field = t.tagName === 'INPUT';
    if (field) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (t.dataset.act === 'note') {
          const d = P.parseYmd(t.dataset.day), month = monthOf(d);
          replaceLine(`${month.ym}.md`, P.writeNote(month, d.getDate(), t.value));
          draw();
        } else if (t.dataset.act === 'add' && t.value.trim()) { addTask(t.value); draw(); }
      } else if (ev.key === 'Escape') t.blur();
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key;
    if (k === 'ArrowLeft') { ev.preventDefault(); nav('prev'); }
    else if (k === 'ArrowRight') { ev.preventDefault(); nav('next'); }
    else if (k === 't') { ev.preventDefault(); nav('today'); }
    else if (k === 'y' || k === 'm' || k === 'w' || k === 'd') { ev.preventDefault(); go({ y: 'year', m: 'month', w: 'week', d: 'day' }[k], state.date); }
    else if (k === 's' && t.dataset && t.dataset.act === 'tick') { ev.preventDefault(); tick(t.dataset.day, t.dataset.sys, true); draw(); }
    else if (k === 'ArrowDown' || k === 'ArrowUp') {
      // the rows of the page are one list to the arrows
      const stops = [...document.querySelectorAll('#page [data-key]')];
      const i = stops.indexOf(document.activeElement);
      const next = stops[k === 'ArrowDown' ? Math.min(stops.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)];
      if (next) { ev.preventDefault(); next.focus(); }
    }
  }

  function theme(next) {
    const root = document.documentElement;
    if (next) root.dataset.theme = next;
    document.getElementById('theme').textContent = root.dataset.theme === 'dark' ? 'mock: dark' : 'mock: light';
  }

  // `?zoom=month&date=2026-09-01&theme=dark` opens the mock on a page, for a screenshot.
  const q = new URLSearchParams(location.search);
  if (q.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
  if (PAGES[q.get('zoom')]) state.zoom = q.get('zoom');
  if (P.parseYmd(q.get('date'))) state.date = P.parseYmd(q.get('date'));
  if (q.get('yday')) state.yday = true;
  if (state.zoom !== 'day') state.last = state.zoom;

  load();
  frame();
  theme();
  document.getElementById('theme').addEventListener('click', () => theme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  draw({ keep: false });
})();
