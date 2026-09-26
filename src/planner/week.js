// Week: the calendar's grid for the current ISO week, a "Now / Next" box, and the personal work
// each day holds. Read-only; the calendar file is the only thing it reads.
//
// M33: the (Q1)/(Q2) blocks follow the Q1 anchor from Settings › Planner (weeks alternate from
// a Monday, never by ISO week number); while it is unknown both are drawn side by side, each with its marker. A block
// whose end is before its start runs overnight and is drawn to the bottom of the day, never with
// a negative length. Lines under a weekday that cannot be read are counted, and the meta line
// says "N lines not understood", with their numbers in the tooltip and a click to the first.

import { esc, loadingLine, toast } from 'ose:ui';
import {
  blockApplies, dayIndex, DAY_SHORT, dur, hhmm, minutesOf, shortDate, until, weekDays,
} from './dates.js';
import { lanes, parseTimetable, TIMETABLE } from './timetable.js';
import { bindLinks, detectedHtml, goneHtml, missingHtml } from './nav.js';
import { q1Of } from './settings.js';

const { START, END, HOUR_H, WORK_KINDS } = TIMETABLE;
const BODY_H = (END - START) * HOUR_H;
const TIME_MIN = 2 * HOUR_H;     // a block needs two hour rows before it prints its times
const SUB_MIN = 3 * HOUR_H;      // and three before the room or note fits under them
const NAME_H = 15, PAD_MIN = 23;

/** An alternating block says so wherever it is named. */
const qLabel = (e) => (e.q ? `${e.q} · ` : '') + e.t;

/**
 * The Week view.
 * @param {object} ose
 * @param {object} store the planner settings store
 * @returns {object} the view definition
 */
