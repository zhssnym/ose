// Views module: registers the four custom screens and their commands, in sidebar order.
// Each view renders a `.page-col` into the element the shell hands it, so switching between a
// page and a view does not feel like changing app.

import { views, commands } from '../registry.js';
import './views.css';
import { month } from './month.js';
import { week } from './week.js';
import { day } from './day.js';
import { journal } from './journal.js';
import { navigate } from './shell-compat.js';

const ALL = [day, week, month, journal];

export async function initViews() {
  for (const v of ALL) {
    views.register(v.name, v);
    commands.register({
      id: `view.${v.name}`,
      title: v.title,
      group: 'view',
      run: () => navigate({ type: 'view', name: v.name }),
    });
  }

  commands.register({
    id: 'journal.new',
    title: 'New journal entry',
    group: 'view',
    run: () => {
      navigate({ type: 'view', name: 'journal' });
      journal.focusComposer();
      // the shell may mount asynchronously; ask again on the next frames
      requestAnimationFrame(() => journal.focusComposer());
      setTimeout(() => journal.focusComposer(), 120);
    },
  });
}

export { month, week, day, journal };
