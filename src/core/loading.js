// The loading line an asynchronous region prints while its reads are still out. Shared by the
// views (each box of the Day view, the week grid, the month matrix, the journal record) and
// the router (the page column while the editor mounts, D9), so "loading…" is one line, one
// delay and one behaviour everywhere. DOM and timers only; nothing here touches the bridge.

/** ms a load may take before the region says it is loading: under a blink, nobody sees it */
export const LOADING_DELAY = 150;

/**
 * Arm the loading line for one region. If the reads are still out after `ms`, the box's content
 * is replaced by one quiet `.empty` line and the box is marked `is-loading` (so a grid can drop
 * its columns while it holds a single line); a load that finishes sooner never shows anything,
 * and the old content stays on screen until the new render replaces it. The returned `stop`
 * cancels the timer, clears the mark, and says whether the line was actually shown, so a caller
 * that decides not to redraw (nothing changed) knows it has to put its content back.
 * Call `stop` before rendering, and again in `finally`; it is idempotent.
 */
export function loadingLine(box, ms = LOADING_DELAY) {
  let fired = false;
  let timer = box ? setTimeout(() => {
    timer = null;
    if (!box.isConnected) return;
    fired = true;
    box.classList.add('is-loading');
    box.innerHTML = '<div class="empty">loading…</div>';
  }, ms) : null;
  return () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (box) box.classList.remove('is-loading');
    return fired;
  };
}

/**
 * The same line for a host whose content must not be replaced: the router's page column,
 * where the editor is already mounting into a child of `host`. After `ms` one `.empty` line
 * carrying `className` is appended beside that content (the shell lays it over the column,
 * so nothing moves when it goes); `stop` removes it or cancels the timer. Idempotent.
 */
export function loadingOverlay(host, className = 'main-loading', ms = LOADING_DELAY) {
  let node = null;
  let timer = host ? setTimeout(() => {
    timer = null;
    if (!host.isConnected) return;
    node = document.createElement('div');
    node.className = 'empty ' + className;
    node.textContent = 'loading…';
    host.appendChild(node);
  }, ms) : null;
  return () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (node) { node.remove(); node = null; }
  };
}
