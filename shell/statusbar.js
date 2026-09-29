// Status bar. It says something only when there is something worth saying (M27).
//
// Left: the fields `ose.status.all()` answers, in the bar's own order, joined by ' · ' — the
// page's editing mode, its word count, the focus chip, and a save state *when it is bad*
// (not saved, changed on disk, deleted). A page that saved fine says nothing here: the tab's
// dot is the whole story of an ordinary edit. Each field is a button when it carries an
// `onClick` and coloured when it carries a `kind`. A field that carries `choices` (the
// editing mode: Rich, Live, Source) is a button that opens a menu of them, the current one
// checked; the arrows walk it, Enter picks, Esc closes, and a pick calls its `onChoose`.
// Right: the zoom while it is not 100 %, and nothing else.
//
// What the bar no longer draws, on purpose: the file's path (the address bar has it), `watch
// on`, the theme, the host kind and a settings hint. Those were facts about the machinery,
// and the bar is for the page.
import { ose } from 'ose:kernel';
import { esc, icon, contextMenu } from 'ose:ui';
import { zoomLabel } from './settings.js';

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

function renderRight() {
  // The zoom shows only while it is not 100 %: a bar that always says `100%` teaches nobody
  // anything, and one that says `110%` explains why the window looks different (S4). It is a
  // button, so clicking or tabbing to it and pressing Enter puts the app back to 100 %.
  const zoom = zoomLabel();
  rightEl.innerHTML = zoom
    ? `<button type="button" class="st-item st-zoom" title="Reset the zoom to 100%">${esc(zoom)}</button>`
    : '';
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
  node.innerHTML = `<div class="st-left"></div><div class="st-right"></div>`;
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
  rightEl.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('.st-zoom')) commands.run('app.zoom-reset');
  });
  renderLeft();
  renderRight();
}