export function createWeekView(ose, store) {
  let live = null;

  function mount(host) {
    let alive = true, events = [], unknown = [], calMissing = false, lastDay = -1, seq = 0;
    const offs = [];
    const days = () => weekDays(new Date());
    const settings = () => store.get();

    host.innerHTML = `
<div class="view-root" tabindex="-1">
  <div class="page-col">
    <h1 class="page-title view-title">Week</h1>
    <div class="page-meta" data-el="meta">&nbsp;</div>
    <div data-el="detected"></div>
    <div class="wk-now">
      <div class="wk-now-row"><span class="label wk-k">Now</span><span class="wk-v" data-el="now">&nbsp;</span></div>
      <div class="wk-now-row"><span class="label wk-k">Next</span><span class="wk-v" data-el="next">&nbsp;</span></div>
    </div>
    <div class="wk-scroll" data-el="scroll"><div class="wk-grid" data-el="grid" style="--wk-body:${BODY_H}px"></div></div>
    <div class="wk-sum mono-sm" data-el="sum">&nbsp;</div>
  </div>
</div>`;
    const root = host.querySelector('.view-root');
    const $ = (name) => host.querySelector(`[data-el="${name}"]`);

    /** The blocks drawn on day `i` (0 = Monday) of this week: parity applied. */
    const blocksOn = (i) => {
      const date = days()[i];
      return events.filter((e) => e.d === i && blockApplies(e, date, q1Of(settings())));
    };

    function renderMeta() {
      const s = settings();
      const w = days();
      const parts = [];
      if (s.calendar && !calMissing) parts.push(`<button type="button" class="v-link" data-path="${esc(s.calendar)}">${esc(s.calendar)}</button>`);
      parts.push(`<span>${esc(shortDate(w[0]))} to ${esc(shortDate(w[6]))}</span>`);
      if (s.calendar && !calMissing) parts.push(`<span>${events.length} block${events.length === 1 ? '' : 's'}</span>`);
      if (q1Of(s)) parts.push(`<span>${blockApplies({ q: 'Q1' }, w[0], q1Of(s)) ? 'Q1' : 'Q2'} week</span>`);
      if (unknown.length) {
        const where = unknown.map((u) => u.line).join(', ');
        parts.push(`<button type="button" class="v-link pl-unknown" data-path="${esc(s.calendar)}" data-line="${unknown[0].line}" title="Calendar lines ${esc(where)}">${unknown.length} line${unknown.length === 1 ? '' : 's'} not understood</button>`);
      }
      $('meta').innerHTML = parts.join('');
      $('detected').innerHTML = s.confirmed ? '' : detectedHtml();
    }

    function build() {
      const grid = $('grid');
      if (!grid) return;
      const s = settings();
      renderMeta();
      if (!s.calendar || calMissing) {
        grid.classList.add('is-empty');
        grid.innerHTML = s.calendar ? goneHtml(s.calendar) : missingHtml('calendar');
        $('sum').innerHTML = '&nbsp;';
        tick();
        return;
      }
      grid.classList.remove('is-empty');
      const ti = dayIndex(new Date());
      lastDay = ti;
      const w = days();
      const out = ['<div class="wk-hd wk-corner"></div>'];
      DAY_SHORT.forEach((d, i) => {
        out.push(`<div class="wk-hd${i === ti ? ' today' : ''}"><span class="wk-hd-d">${d}</span><span class="wk-hd-n mono-sm">${String(w[i].getDate()).padStart(2, '0')}</span></div>`);
      });
      let times = '<div class="wk-times">';
      for (let h = Math.ceil(START); h <= Math.floor(END); h++) {
        const y = (h - START) * HOUR_H;
        times += `<div class="wk-t mono-sm" style="top:${Math.max(0, y - 6)}px">${String(h).padStart(2, '0')}h</div>`;
      }
      out.push(`${times}</div>`);

      const perDay = new Array(7).fill(0);
      const sums = {};
      const kinds = new Set(WORK_KINDS.map(([k]) => k));
      for (let d = 0; d < 7; d++) {
        const list = blocksOn(d);
        let col = `<div class="wk-col${d === ti ? ' today' : ''}" data-d="${d}">`;
        for (let h = Math.ceil(START) + 1; h <= Math.floor(END); h++) {
          col += `<div class="wk-line" style="top:${(h - START) * HOUR_H}px"></div>`;
        }
        for (const { e, lane, lanes: n } of lanes(list)) {
          const top = (e.sm / 60 - START) * HOUR_H;
          const h = Math.max(NAME_H, (e.em - e.sm) / 60 * HOUR_H - 2);
          const time = h >= TIME_MIN ? `<span class="wk-ev-t mono-sm">${hhmm(e.sm)} to ${hhmm(e.em)}</span>` : '';
          const sub = e.sub && h >= SUB_MIN ? `<span class="wk-ev-s mono-sm">${esc(e.sub)}</span>` : '';
          const q = e.q ? `<span class="wk-ev-q mono-sm">${e.q}</span>` : '';
          const title = `${e.q ? `${e.q} · ` : ''}${e.t}${e.sub ? ` · ${e.sub}` : ''} · ${hhmm(e.sm)} to ${hhmm(e.em)}`;
          col += `<div class="wk-ev t-${e.type}${h < PAD_MIN ? ' tight' : ''}" data-s="${e.sm}" data-e="${e.em}" title="${esc(title)}" style="top:${top}px;height:${h}px;--lane:${lane};--lanes:${n}"><span class="wk-ev-n">${q}${esc(e.t)}</span>${time}${sub}</div>`;
          const len = e.em - e.sm;
          if (kinds.has(e.kind)) perDay[d] += len;
          sums[e.kind] = (sums[e.kind] || 0) + len;
        }
        if (d === ti) col += '<div class="wk-nowline" data-el="nowline"><span class="wk-nowdot"></span></div>';
        out.push(`${col}</div>`);
      }
      out.push('<div class="wk-ft wk-ft-k mono-sm">Work</div>');
      perDay.forEach((m, i) => out.push(`<div class="wk-ft mono-sm${i === ti ? ' today' : ''}${m ? '' : ' faint'}">${m ? dur(m) : '–'}</div>`));
      grid.innerHTML = out.join('');

      // today is what the view is opened for: when the grid is wider than its box, scroll it in
      const scroll = $('scroll');
      if (scroll && scroll.scrollWidth > scroll.clientWidth) {
        const col = host.querySelector(`.wk-col[data-d="${ti}"]`);
        if (col) {
          const dx = col.getBoundingClientRect().left - scroll.getBoundingClientRect().left;
          scroll.scrollLeft += dx - (scroll.clientWidth - col.offsetWidth) / 2;
        }
      }

      const parts = WORK_KINDS.filter(([k]) => sums[k]).map(([k, label]) => `${label} ${dur(sums[k])}`);
      const total = WORK_KINDS.reduce((a, [k]) => a + (sums[k] || 0), 0);
      $('sum').textContent = parts.length ? `Personal work this week · ${parts.join(' · ')} · total ${dur(total)}` : ' ';
      if (!events.length) $('sum').textContent = 'No blocks read from the calendar';
      tick();
    }

    function tick() {
      if (!alive) return;
      const m = minutesOf(), ti = dayIndex(new Date());
      const line = $('nowline');
      if (line) {
        const y = (m / 60 - START) * HOUR_H;
        line.hidden = y < 0 || y > BODY_H;
        line.style.top = `${y}px`;
      }
      const now = $('now'), next = $('next');
      if (!events.length) { now.innerHTML = '&nbsp;'; next.innerHTML = '&nbsp;'; return; }
      const today = blocksOn(ti);
      // last night's overnight block is still on this morning
      const yesterday = blocksOn((ti + 6) % 7).filter((e) => e.em > 1440 && m < e.em - 1440);
      const cur = today.find((e) => e.sm <= m && m < e.em) || yesterday[0];
      const nxt = today.find((e) => e.sm > m);
      now.innerHTML = cur
        ? `<span class="wk-dot t-${cur.type}"></span>${esc(qLabel(cur))}${cur.sub && cur.type !== 'class' ? ` <span class="faint">· ${esc(cur.sub)}</span>` : ''} <span class="faint mono-sm">until ${hhmm(cur.em)}</span>`
        : '<span class="wk-dot t-rest"></span><span class="faint">Nothing scheduled</span>';
      next.innerHTML = nxt
        ? `${esc(qLabel(nxt))} <span class="faint mono-sm">${hhmm(nxt.sm)} · ${until(nxt.sm - m)}</span>`
        : '<span class="faint">Nothing else today</span>';
      for (const node of host.querySelectorAll(`.wk-col[data-d="${ti}"] .wk-ev`)) {
        const s = +node.dataset.s, e = +node.dataset.e;
        node.classList.toggle('past', e <= m);
        node.classList.toggle('live', s <= m && m < e);
      }
    }

    async function load() {
      await store.ready;
      const my = ++seq;
      const s = settings();
      if (!s.calendar) { events = []; unknown = []; calMissing = false; build(); return; }
      const stop = loadingLine($('grid'));
      try {
        const exists = await ose.files.exists(s.calendar);
        const text = exists ? await ose.files.read(s.calendar) : '';
        if (my !== seq || !alive) return;
        calMissing = !exists;
        ({ events, unknown } = parseTimetable(text));
        stop();
        build();
      } catch (e) {
        console.error('[planner] week', e);
        toast(`Week: ${(e && e.message) || e}`, 'err');
        if (stop()) $('grid').innerHTML = '';
      } finally {
        stop();
      }
    }

    offs.push(bindLinks(root, ose));
    offs.push(store.on(() => load()));
    offs.push(ose.watch((d) => {
      const p = settings().calendar;
      if (!d || d.lost || d.rescan || (d.changes || []).some((c) => c && p && (c.path === p || c.to === p))) load();
    }));
    const tickTimer = setInterval(tick, 30000);
    const dayTimer = setInterval(() => { if (dayIndex(new Date()) !== lastDay) build(); }, 60000);
    offs.push(() => { clearInterval(tickTimer); clearInterval(dayTimer); });
    root.focus({ preventScroll: true });
    load();

    const handle = {
      unmount() {
        alive = false;
        for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
        if (live === handle) live = null;
      },
      refresh() { if (alive) build(); },
    };
    live = handle;
    return handle;
  }

  return {
    title: 'Week',
    order: 20,
    icon: 'week',
    section: 'planner',
    mount: (el) => mount(el),
    unmount: () => live && live.unmount(),
    refresh: () => live && live.refresh(),
  };
}
