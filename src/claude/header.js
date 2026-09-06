// Pane header: the `Claude` label, the status chip, and one `…` button. Everything else the
// pane can do lives in the menu behind that button: a new session, the recent sessions (each
// renameable), the model, the permission mode, and dock/full. In dock mode a close button sits
// beside it, because there the sidebar is not the way out.

import { store } from '../registry.js';
import { PERMISSION_MODES, MODELS } from './session.js';
import { fmtAgo } from './protocol.js';

const svg = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
const ICON_CLOSE = svg('<path d="M4 4l8 8M12 4l-8 8"/>');
const ICON_MORE = svg('<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>');
const CHECK = '✓';

/** Ask for a new session name. The shell owns dialogs; nobody here calls window.prompt. */
async function askName(current) {
  try {
    const m = await import('../shell/dialog.js');
    if (typeof m.prompt === 'function') {
      return await m.prompt({ title: 'Rename session', value: current || '', placeholder: 'session name', ok: 'Rename' });
    }
  } catch (e) { console.warn('[claude] dialog unavailable', e); }
  return null;
}

export function createHeader({ session, mode = () => 'view', onNew, onClose, onResume, onToggleMode }) {
  const root = document.createElement('div');
  root.className = 'c-header';

  const head = document.createElement('div');
  head.className = 'panel-head c-head';
  const label = document.createElement('span');
  label.className = 'c-label';
  label.textContent = 'Claude';
  const chip = document.createElement('span');
  chip.className = 'chip c-status';
  const grow = document.createElement('span');
  grow.className = 'grow';

  const mkBtn = (cls, html, tip, fn) => {
    const b = document.createElement('button');
    b.className = `btn ghost icon sm ${cls}`;
    b.type = 'button';
    b.innerHTML = html;
    b.dataset.tip = tip;
    b.setAttribute('aria-label', tip);
    b.addEventListener('click', fn);
    return b;
  };

  const menuBtn = mkBtn('c-menu-btn', ICON_MORE, 'menu', (e) => { e.stopPropagation(); toggleMenu(); });
  menuBtn.setAttribute('aria-haspopup', 'menu');
  const closeBtn = mkBtn('c-close-btn', ICON_CLOSE, 'close pane', () => onClose?.());
  head.append(label, chip, grow, menuBtn, closeBtn);

  /* ---- the menu ------------------------------------------------------- */

  const menu = document.createElement('div');
  menu.className = 'c-menu surface';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  const onDoc = (e) => { if (!menu.contains(e.target) && !menuBtn.contains(e.target)) closeMenu(); };
  const onKey = (e) => {
    if (e.key !== 'Escape' || menu.hidden) return;
    e.stopPropagation();
    closeMenu();
    menuBtn.focus();
  };

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function toggleMenu() {
    if (!menu.hidden) return closeMenu();
    buildMenu();
    menu.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    menu.querySelector('button')?.focus();
  }

  const section = (text) => {
    const d = document.createElement('div');
    d.className = 'section-label c-menu-title';
    d.textContent = text;
    return d;
  };

  const rule = () => {
    const d = document.createElement('div');
    d.className = 'c-menu-rule';
    return d;
  };

  /** A menu row: optional check column, label, optional hint on the right. */
  function row({ label: text, hint = '', on = null, onClick, title = '' }) {
    const b = document.createElement('button');
    b.className = 'row c-menu-row';
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (title) b.title = title;
    if (on !== null) {
      const mark = document.createElement('span');
      mark.className = 'c-menu-check mono-sm';
      mark.textContent = on ? CHECK : '';
      b.append(mark);
    }
    const t = document.createElement('span');
    t.className = 'grow';
    t.textContent = text;
    b.append(t);
    if (hint) {
      const h = document.createElement('span');
      h.className = 'hint';
      h.textContent = hint;
      b.append(h);
    }
    b.addEventListener('click', onClick);
    return b;
  }

  function buildMenu() {
    menu.innerHTML = '';

    menu.append(row({
      label: 'new session',
      onClick: () => { closeMenu(); onNew?.(); },
    }));

    menu.append(rule(), section('sessions'));
    if (!session.sessions.length) {
      const e = document.createElement('div');
      e.className = 'c-menu-empty mono-sm';
      e.textContent = 'no sessions yet';
      menu.append(e);
    } else {
      for (const s of session.sessions) {
        const current = s.sessionId === session.sessionId;
        const b = row({
          label: s.title || s.sessionId.slice(0, 8),
          hint: fmtAgo(s.at),
          onClick: () => { closeMenu(); onResume?.(s.sessionId); },
          title: `${s.sessionId}\n${s.cwd || ''}`,
        });
        if (current) b.classList.add('current');
        const ren = document.createElement('span');
        ren.className = 'c-menu-rename mono-sm';
        ren.textContent = 'rename';
        ren.setAttribute('role', 'button');
        ren.tabIndex = 0;
        const rename = async (e) => {
          e.stopPropagation();
          e.preventDefault();
          const next = await askName(s.title || '');
          if (next) await session.renameSession(s.sessionId, next);
          if (!menu.hidden) buildMenu();
        };
        ren.addEventListener('click', rename);
        ren.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') rename(e); });
        b.append(ren);
        menu.append(b);
      }
    }

    menu.append(rule(), section('model'));
    for (const m of MODELS) {
      menu.append(row({
        label: m.label,
        on: session.model === m.id,
        onClick: () => { session.setModel(m.id); buildMenu(); },
      }));
    }

    menu.append(rule(), section('permission'));
    for (const m of PERMISSION_MODES) {
      menu.append(row({
        label: m.label,
        on: session.permissionMode === m.id,
        onClick: () => { session.setPermissionMode(m.id); buildMenu(); },
      }));
    }

    const focus = store.get('focus');
    if (focus) {
      menu.append(rule(), section('folder'));
      const f = document.createElement('div');
      f.className = 'c-menu-empty mono-sm';
      f.textContent = focus + (session.cwd && session.cwd !== focus ? ' · from the next session' : '');
      menu.append(f);
    }

    menu.append(rule(), section('layout'));
    const docked = mode() === 'dock';
    menu.append(row({ label: 'dock beside the page', on: docked, onClick: () => { closeMenu(); if (!docked) onToggleMode?.(); } }));
    menu.append(row({ label: 'full width', on: !docked, onClick: () => { closeMenu(); if (docked) onToggleMode?.(); } }));
  }

  root.append(head, menu);

  function refresh() {
    closeBtn.hidden = mode() !== 'dock';     // in view mode the sidebar is the way out
    const p = session.phase;
    chip.className = 'chip c-status ' + (p === 'error' ? 'err' : p === 'tool' ? 'info' : p === 'thinking' || p === 'starting' ? 'accent' : '');
    chip.textContent = p === 'starting' ? 'starting' : p === 'off' ? 'off' : p;
    if (!menu.hidden) buildMenu();
  }

  return { el: root, refresh, closeMenu };
}
