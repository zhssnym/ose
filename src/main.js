// Boot. Order matters: kernel, bridge, shell (layout + router), then feature modules register
// their commands and views. Nothing is navigated to: the app opens on an empty surface and
// the user picks (CONTRACT.md batch 2).
import { bus, store, status } from './registry.js';
import { bridge } from './bridge/index.js';
import { initShell } from './shell/index.js';
import { initEditor } from './editor/index.js';
import { initViews } from './views/index.js';

async function boot() {
  const root = document.getElementById('app');
  status.set('mode', 'STARTING');
  try {
    await bridge.ready;
    store.set('root', await bridge.rootInfo());
  } catch (e) {
    root.innerHTML = `<div class="empty">bridge failed: ${String(e.message || e)}</div>`;
    return;
  }
  await initShell(root);
  await Promise.all([initEditor(), initViews()]);
  status.set('mode', 'READY');
  bus.emit('booted');
}

boot();
