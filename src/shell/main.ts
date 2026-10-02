// The entry. One job: start the boot (`boot.js`), and when anything on the way throws — a
// module of the shell that does not load, the core itself, a surface that throws while it is
// built — put the boot error page up (`boot-error.js`, M38) instead of leaving a blank window.
//
// `boot.js` is imported, not loaded by a static `import`, because a static import that fails
// takes this file down with it and nothing would be left to say so. `boot-error.js` imports
// nothing, for the same reason.

// The stylesheets, in the order they win: the kit, then the shell's own, then theme.css, whose
// token overrides win over everything. The editor's and the views' come with their code.
import '../ui/ui.css';
import './shell.css';
import './tree.css';
import './places.css';
import './media.css';
import './theme.css';
import { showBootError } from './boot-error.ts';

import('./boot.ts')
  .then((m) => m.boot())
  .catch(async (e) => {
    // The core may have loaded even though the shell did not; ask for it, so the page can
    // name the log. A core that failed fails again here, at once, and the page does without.
    let ose: typeof import('../core/core.ts')['ose'] | null = null;
    try { ({ ose } = await import('../core/core.ts')); } catch { ose = null; }
    showBootError(e, { stage: 'The interface could not be loaded.', ose });
  });
