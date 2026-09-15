// Boot. Order matters: kernel, bridge, shell (layout + router), then feature modules register
// their commands and views. Nothing is navigated to: the app opens on an empty surface and
// the user picks (CONTRACT.md batch 2).
//
// With no vault open (the host found nothing and nothing was remembered) the shell is not
// built at all: a single surface asks for a folder and reloads the page once one is chosen
// (CONTRACT.md "Vault resolution").
import { bus, store, status } from './kernel/registry.js';
import { bridge } from './kernel/bridge/index.js';
import { setPageHost, setPageList } from './kernel/pagehost.js';
import { initShell } from './shell/index.js';
import { allPages } from './shell/sidebar.js';
import { mountVaultChooser } from './shell/vault.js';
import { initEditor, openPage, closePage, scrollToLine, currentSelection } from './editor/index.js';
import { headingLine } from './editor/lines.js';
import { initViews } from './views/index.js';

// The kernel's router never imports the editor (docs/KERNEL.md: the editor is its own bundle).
// Registering the page host here is the one line that joins them, and it is the same line the
// stock rice will have in `cockpit/shell/main.js`.
setPageHost({
  open: openPage,
  close: closePage,
  scrollToLine,
  selection: currentSelection,
  headingLine,
});

// The same seam for the page list quick open and the page picker read: the sidebar knows the
// tree and the focused folder, the kernel does not.
setPageList(() => allPages());

async function boot() {
  const root = document.getElementById('app');
  status.set('mode', 'STARTING');
  let info;
  try {
    await bridge.ready;
    info = await bridge.rootInfo();
  } catch (e) {
    root.innerHTML = `<div class="empty">bridge failed: ${String(e.message || e)}</div>`;
    return;
  }
  if (!info || !info.root) {
    status.set('mode', 'NO VAULT');
    await mountVaultChooser(root);
    return;
  }
  store.set('root', info);
  await initShell(root);
  await Promise.all([initEditor(), initViews()]);
  status.set('mode', 'READY');
  bus.emit('booted');
}

boot();
