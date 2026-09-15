// Status bar. Left: every field `ose.status.all()` answers, in the bar's own order, joined by
// ' · ' — the shell's five and then whatever a module set, each one a button when it carries
// an `onClick` and coloured when it carries a `kind`.
// Right: the update item when a newer build is published (a button, in the accent, the only
// colour in the bar), the settings hint, the resolved theme, and which kernel is answering.
import { ose } from 'ose:kernel';
import { esc } from 'ose:ui';
import { hostKind, isHost } from './host.js';
import { statusItem } from './update.js';
import { zoomLabel } from './settings.js';

const { bus, store, status, commands } = ose;

let leftEl = null, rightEl = null;
let sawFs = false;
let watchTimer = null;

function renderLeft() {
  const all = status.all().filter((s) => s.text);
  leftEl.innerHTML = all.map((s) => {
    const cls = `st-item${s.kind ? ' ' + esc(s.kind) : ''}`;
    return s.onClick
      ? `<button type="button" class="${cls} st-click" data-key="${esc(s.key)}">${esc(s.text)}</button>`
      : `<span class="${cls}">${esc(s.text)}</span>`;
  }).join('<span class="st-dot">·</span>');
  leftEl.title = all.map((s) => s.text).join(' · ');
}

function renderRight() {
  const upd = statusItem();
  // The zoom shows only while it is not 100 %: a bar that always says `100%` teaches nobody
  // anything, and one that says `110%` explains why the window looks different (S4). It is a
  // button, so clicking or tabbing to it and pressing Enter puts the app back to 100 %.
  const zoom = zoomLabel();
  rightEl.innerHTML =
    (upd ? `<button type="button" class="st-item st-update" title="A newer build is published">${esc(upd)}</button><span class="st-sep"></span>` : '') +
    (zoom ? `<button type="button" class="st-item st-zoom" title="Reset the zoom to 100%">${esc(zoom)}</button><span class="st-sep"></span>` : '') +
    `<span class="st-item st-hint">ctrl+, settings</span>` +
    `<span class="st-sep"></span>` +
    `<span class="st-item">${esc(ose.theme.resolved())}</span>` +
    `<span class="st-sep"></span>` +
    `<span class="st-item">${esc(hostKind())}</span>`;
}

export function initStatusbar(node) {
  node.className = 'statusbar';
  node.innerHTML = `<div class="st-left mono-sm"></div><div class="st-right mono-sm"></div>`;
  leftEl = node.querySelector('.st-left');
  rightEl = node.querySelector('.st-right');

  status.watch(renderLeft);
  // A field a module set with an `onClick` is a button, and this is where it is pressed.
  leftEl.addEventListener('click', (e) => {
    const b = e.target.closest('.st-click');
    if (!b) return;
    const item = status.all().find((s) => s.key === b.dataset.key);
    if (item && item.onClick) { try { item.onClick(); } catch (err) { console.error('[shell] status', err); } }
  });
  bus.on('theme', renderRight);
  bus.on('settings', renderRight);
  store.watch('update', renderRight);
  rightEl.addEventListener('click', (e) => {
    if (e.target.closest('.st-update')) commands.run('app.update');
    else if (e.target.closest('.st-zoom')) commands.run('app.zoom-reset');
  });
  renderLeft();
  renderRight();

  // 'watch on' the moment the first fs event lands.
  bus.on('fs', () => {
    if (sawFs) return;
    sawFs = true;
    clearTimeout(watchTimer);
    status.set('watch', 'watch on');
  });

  if (isHost()) {
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
