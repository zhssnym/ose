// The views (src/views): the pages of their own in the sidebar's Views section, Today, Planner
// and Journal, one folder each. `src/shell/boot.ts` imports this module after `ose.init` and calls
// `initViews(ose)` once; everything the views add to the app is registered here.
//
// A view, and how to add one (copy `journal/`, the fullest example):
//
//   views/<name>/index.ts   exports `create<Name>View(ose, store)`, which answers
//                           { title, order, icon, section: 'planner',
//                             mount(el, route) -> handle?, unmount(), refresh() }
//   add it to VIEWS below   it gets a route `{ type: 'view', name }`, a command `view.<name>`
//                           in the palette, and a row in the sidebar's Views section.
//
// The rules a view keeps:
//   - It reads ordinary files of the vault through `ose.files`, and writes back only one
//     appended or replaced line (`appendLine`, `replaceLine`) or a new file, never a whole
//     file it did not create. docs/FORMATS.md says exactly what each view reads and writes.
//   - It never spells a vault path: where its files are is a setting (Settings › Views,
//     `shared/settings.ts`), found by name the first time (`shared/detect.ts`).
//   - It imports the kit (src/ui), `date-fns`, `shared/` and its own files, and the editor
//     (src/editor/lib.ts) only by dynamic import; never the core (a type aside) or the shell.
//     `ose` is handed to it.
//   - Tokens only in `views.css`: no colour, font or size of its own.

import './views.css';
import { createStore, renderSettings } from './shared/settings.ts';
import { createTodayView } from './today/index.ts';
import { createPlannerView } from './planner/index.ts';
import { createJournalView, openToday } from './journal/index.ts';
import { openPlannerSettings } from './shared/nav.ts';

/** Every view, by the name in its route. */
const VIEWS = {
  today: createTodayView,
  planner: createPlannerView,
  journal: createJournalView,
};

/**
 * Register the views. Called once by src/shell/boot.ts after `ose.init`.
 * @param ose the core facade
 */
export function initViews(ose: any): { dispose: () => void; store: any; } {
  const store = createStore(ose);
  const offs: any[] = [];
  const add = (off) => { if (typeof off === 'function') offs.push(off); };

  for (const [name, create] of Object.entries(VIEWS)) {
    const def = create(ose, store);
    add(ose.views.register(name, def));
    add(ose.commands.register({
      id: `view.${name}`, title: def.title, group: 'views',
      run: () => ose.route.navigate({ type: 'view', name }),
    }));
  }

  add(ose.commands.register({
    id: 'journal.today', title: "Open today's journal", group: 'views',
    hint: 'creates it when it is not there',
    run: () => openToday(ose, store),
  }));
  add(ose.commands.register({
    id: 'planner.settings', title: 'Views settings', group: 'views',
    run: () => openPlannerSettings(ose),
  }));

  add(ose.settings.section({
    id: 'planner', title: 'Views', order: 40,
    render: (el) => renderSettings(el, store),
  }));

  return {
    store,
    dispose() {
      for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
      store.dispose();
    },
  };
}
