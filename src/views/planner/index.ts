// Planner: the planner folder at three zooms, Year · Month · Week, on one page. The switch at the
// top is plain words, like the status bar's Rich · Source; the page under it is the year
// (year.ts), the month (month.ts) or the week (week.ts), each with its own ‹ › and `t`.
//
// `route.arg` says where to land: `year:2026`, `month:2026-10`, `week:2026-10-05` (any day of
// the week). With none, the zoom last used on this machine, on today. A month in the year opens
// the month; a day in the month or the week opens Today on that day.

import { esc } from '../../ui/index.ts';
import { createMonthView } from './month.ts';
import { createWeekView } from './week.ts';
import { createYearView } from './year.ts';

type Zoom = 'year' | 'month' | 'week';
const ZOOMS: Array<[Zoom, string]> = [['year', 'Year'], ['month', 'Month'], ['week', 'Week']];
const isZoom = (z): z is Zoom => z === 'year' || z === 'month' || z === 'week';

/** `month:2026-10` -> ['month', '2026-10']; anything else -> [null, null]. */
function parseArg(arg): [Zoom | null, string | null] {
  const m = /^(year|month|week):(.+)$/.exec(String(arg ?? ''));
  return m && isZoom(m[1]) ? [m[1], m[2] ?? null] : [null, null];
}

export function createPlannerView(ose: any, store: any): any {
  const pages = { year: createYearView(ose, store), month: createMonthView(ose, store), week: createWeekView(ose, store) };
  const memory = () => { try { return ose.local('views.planner'); } catch { return null; } };
  let live: { unmount(): void; refresh(): void; } | null = null;

  function mount(host: HTMLElement, route) {
    const [asked, at] = parseArg(route && route.arg);
    let remembered: unknown = null;
    try { remembered = memory()?.get(); } catch { remembered = null; }
    let zoom: Zoom = asked || (isZoom(remembered) ? remembered : 'month');
    let child: { unmount?: () => void; refresh?: () => void; } | null = null;
    let alive = true;

    const bar = document.createElement('div');
    bar.className = 'pn-zoom';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Zoom');

    function paintBar() {
      bar.innerHTML = ZOOMS.map(([z, label]) =>
        `<button type="button" class="pn-zoom-b${z === zoom ? ' on' : ''}" data-zoom="${z}" aria-pressed="${z === zoom}">${esc(label)}</button>`).join('');
    }

    function show(next: Zoom, arg: string | null) {
      try { child?.unmount?.(); } catch (e) { console.error('[planner] unmount', e); }
      zoom = next;
      try { memory()?.set(zoom); } catch { /* remembered or not, the page shows */ }
      host.innerHTML = '';
      const page = pages[zoom];
      const h = page.mount(host, { arg });
      child = h && typeof h === 'object' ? h : page;
      paintBar();
      // The switch sits at the head of the page's own column.
      const col = host.querySelector('.page-col');
      (col || host).prepend(bar);
    }

    bar.addEventListener('click', (ev) => {
      const b = ev.target instanceof Element ? ev.target.closest('[data-zoom]') : null;
      if (b instanceof HTMLElement && isZoom(b.dataset.zoom) && b.dataset.zoom !== zoom) show(b.dataset.zoom, null);
    });
    // A day, wherever the zoom draws one, opens Today on it.
    const onDay = (ev) => {
      const d = ev.target instanceof Element ? ev.target.closest('[data-day]') : null;
      if (d instanceof HTMLElement && d.dataset.day && host.contains(d)) {
        ose.route.navigate({ type: 'view', name: 'today', arg: d.dataset.day });
      }
    };
    host.addEventListener('click', onDay);

    show(zoom, at);

    const handle = {
      unmount() {
        if (!alive) return;
        alive = false;
        host.removeEventListener('click', onDay);
        try { child?.unmount?.(); } catch (e) { console.error('[planner] unmount', e); }
        if (live === handle) live = null;
      },
      refresh() { if (alive) child?.refresh?.(); },
    };
    live = handle;
    return handle;
  }

  return {
    title: 'Planner',
    order: 20,
    icon: 'month',
    section: 'planner',
    mount: (el, route) => mount(el, route),
    unmount: () => live && live.unmount(),
    refresh: () => live && live.refresh(),
  };
}
