// Theme. Preference lives in localStorage 'os.theme' as 'light' | 'dark' | 'system'.
// Nothing saved means dark; index.html's first-paint script has to agree with this.
// The resolved value ('light'|'dark') goes on <html data-theme>, into store 'theme',
// out on bus 'theme', and down to the host so it can recolour the native frame.
import { bus, store, commands } from '../registry.js';
import { bridge } from '../bridge/index.js';

const KEY = 'os.theme';
const VALID = new Set(['light', 'dark', 'system']);

let pref = 'dark';
let mq = null;

export function themePref() { return pref; }

export function resolvedTheme() {
  if (pref === 'light' || pref === 'dark') return pref;
  return mq && mq.matches ? 'dark' : 'light';
}

function apply() {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  store.set('theme', t);
  bus.emit('theme', t);
  bridge.win.setTheme(t).catch(() => { /* http mode: no-op */ });
}

export function setTheme(next) {
  pref = VALID.has(next) ? next : 'system';
  try { localStorage.setItem(KEY, pref); } catch { /* private mode */ }
  apply();
}

export function initTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (VALID.has(saved)) pref = saved;
  } catch { /* private mode */ }

  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (pref === 'system') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
  } catch { mq = null; }

  apply();

  commands.register({
    id: 'app.theme',
    title: 'Toggle theme',
    group: 'app',
    hint: 'light / dark',
    run: () => setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark'),
  });
}
