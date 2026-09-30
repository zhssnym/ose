// The page a failed boot leaves instead of a blank window (M38).
//
// Anything can fail on the way up: a module of the shell that does not load, the core not
// answering, the editor bundle throwing on an old web view, a surface that throws while it is
// built. Before this file every one of those was a blank window with the reason in a console
// nobody has open. Now it is one page that says what happened, where the log is, and offers
// the two things a person can do about it: copy the details to send to someone, and try again.
//
// It imports nothing. `main.js` reaches it when `boot.js` itself could not be loaded, which may
// be because the core could not be, so this file cannot lean on either: the core is handed
// in when there is one and only asked for the log path and the version. Colours are the
// tokens, with the system colours behind them for the case where the core's stylesheet is
// what did not arrive.

let shown = false;

/**
 * Draw the error page over `#app`. `stage` is one sentence in the user's words saying how far
 * the boot got; `ose` is the core when it loaded, null when it did not. Only the first call
 * draws: a second failure while the page is up is the same failure seen again.
 *
 * @param {unknown} err
 * @param {{ stage?: string, ose?: any }} [opts]
 */
export async function showBootError(err, { stage = 'Ose could not start.', ose = null } = {}) {
  console.error('[shell] boot', err);
  if (shown) return;
  shown = true;

  const message = describe(err);
  const stack = err && typeof err === 'object' && 'stack' in err && err.stack ? String(err.stack) : '';
  const log = await logPath(ose);
  try { if (ose && typeof ose.log === 'function') await Promise.resolve(ose.log(`boot failed: ${stage} ${message}\n${stack}`, 'error')); } catch { /* the log is what failed */ }

  const root = document.getElementById('app') || document.body;
  root.textContent = '';
  const page = el('main', 'boot-err');
  page.setAttribute('role', 'alert');
  page.append(
    el('h1', 'boot-err-title', 'Ose could not start'),
    el('p', 'boot-err-text', stage),
    el('pre', 'boot-err-msg mono-sm', message),
  );

  const where = el('p', 'boot-err-text');
  if (log) {
    where.append('The details are in the log: ');
    where.append(el('span', 'boot-err-path mono-sm', log));
  } else {
    where.textContent = 'The details are in ose.log, in the app’s log folder.';
  }
  page.append(where);

  if (stack) {
    const more = el('details', 'boot-err-more');
    more.append(el('summary', 'boot-err-summary mono-sm', 'stack'), el('pre', 'boot-err-stack mono-sm', stack));
    page.append(more);
  }

  const actions = el('div', 'boot-err-actions');
  const copy = button('Copy details', 'btn');
  const again = button('Try again', 'btn primary');
  actions.append(copy, again);
  page.append(actions);
  root.append(page);

  const details = [
    'Ose could not start',
    stage,
    message,
    stack,
    `version: ${versionOf(ose)}`,
    `platform: ${(ose && ose.platform) || 'unknown'} · host: ${(ose && ose.host) || 'unknown'}`,
    `log: ${log || 'unknown'}`,
    `agent: ${navigator.userAgent}`,
  ].filter(Boolean).join('\n');

  copy.addEventListener('click', async () => {
    const ok = await copyText(details);
    copy.textContent = ok ? 'Copied' : 'Could not copy';
    setTimeout(() => { copy.textContent = 'Copy details'; }, 1600);
  });
  // Nothing is open yet, so there is nothing a reload could lose: the gate is skipped.
  again.addEventListener('click', () => {
    again.disabled = true;
    Promise.resolve()
      .then(() => (ose && typeof ose.reload === 'function' ? ose.reload({ skipLeave: true }) : null))
      .then((answer) => { if (answer !== true) location.reload(); })
      .catch(() => location.reload());
  });
  setTimeout(() => again.focus(), 0);
}

/** `1.2.0 (a1b2c3d)`, or `unknown` when the core did not load. */
function versionOf(ose) {
  const v = ose && ose.version;
  if (!v) return 'unknown';
  if (typeof v === 'string') return v;
  return `${v.core || 'unknown'}${v.short ? ` (${v.short})` : ''}`;
}

/** One line for the error, whatever was thrown. */
function describe(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  const code = err.code ? `[${err.code}] ` : '';
  return code + String(err.message || err);
}

/** Where the host writes its log (docs/HOST.md "Machine-local state"), when the core can say. */
async function logPath(ose) {
  if (!ose || !ose.vault || typeof ose.vault.info !== 'function') return '';
  try {
    const info = await Promise.race([ose.vault.info(), new Promise((r) => setTimeout(() => r(null), 1500))]);
    return (info && info.logPath) || '';
  } catch { return ''; }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'boot-err-copy';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(text, cls) {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}
