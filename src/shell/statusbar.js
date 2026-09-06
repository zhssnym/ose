// Status bar. Left: whatever modules put in status.set(), in registry order, joined by ' · '.
// Right: the settings hint, the resolved theme, and which bridge is answering.
import { bus, status, esc } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { resolvedTheme } from './theme.js';

let leftEl = null, rightEl = null;
let sawFs = false;
let watchTimer = null;

function renderLeft() {
  const parts = status.all().map((s) => s.text).filter(Boolean);
  leftEl.textContent = parts.join(' · ');
  leftEl.title = parts.join(' · ');
}

function renderRight() {
  rightEl.innerHTML =
    `<span class="st-item st-hint">ctrl+, settings</span>` +
    `<span class="st-sep"></span>` +
    `<span class="st-item">${esc(resolvedTheme())}</span>` +
    `<span class="st-sep"></span>` +
    `<span class="st-item">${esc(bridge.kind === 'http' ? 'dev' : bridge.kind)}</span>`;
}

export function initStatusbar(node) {
  node.className = 'statusbar';
  node.innerHTML = `<div class="st-left mono-sm"></div><div class="st-right mono-sm"></div>`;
  leftEl = node.querySelector('.st-left');
  rightEl = node.querySelector('.st-right');

  status.watch(renderLeft);
  bus.on('theme', renderRight);
  renderLeft();
  renderRight();

  // 'watch on' the moment the first fs event lands.
  bus.on('fs', () => {
    if (sawFs) return;
    sawFs = true;
    clearTimeout(watchTimer);
    status.set('watch', 'watch on');
  });

  if (bridge.kind !== 'http') {
    // The host starts its watcher before the first navigation; an idle vault is simply quiet.
    status.set('watch', 'watch on');
  } else {
    // Dev: an idle vault emits nothing for minutes, so ask the stream directly instead of
    // waiting for a change. If SSE is not available at all, say nothing rather than lie.
    try {
      const probe = new EventSource('/__bridge/events');
      const done = (ok) => {
        probe.onopen = probe.onerror = null;
        probe.close();
        if (ok && !sawFs) { sawFs = true; clearTimeout(watchTimer); status.set('watch', 'watch on'); }
      };
      probe.onopen = () => done(true);
      probe.onerror = () => done(false);
      watchTimer = setTimeout(() => done(false), 8000);
    } catch { /* no EventSource: leave 'watch' unset */ }
  }
}
