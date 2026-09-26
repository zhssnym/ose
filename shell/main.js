// The entry. One job: start the boot (`boot.js`), and when anything on the way throws — a
// module of the shell that does not load, the kernel itself, a surface that throws while it is
// built — put the boot error page up (`boot-error.js`, M38) instead of leaving a blank window.
//
// `boot.js` is imported, not loaded by a static `import`, because a static import that fails
// takes this file down with it and nothing would be left to say so. `boot-error.js` imports
// nothing, for the same reason.

import { showBootError } from './boot-error.js';

import('./boot.js')
  .then((m) => m.boot())
  .catch(async (e) => {
    // The kernel may have loaded even though the shell did not; ask for it, so the page can
    // name the log. A kernel that failed fails again here, at once, and the page does without.
    let ose = null;
    try { ({ ose } = await import('ose:kernel')); } catch { ose = null; }
    showBootError(e, { stage: 'The interface could not be loaded.', ose });
  });
