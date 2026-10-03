/* The mock: the planner's four pages (Day, Week, Month, Year) drawn from the example files by
   the reader in planner.js, inside a still picture of the app's frame. Nothing is written
   anywhere: a click changes the text held in memory with the same one-line replace the app
   would send to the host, and the status bar shows that line. */
(function () {
  'use strict';

  const P = window.Planner;
  const FILES = { ...window.PLANNER_FILES };
  const FOLDER = 'plannings';

  // The mock's clock, fixed so the pages always match the examples: Thursday 15 October 2026.
  const TODAY = new Date(2026, 9, 15);
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

  /** Done over due across any run of dates, whatever months they fall in. */
  function countDates(dates) {
    const t = { done: 0, due: 0 };
    for (const d of dates) {
      const m = monthOf(d);
      if (!m || !m.days) continue;
      const c = P.count(m, TODAY, { days: [d.getDate()] });
      t.done += c.done; t.due += c.due;
    }
    return t;
  }

  /* ------------------------------------------------------------------ state, and the writes */

  const state = { zoom: 'day', date: TODAY, last: 'month', said: '', path: '' };

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
    const back = P.plannedSystems(month, d).includes(sys) ? '.' : '';
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

  /** A section's head: its label, and at the right how far it is. `sum` is HTML. */
  const head = (label, sum = '') => `<div class="pv-head"><span class="label">${esc(label)}</span><span class="pv-sum">${sum}</span></div>`;
  const prose = (text) => `<div class="md-render">${paras(text).map((p) => `<p>${esc(p.replace(/\s*\n\s*/g, ' '))}</p>`).join('')}</div>`;

  /** "76% so far · September 57%": the one figure of a page, and the period before it. */
  function farSum(now, open, before, beforeName) {
    if (!now.due) return '';
    const a = `<b>${pct(now.done, now.due)}%</b>${open ? ' so far' : ''}`;
    return before && before.due ? `${a} · ${esc(beforeName)} ${pct(before.done, before.due)}%` : a;
  }

  /* ------------------------------------------------------------------ the cells */

  /**
   * The one component: rows of cells across the page.
   * @param cols  one per cell, in order; `{ gap: true }` is the small space between two weeks
   * @param rows  `{ label, title, cls, cells: [html], end }`; `cells` has one entry per real column
   * @param names false for a strip with no names and no figure (the month across the Day page)
   */
  function grid(cols, rows, { names = true, cls = '' } = {}) {
    const tracks = cols.map((c) => (c.gap ? 'var(--sp-1)' : 'minmax(0, 1fr)')).join(' ');
    const tpl = names ? `var(--pv-margin) ${tracks} var(--pv-end)` : tracks;
    const line = (rowCls, label, cells, end) => {
      let i = 0;
      const mid = cols.map((c) => (c.gap ? '<span></span>' : cells[i++] || '<span></span>')).join('');
      return `<div class="pv-gr ${rowCls || ''}">${names ? label : ''}${mid}${names ? end : ''}</div>`;
    };
    const heads = cols.filter((c) => !c.gap);
    const headRow = heads.some((c) => c.head)
      ? line('is-heads', '<span></span>', heads.map((c) => {
        if (!c.head) return '<span></span>';
        const k = `pv-gh${c.today ? ' is-today' : ''}`;
        return c.act ? `<button type="button" class="${k}" ${c.act} title="${esc(c.title || '')}">${esc(c.head)}</button>` : `<span class="${k}">${esc(c.head)}</span>`;
      }), '<span></span>')
      : '';
    const body = rows.map((r) => line(
      r.cls,
      `<span class="pv-gl${r.cls === 'is-all' ? ' is-all' : ''}" title="${esc(r.title || r.label || '')}">${esc(r.label || '')}</span>`,
      r.cells,
      `<span class="pv-ge">${r.end || ''}</span>`,
    )).join('');
    return `<div class="pv-grid ${cls}" style="--pv-cols: ${tpl}">${headRow}${body}</div>`;
  }

  /** A cell of one system on one day: filled, pale, outlined, or nothing. A past day's is a button. */
  function markCell(month, d, sys, name) {
    const st = month ? P.stateOf(month, d.getDate(), sys, TODAY) : null;
    if (!st) return '<span class="pv-c"></span>';
    const said = { done: 'done', missed: 'not done', open: 'open', planned: 'to come', skipped: 'dropped that day', idle: 'before the month was started' }[st];
    const tip = `${name} · ${DAY_SHORT[P.dayIndex(d)]} ${d.getDate()} · ${said}`;
    if (d > TODAY) return `<span class="pv-c is-${st}" title="${esc(tip)}"></span>`;
    const key = P.ymd(d);
    return `<button type="button" class="pv-c is-${st}" data-act="tick" data-day="${key}" data-sys="${esc(sys)}" data-key="tick:${key}:${esc(sys)}" aria-pressed="${st === 'done'}" title="${esc(tip)}"></button>`;
  }

  /** A cell of everything on one day: deeper with the share done. It opens the day. */
  function dayCell(d, { here = false } = {}) {
    const month = monthOf(d);
    const key = P.ymd(d);
    const open = `data-act="open-day" data-day="${key}" data-key="day:${key}"`;
    const label = `${DAY_SHORT[P.dayIndex(d)]} ${d.getDate()}`;
    const ring = here ? ' is-here' : '';
    if (!month || !month.days) return `<span class="pv-c${ring}"></span>`;
    const s = P.dayShare(month, d.getDate(), TODAY);
    if (s.share === null) {
      const planned = P.plannedSystems(month, d).length > 0;
      return `<button type="button" class="pv-c${planned ? ' is-planned' : ''}${ring}" ${open} title="${esc(label)}${s.when === 'idle' ? ' · before the month was started' : ''}"></button>`;
    }
    const row = month.days.rows.get(d.getDate());
    return `<button type="button" class="pv-c is-tint${ring}" style="--p:${Math.round(s.share * 100)}" ${open} title="${esc(label)} · ${s.done} of ${s.due}${row && row.note ? ` · ${esc(row.note)}` : ''}"></button>`;
  }

  /** The days of a month as columns, with the small space before each Monday. */
  function dayCols(month, heads) {
    const cols = [];
    for (let day = 1; day <= P.daysIn(month.year, month.month); day++) {
      const d = P.dateOf(month, day), wd = P.dayIndex(d);
      if (wd === 0 && day > 1) cols.push({ gap: true });
      const isToday = +d === +TODAY;
      cols.push({ d, head: heads && (day === 1 || wd === 0 || isToday) ? String(day) : '', today: isToday });
    }
    return cols;
  }

  /** The month before, when it kept its days. */
  function monthBefore(month) {
    const prev = months.get(P.ymOf(new Date(month.year, month.month - 2, 1)));
    return prev && prev.days ? prev : null;
  }

  /** How far a month is, and the month before it. */
  function monthSum(month) {
    const t = P.monthTally(month, TODAY);
    const prev = monthBefore(month);
    const open = month.ym === P.ymOf(TODAY);
    return farSum(t, open, prev ? P.monthTally(prev, TODAY) : null, prev ? MONTH[prev.month - 1] : '');
  }

  /* ------------------------------------------------------------------ day */

  /** The things of a day: one per system, in the order of the day, under the words of its line. */
  function thingsOf(month, d) {
    const out = [];
    for (const l of P.linesFor(month, d)) {
      const at = l.start !== null ? `${P.hhmm(l.start)} to ${P.hhmm(l.end)}${l.where ? ` · ${l.where}` : ''}` : '';
      const seen = l.system ? out.find((x) => x.system === l.system) : null;
      if (seen) { if (at) seen.tip.push(at); continue; }
      out.push({ system: l.system, name: l.name, tip: at ? [at] : [] });
    }
    const row = month.days ? month.days.rows.get(d.getDate()) : null;
    for (const s of row ? Object.keys(row.marks) : []) {
      if (row.marks[s] === 'x' && !out.some((x) => x.system === s)) out.push({ system: s, name: P.nameOf(month, s), tip: [] });
    }
    return out;
  }

  function dayColumn(month, d) {
    const future = d > TODAY, key = P.ymd(d);
    const things = thingsOf(month, d);
    let done = 0, due = 0;
    const rows = things.map((t) => {
      if (!t.system) return `<div class="pv-item is-plain" title="${esc(t.tip.join(', '))}"><span></span><span class="pv-what">${esc(t.name)}</span></div>`;
      const st = P.stateOf(month, d.getDate(), t.system, TODAY);
      if (st === 'done') { done++; due++; } else if (st !== 'skipped') due++;
      const box = st === 'done' ? ' on' : st === 'skipped' ? ' skip' : '';
      const inner = `<span class="check${box}"></span><span class="pv-what">${esc(t.name)}</span>`;
      return future
        ? `<div class="pv-item" title="${esc(t.tip.join(', '))}">${inner}</div>`
        : `<button type="button" class="pv-item is-${st}" data-act="tick" data-day="${key}" data-sys="${esc(t.system)}" data-key="tick:${key}:${esc(t.system)}" aria-pressed="${st === 'done'}" title="${esc(t.tip.join(', '))}">${inner}</button>`;
    }).join('');
    const sum = !due ? '' : future ? `${due} planned` : `${done} of ${due}`;
    return `<section>${head(+d === +TODAY ? 'Today' : DAY_LONG[P.dayIndex(d)], sum)}
      ${rows || '<div class="pv-empty">Nothing planned on this day</div>'}</section>`;
  }

  function tasksColumn(d) {
    const key = P.ymd(d);
    const open = todo.filter((t) => !t.done && (!t.due || t.due <= key));
    const closed = todo.filter((t) => t.done && t.doneOn === key);
    const rank = (t) => (t.due && t.due < key ? 0 : t.due === key ? 1 : 2);
    open.sort((a, b) => rank(a) - rank(b) || String(a.due || '').localeCompare(String(b.due || '')) || a.line - b.line);
    const rowOf = (t) => {
      const late = !t.done && t.due && t.due < key;
      return `<div class="pv-item${t.done ? ' is-struck' : ''}" style="padding-left: calc(${t.depth} * var(--sp-5))">
        <button type="button" class="pv-box" data-act="task" data-line="${t.line}" data-key="task:${t.line}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${esc(t.text)}"><span class="check${t.done ? ' on' : ''}"></span></button>
        <span class="pv-what">${esc(t.text)}</span>${late ? `<span class="pv-late" title="Due ${esc(t.due)}">late</span>` : ''}</div>`;
    };
    return `<section>${head('Tasks')}
      ${[...open, ...closed].map(rowOf).join('') || '<div class="pv-empty">Nothing due, nothing late</div>'}
      <input type="text" class="pv-field" data-act="add" data-key="add" autocomplete="off" spellcheck="false" aria-label="New task" placeholder="New task">
    </section>`;
  }

  function dayPage() {
    const d = state.date, month = monthOf(d);
    const title = `${DAY_LONG[P.dayIndex(d)]} ${d.getDate()} ${MONTH[d.getMonth()]}${d.getFullYear() !== TODAY.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
    state.path = month ? `${FOLDER}/${month.ym}.md` : FOLDER;
    let body;
    if (!month) body = `${noMonth(d)}<div class="pv-day pv-sec"><section></section>${tasksColumn(d)}</div>`;
    else {
      // the month so far, one cell a day: where this day sits in it, and how the others went
      const cols = dayCols(month, false);
      const strip = grid(cols, [{ cells: cols.filter((c) => !c.gap).map((c) => dayCell(c.d, { here: +c.d === +d })) }], { names: false, cls: 'pv-strip' });
      const row = month.days ? month.days.rows.get(d.getDate()) : null;
      body = `${row && row.note ? `<p class="pv-what pv-daynote">${esc(row.note)}</p>` : ''}<div class="pv-sec"><div class="pv-head">
          <button type="button" class="label" data-act="zoom" data-zoom="month" data-key="to-month" title="Open the month">${MONTH[d.getMonth()]}</button>
          <span class="pv-sum">${monthSum(month)}</span></div>${strip}</div>
        <div class="pv-day pv-sec">${dayColumn(month, d)}${tasksColumn(d)}</div>`;
    }
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
    const cols = days.map((d) => ({
      d, head: `${DAY_SHORT[P.dayIndex(d)]} ${d.getDate()}`, today: +d === +TODAY,
      act: `data-act="open-day" data-day="${P.ymd(d)}" data-key="wday:${P.ymd(d)}"`, title: 'Open this day',
    }));
    // the systems this week has anything for, in the order the months keep them
    const systems = [];
    for (const m of new Set(days.map((d) => monthOf(d)).filter(Boolean))) {
      for (const s of P.allSystems(m)) {
        if (!systems.includes(s) && days.some((d) => monthOf(d) === m && P.stateOf(m, d.getDate(), s, TODAY))) systems.push(s);
      }
    }
    const last = monthOf(days[6]) || monthOf(days[0]);
    const rows = [
      { cls: 'is-all', label: 'All', cells: days.map((d) => dayCell(d)) },
      ...systems.map((s) => {
        const name = last ? P.nameOf(last, s) : s;
        return { label: name, cells: days.map((d) => markCell(monthOf(d), d, s, name)) };
      }),
    ];
    const here = +monday === +P.addDays(TODAY, -P.dayIndex(TODAY));
    const before = countDates(days.map((d) => P.addDays(d, -7)));
    const body = `<div class="pv-sec">${head('Days', farSum(countDates(days), here, before, 'last week'))}
      ${systems.length ? grid(cols, rows) : '<div class="pv-empty">Nothing planned this week</div>'}</div>`;
    return page({ zoom: 'week', title: `Week of ${monday.getDate()} ${MONTH[monday.getMonth()]}`, unit: 'week', meta: [...files, `${shortDate(days[0])} to ${shortDate(days[6])}`], body, here });
  }

  /* ------------------------------------------------------------------ goals and review, shared by month and year */

  function goalsHtml(areas, file) {
    if (!areas.length) return '<div class="pv-empty">No goals written</div>';
    return areas.map((a) => `<div class="pv-area">
      <div class="pv-area-name pv-what">${esc(a.label)}</div>
      <div>${a.goals.map((g) => {
        const inner = `${g.box ? `<span class="check${g.box === 'done' ? ' on' : ''}"></span>` : '<span class="pv-bullet"></span>'}<span class="pv-what">${esc(g.text)}</span>`;
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

  function monthPage() {
    const d = state.date, ym = P.ymOf(d), month = months.get(ym);
    const title = `${MONTH[d.getMonth()]} ${d.getFullYear()}`;
    const here = ym === P.ymOf(TODAY);
    state.path = month ? `${FOLDER}/${ym}.md` : FOLDER;
    if (!month) return page({ zoom: 'month', title, unit: 'month', meta: [OLD.has(ym) ? `${ym}.md` : ''], body: noMonth(d), here });

    let days = '<div class="pv-empty">No days table in this file</div>';
    if (month.days) {
      const cols = dayCols(month, true);
      const real = cols.filter((c) => !c.gap);
      const rows = [
        { cls: 'is-all', label: 'All', cells: real.map((c) => dayCell(c.d)) },
        ...P.allSystems(month).map((s) => {
          const name = P.nameOf(month, s);
          const c = P.count(month, TODAY, { systems: [s] });
          return { label: name, cells: real.map((col) => markCell(month, col.d, s, name)), end: c.due ? `${pct(c.done, c.due)}%` : '' };
        }),
      ];
      days = grid(cols, rows);
    }
    const body = `
      ${month.intro ? prose(month.intro) : ''}
      <div class="pv-sec">${head('Goals', goalsSum(month.goals))}${goalsHtml(month.goals, `${ym}.md`)}</div>
      <div class="pv-sec">${head('Days', monthSum(month))}${days}</div>
      <div class="pv-sec">${head('Review', month.review.overall !== null ? `${month.review.overall}/10` : '')}${reviewHtml(month.review)}</div>`;
    return page({ zoom: 'month', title, unit: 'month', meta: [`${ym}.md`, String(d.getFullYear())], body, here });
  }

  /* ------------------------------------------------------------------ year */

  function yearPage() {
    const y = state.date.getFullYear();
    const here = y === TODAY.getFullYear();
    state.path = `${FOLDER}/${y}.md`;
    if (y !== 2026) return page({ zoom: 'year', title: String(y), unit: 'year', meta: [], body: `<div class="pl-quiet">${y} has no file in this mock.</div>`, here });

    const byMonth = MONTH.map((_, i) => months.get(`${y}-${P.two(i + 1)}`) || null);
    const ledgers = byMonth.filter((m) => m && m.days);
    const tallies = byMonth.map((m) => (m && m.days ? P.monthTally(m, TODAY) : null));
    const all = tallies.reduce((a, t) => (t ? { done: a.done + t.done, due: a.due + t.due } : a), { done: 0, due: 0 });

    const cols = MONTH_SHORT.map((name, i) => ({
      head: name, today: here && i === TODAY.getMonth(),
      act: `data-act="open-month" data-ym="${y}-${P.two(i + 1)}" data-key="month:${y}-${P.two(i + 1)}"`, title: `Open ${MONTH[i]}`,
    }));
    const openMonth = (i) => `data-act="open-month" data-ym="${y}-${P.two(i + 1)}" data-key="all:${i}"`;
    const systems = [];
    for (const m of ledgers) for (const s of P.allSystems(m)) if (!systems.includes(s)) systems.push(s);
    const lastWith = (s) => [...ledgers].reverse().find((m) => P.allSystems(m).includes(s));
    const anyGrade = byMonth.some((m) => m && m.review.overall !== null);

    const rows = [
      { cls: 'is-all', label: 'All', cells: tallies.map((t, i) => (t && t.due
        ? `<button type="button" class="pv-c is-tint" style="--p:${pct(t.done, t.due)}" ${openMonth(i)} title="${MONTH[i]} · ${pct(t.done, t.due)}%"></button>`
        : '<span class="pv-c"></span>')) },
      { cls: 'is-figures', label: '', cells: tallies.map((t) => `<span class="pv-gh">${t && t.due ? `${pct(t.done, t.due)}%` : ''}</span>`) },
      ...(anyGrade ? [{ cls: 'is-figures', label: 'Grade', title: 'The grade you gave the month in its review', cells: byMonth.map((m) => `<span class="pv-gh">${m && m.review.overall !== null ? `${m.review.overall}/10` : ''}</span>`) }] : []),
      ...systems.map((s) => {
        const name = P.nameOf(lastWith(s), s);
        const run = P.streak(months, s, TODAY);
        return {
          label: name,
          cells: byMonth.map((m, i) => {
            const c = m && m.days ? P.count(m, TODAY, { systems: [s] }) : null;
            return c && c.due ? `<span class="pv-c is-tint" style="--p:${pct(c.done, c.due)}" title="${esc(name)} · ${MONTH[i]} · ${pct(c.done, c.due)}%"></span>` : '<span class="pv-c"></span>';
          }),
          end: run >= 2 ? `<span title="${run} days in a row">${run} days</span>` : '',
        };
      }),
    ];
    const first = ledgers[0];
    const body = `
      ${year.intro ? prose(year.intro) : ''}
      <div class="pv-sec">${head('Goals', goalsSum(year.goals))}${goalsHtml(year.goals, `${y}.md`)}</div>
      <div class="pv-sec">${head('Months', all.due ? `<b>${pct(all.done, all.due)}%</b> since ${MONTH[first.month - 1]}` : '')}${grid(cols, rows)}</div>
      <div class="pv-sec">${head('Review', year.review.overall !== null ? `${year.review.overall}/10` : '')}${reviewHtml(year.review)}</div>`;
    return page({ zoom: 'year', title: String(y), unit: 'year', meta: [`${y}.md`], body, here });
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
    } else if (a === 'open-day') go('day', P.parseYmd(el.dataset.day));
    else if (a === 'open-month') go('month', P.parseYmd(`${el.dataset.ym}-01`));
    else if (a === 'start') { state.said = `create  ${FOLDER}/${el.dataset.ym}.md  from the last month: its goals unticked, its week, an empty table of days, the review's gap line`; draw(); }
  }

  function onKey(ev) {
    const t = ev.target;
    if (t.tagName === 'INPUT') {
      if (ev.key === 'Enter' && t.dataset.act === 'add' && t.value.trim()) { ev.preventDefault(); addTask(t.value); draw(); }
      else if (ev.key === 'Escape') t.blur();
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
  if (state.zoom !== 'day') state.last = state.zoom;

  load();
  frame();
  theme();
  document.getElementById('theme').addEventListener('click', () => theme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  draw({ keep: false });
})();
