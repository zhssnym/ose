// Pane header: `Claude`, the status chip, `new session`, `dock`/`full`, and in dock mode a
// close button (there the sidebar is not the way out). Everything the old menu offered —
// model, permission mode, sessions — belongs to the CLI now and is typed into the terminal.

const svg = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
const ICON_CLOSE = svg('<path d="M4 4l8 8M12 4l-8 8"/>');

export function createHeader({ mode = () => 'view', status = () => 'off', onNew, onToggleMode, onClose }) {
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

  const text = (cls, caption, tip, fn) => {
    const b = document.createElement('button');
    b.className = `btn ghost sm ${cls}`;
    b.type = 'button';
    b.textContent = caption;
    b.dataset.tip = tip;
    b.addEventListener('click', fn);
    return b;
  };

  // tooltips stay short: at the 320px dock width a long one is clipped by the pane
  const newBtn = text('c-new', 'new session', 'restart claude', () => onNew?.());
  const modeBtn = text('c-mode', 'dock', 'beside the page', () => onToggleMode?.());

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn ghost icon sm c-close-btn';
  closeBtn.type = 'button';
  closeBtn.innerHTML = ICON_CLOSE;
  closeBtn.dataset.tip = 'close pane';
  closeBtn.setAttribute('aria-label', 'close pane');
  closeBtn.addEventListener('click', () => onClose?.());

  head.append(label, chip, grow, newBtn, modeBtn, closeBtn);
  root.append(head);

  function refresh() {
    const docked = mode() === 'dock';
    closeBtn.hidden = !docked;
    modeBtn.textContent = docked ? 'full' : 'dock';
    modeBtn.dataset.tip = docked ? 'whole column' : 'beside the page';
    const s = status();
    chip.className = 'chip c-status ' + (s === 'running' ? 'ok' : s === 'exited' ? 'err' : '');
    chip.textContent = s;
  }

  refresh();
  return { el: root, refresh };
}
