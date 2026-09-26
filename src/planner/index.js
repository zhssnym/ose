// `ose:planner`: Day, Week, Month and Journal, built into the app (W2). They were the stock
// plugins until 1.0.0; there is no loader any more. `shell/boot.js` imports this bundle after
// `ose.init` and calls `initPlanner(ose)` once, and everything the planner adds to the app is
// registered here: four views, their commands, Settings › Planner and the file watches.
//
// What the planner reads and writes, and in which formats, is docs/FORMATS.md. Where the files
// are is Settings › Planner (`settings.js`), found by name the first time (`detect.js`).
//
// Imports: `ose:ui`, `date-fns`, files under src/planner, and `ose:editor` by dynamic import in
// journal.js (its `render`). The views get `ose` from `initPlanner`; nothing here imports
// `ose:kernel`.

import './planner.css';
import { createStore, renderSettings } from './settings.js';
import { createDayView } from './day.js';
import { createWeekView } from './week.js';
import { createMonthView } from './month.js';
import { createJournalView, openToday, recoverOldDraft } from './journal.js';
import { openPlannerSettings } from './nav.js';

/**
 * Register the planner. Called once by shell/boot.js after `ose.init`.
 * @param {object} ose the kernel facade
 * @returns {{dispose: () => void, store: object}}
 */
export function initPlanner(ose) {
  const store = createStore(ose);
  const offs = [];
  let disposed = false;
  const add = (off) => { if (typeof off === 'function') offs.push(off); };

  const views = {
    day: createDayView(ose, store),
    week: createWeekView(ose, store),
    month: createMonthView(ose, store),
    journal: createJournalView(ose, store),
  };
  for (const [name, def] of Object.entries(views)) {
    add(ose.views.register(name, def));
    add(ose.commands.register({
      id: `view.${name}`, title: def.title, group: 'planner',
      run: () => ose.route.navigate({ type: 'view', name }),
    }));
  }

  add(ose.commands.register({
    id: 'journal.today', title: "Open today's journal", group: 'planner',
    hint: 'creates it when it is not there',
    run: () => openToday(ose, store),
  }));
  add(ose.commands.register({
    id: 'planner.settings', title: 'Planner settings', group: 'planner',
    run: () => openPlannerSettings(ose),
  }));

  // the old Journal's unsent composer text, if this machine has any: offered, never dropped
  store.ready.then(() => { if (!disposed) add(recoverOldDraft(ose, store)); }).catch((e) => console.error('[planner] journal draft', e));

  add(ose.settings.section({
    id: 'planner', title: 'Planner', order: 40,
    render: (el) => renderSettings(el, store),
  }));

  return {
    store,
    dispose() {
      disposed = true;
      for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
      store.dispose();
    },
  };
}
