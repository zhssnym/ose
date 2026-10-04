// The status bar: one thin line at the foot of the window, where a page's facts live so the
// page itself holds nothing but the page.
//
// Left, the controls: a gear that opens Settings (for anyone who does not know Ctrl+,), then
// the switches one changes while working: the editing mode (Rich · Source, the field
// `ose.status` answers with choices), and, for a markdown page, the page face (Document ·
// Plain) and the page layout (Scroll · Pages), the same settings as Settings › Appearance.
// Right, the facts: the other fields of `ose.status` joined by ' · ' (the counts, when the
// file was saved, the save state when it is bad), the file's path, and the zoom while it is
// not 100 %.
import { ose } from '../core/core.ts';
import { esc, copyText, toast, icon } from '../ui/index.ts';
import { zoomLabel } from './settings.ts';
import { clean, isOutside, outsideLabel } from './paths.ts';

const { bus, status, commands } = ose;

// Fields that are set by someone and never drawn here. `path` is the editor's, for whoever
// wants to read it; `watch` is what an older shell set, kept out in case anything still does.
const NEVER = new Set(['path', 'watch']);

let leftEl: HTMLElement | null = null, rightEl: HTMLElement | null = null;

/** A field worth a place in the bar. The save state only when it carries a kind (bad news). */
function shown(s) {
  if (!s.text || NEVER.has(s.key)) return false;
  if (s.key === 'save') return !!s.kind;
  return true;
}

/** A field that offers a choice between values (§4.5), rather than one action. */
const hasChoices = (s) => Array.isArray(s.choices) && s.choices.length > 0 && typeof s.onChoose === 'function';

/** One choice between values: every value a button, the current one lit. */
function segHtml(label: string, choices: [string, string][], value: string, data: string) {
  return `<span class="st-seg" role="group" aria-label="${esc(label)}">${choices.map(([v, text]) => {
    const on = v === value;
    return `<button type="button" class="st-seg-b${on ? ' on' : ''}" ${data} data-value="${esc(v)}" aria-pressed="${on}">${esc(text)}</button>`;
  }).join('')}</span>`;
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

/** The settings the bar switches, as Settings › Appearance names them. */
const SWITCHES: { key: string, label: string, choices: [string, string][] }[] = [
  { key: 'pageFace', label: 'Page face', choices: [['document', 'Document'], ['plain', 'Plain']] },
  { key: 'layout', label: 'Page layout', choices: [['scroll', 'Scroll'], ['pages', 'Pages']] },
];

const SEP = '<span class="st-sep"></span>';

/** Left: the gear, the editing mode, then the page face and the page layout for a markdown page. */
function renderLeft() {
  const parts = status.all().filter(shown).filter(hasChoices)
    .map((s) => segHtml(s.title || s.key, s.choices.map((c) => [c.value, c.label]), s.value, `data-key="${esc(s.key)}"`));
  const r = ose.route.current();
  if (r && r.type === 'page' && r.path && ose.paths.isMarkdown(r.path)) {
    const now = ose.settings.get() || {};
    for (const { key, label, choices } of SWITCHES) {
      parts.push(segHtml(label, choices, String(now[key] ?? (choices[0] as string[])[0]), `data-set="${key}"`));
    }
  }
  // Settings, always there and always first: the one way to it that needs no shortcut
  const here = !!r && r.type === 'view' && r.name === 'settings';
  const gear = `<button type="button" class="st-settings${here ? ' on' : ''}" title="Settings" aria-label="Settings"${here ? ' aria-current="page"' : ''}>${icon('gear')}</button>`;
  leftEl!.innerHTML = gear + (parts.length ? SEP + parts.join(SEP) : '');
}

/** Right: the page's facts, its path, and the zoom while it is not 100 %. */
function renderRight() {
  const facts = status.all().filter(shown).filter((s) => !hasChoices(s));
  const factsHtml = facts.map((s) => {
    const cls = `st-item${s.kind ? ' ' + esc(s.kind) : ''}`;
    return s.onClick
      ? `<button type="button" class="${cls} st-click" data-key="${esc(s.key)}">${esc(s.text)}</button>`
      : `<span class="${cls}">${esc(s.text)}</span>`;
  }).join('<span class="st-dot">·</span>');
  const r = ose.route.current();
  const p = pathOf(r);
  const path = p
    ? `<button type="button" class="st-item st-path" data-abs="${esc(p.abs)}" title="Copy the full path">${esc(p.shown)}</button>`
    : '';
  // The zoom shows only while it is not 100 %: a bar that always says `100%` teaches nobody
  // anything, and one that says `110%` explains why the window looks different (S4). It is a
  // button, so clicking or tabbing to it and pressing Enter puts the app back to 100 %.
  const zoom = zoomLabel();
  const zoomHtml = zoom ? `<button type="button" class="st-item st-zoom" title="Reset the zoom to 100%">${esc(zoom)}</button>` : '';
  rightEl!.innerHTML = [factsHtml && `<span class="st-facts" title="${esc(facts.map((s) => s.text).join(' · '))}">${factsHtml}</span>`, path, zoomHtml]
    .filter(Boolean).join(SEP);
}

function render() {
  renderLeft();
  renderRight();
}

/**
 * Draw the bar into `node` and keep it current. Called once by `layout.ts`.
 */
export function initStatusbar(node: HTMLElement) {
  node.className = 'statusbar';
  node.innerHTML = `<div class="st-left"></div><div class="st-right"></div>`;
  // Both were drawn just above.
  leftEl = node.querySelector('.st-left') as HTMLElement;
  rightEl = node.querySelector('.st-right') as HTMLElement;

  status.watch(render);
  bus.on('settings', render);
  bus.on('route', render);
  bus.on('route:repointed', render);

  node.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const seg = e.target.closest('.st-seg-b');
    if (seg instanceof HTMLElement) {
      if (seg.getAttribute('aria-pressed') === 'true') return;
      // a setting the bar switches: the 'settings' event redraws the bar
      if (seg.dataset.set) { ose.settings.set({ [seg.dataset.set]: seg.dataset.value }); return; }
      // a status field with choices (the editing mode)
      const item = status.all().find((s) => s.key === seg.dataset.key);
      if (item && hasChoices(item) && seg.dataset.value !== item.value) {
        try { item.onChoose(seg.dataset.value); } catch (err) { console.error('[shell] status choice', err); }
      }
      return;
    }
    // A field set with an `onClick` is a button, and this is where it is pressed.
    const b = e.target.closest('.st-click');
    if (b instanceof HTMLElement) {
      const item = status.all().find((s) => s.key === b.dataset.key);
      if (item && item.onClick) { try { item.onClick(); } catch (err) { console.error('[shell] status', err); } }
      return;
    }
    if (e.target.closest('.st-zoom')) { commands.run('app.zoom-reset'); return; }
    if (e.target.closest('.st-settings')) { commands.run('app.settings'); return; }
    const p = e.target.closest('.st-path');
    if (p instanceof HTMLElement && p.dataset.abs) {
      void copyText(p.dataset.abs).then((ok) => toast(ok ? 'Path copied' : 'Could not copy the path', ok ? 'info' : 'err', 1800));
    }
  });
  render();
}
