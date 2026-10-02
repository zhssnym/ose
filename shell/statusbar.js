// The status bar: one thin line at the foot of the window, where a page's facts live so the
// page itself holds nothing but the page. Left: the save dot (on while there are unsaved
// changes, the error mark when a save failed; titlebar.js keeps it current), then the fields
// `ose.status.all()` answers, joined by ' · ': the editing mode (a menu of the modes), the
// counts, when the file was changed and when it was saved, and the save state when it is bad.
// Right: the zoom while it is not 100 %.
import { ose } from 'ose:core';
import { esc, icon, contextMenu, copyText, toast } from 'ose:ui';
import { zoomLabel } from './settings.js';
import { clean, isOutside, outsideLabel } from './paths.js';

const { bus, status, commands } = ose;

// Fields that are set by someone and never drawn here. `path` is the editor's, for whoever
// wants to read it; `watch` is what an older shell set, kept out in case anything still does.
const NEVER = new Set(['path', 'watch']);

let leftEl = null, rightEl = null;

/** A field worth a place in the bar. The save state only when it carries a kind (bad news). */
function shown(s) {
  if (!s.text || NEVER.has(s.key)) return false;
  if (s.key === 'save') return !!s.kind;
  return true;
}

function renderLeft() {
  const all = status.all().filter(shown);
  leftEl.innerHTML = all.map((s) => {
    const cls = `st-item${s.kind ? ' ' + esc(s.kind) : ''}`;
    if (hasChoices(s)) {
      const what = s.title || s.key;
      return `<button type="button" class="${cls} st-click st-choose" data-key="${esc(s.key)}" aria-haspopup="menu" aria-label="${esc(`${what}: ${s.text}`)}" title="${esc(what)}">${esc(s.text)}${icon('chevron')}</button>`;
    }
    return s.onClick
      ? `<button type="button" class="${cls} st-click" data-key="${esc(s.key)}">${esc(s.text)}</button>`
      : `<span class="${cls}">${esc(s.text)}</span>`;
  }).join('<span class="st-dot">·</span>');
  leftEl.title = all.map((s) => s.text).join(' · ');
}

/**
 * The file in front, as a path: the vault-relative one on screen, the absolute one on the
 * clipboard when it is clicked (for a terminal, or a message to an agent). Nothing for a view.
 */
function pathOf(r) {
  if (!r || r.type !== 'page' || !r.path) return null;
  if (isOutside(r.path)) { const abs = outsideLabel(clean(r.path)); return { shown: abs, abs }; }
  const rel = clean(r.path);
  const root = String((ose.vault && ose.vault.root) || '');
  const sep = ose.platform === 'windows' ? '\\' : '/';
  const abs = root ? root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep) : rel;
  return { shown: rel, abs };
}

function renderRight() {
  const p = pathOf(ose.route.current());
  const path = p
    ? `<button type="button" class="st-item st-path" data-abs="${esc(p.abs)}" title="Copy the full path">${esc(p.shown)}</button>`
    : '';
  // The zoom shows only while it is not 100 %: a bar that always says `100%` teaches nobody
  // anything, and one that says `110%` explains why the window looks different (S4). It is a
  // button, so clicking or tabbing to it and pressing Enter puts the app back to 100 %.
  const zoom = zoomLabel();
  rightEl.innerHTML = path + (zoom
    ? `<button type="button" class="st-item st-zoom" title="Reset the zoom to 100%">${esc(zoom)}</button>`
    : '');
}

/** A field that offers a choice between values (§4.5), rather than one action. */
const hasChoices = (s) => Array.isArray(s.choices) && s.choices.length > 0 && typeof s.onChoose === 'function';

/**
 * The menu of a field's choices, above its button: the context menu, with each row a radio
 * item and the current value checked and focused, so Enter on the button and Enter again
 * keeps what was there.
 */
function openChoices(item, button) {
  const r = button.getBoundingClientRect();
  const ov = contextMenu(Math.round(r.left), Math.round(r.top), item.choices.map((c) => ({
    label: c.label,
    iconSvg: `<span class="st-mark" aria-hidden="true">${c.value === item.value ? icon('dot') : ''}</span>`,
    run: () => {
      if (c.value === item.value) return;
      try { item.onChoose(c.value); } catch (err) { console.error('[shell] status choice', err); }
    },
  })));
  if (!ov || !ov.box) return;
  ov.box.setAttribute('aria-label', item.title || item.key);
  const rows = /** @type {HTMLElement[]} */ ([...ov.box.querySelectorAll('.menu-row')]);
  rows.forEach((row, i) => {
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', item.choices[i] && item.choices[i].value === item.value ? 'true' : 'false');
  });
  // Opened from the bottom of the window, the menu sits above its button rather than over
  // it: after the overlay's own placement, which runs in the next frame.
  requestAnimationFrame(() => {
    const h = ov.box.getBoundingClientRect().height;
    if (h && r.top - h - 4 > 0) ov.box.style.top = `${Math.round(r.top - h - 4)}px`;
  });
  const on = rows.find((row) => row.getAttribute('aria-checked') === 'true');
  if (on) on.focus();
}

/**
 * Draw the bar into `node` and keep it current. Called once by `layout.js`.
 * @param {HTMLElement} node
 */
export function initStatusbar(node) {
  node.className = 'statusbar';
  node.innerHTML = `<span class="tb-dirty" role="img" aria-label="unsaved changes" title="unsaved changes" hidden></span><div class="st-left"></div><div class="st-right"></div>`;
  // Both were drawn just above.
  leftEl = /** @type {HTMLElement} */ (node.querySelector('.st-left'));
  rightEl = /** @type {HTMLElement} */ (node.querySelector('.st-right'));

  status.watch(renderLeft);
  // A field set with an `onClick` is a button, and this is where it is pressed.
  leftEl.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const b = e.target.closest('.st-click');
    if (!(b instanceof HTMLElement)) return;
    const item = status.all().find((s) => s.key === b.dataset.key);
    if (item && hasChoices(item)) { openChoices(item, b); return; }
    if (item && item.onClick) { try { item.onClick(); } catch (err) { console.error('[shell] status', err); } }
  });
  bus.on('settings', renderRight);
  bus.on('route', renderRight);
  bus.on('route:repointed', renderRight);
  rightEl.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('.st-zoom')) { commands.run('app.zoom-reset'); return; }
    const p = e.target.closest('.st-path');
    if (p instanceof HTMLElement && p.dataset.abs) {
      void copyText(p.dataset.abs).then((ok) => toast(ok ? 'Path copied' : 'Could not copy the path', ok ? 'info' : 'err', 1800));
    }
  });
  renderLeft();
  renderRight();
}
