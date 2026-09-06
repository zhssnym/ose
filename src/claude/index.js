// The Claude pane. A real terminal running the Claude Code CLI on the vault (CONTRACT batch 6).
// One long-lived pane element lives in two places: the `agent` view in the main column
// (claude.mode === 'view', the default) and the shell's right side panel (claude.mode ===
// 'dock'). It is moved between them, never rebuilt, so the running pty survives.
// Entry points used by the shell: initClaude(), mountClaudePane(el), unmountClaudePane().

import { commands, store, views, status as statusBar } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { createTerminal } from './terminal.js';
import { createHeader } from './header.js';
import './claude.css';

export const VIEW_NAME = 'agent';

let pane = null;      // built once, kept alive across mount/unmount
let booted = false;
let holder = null;    // detached parent: where the pane waits when nothing hosts it
let viewHost = null;  // the .agent-view wrapper while the agent view is on screen
let installed = true; // bridge.claudeInfo().path was there
let started = false;  // the session is started lazily, on the first mount
const waiting = [];   // actions queued before the pane was built

const mode = () => (store.get('claude.mode') === 'dock' ? 'dock' : 'view');
const isAgentRoute = (r) => !!r && r.type === 'view' && r.name === VIEW_NAME;

// The shell imports this module, so resolve its exports lazily instead of importing it back.
const shellApi = () => import('../shell/index.js').catch((e) => {
  console.warn('[claude] shell unavailable', e);
  return {};
});

/* ------------------------------------------------- persisted mode (state.json) */

// state.js belongs to the shell and may load after this module; localStorage is the fallback.
let statePatch = null;
async function persistApi() {
  if (statePatch) return statePatch;
  try {
    const m = await import('../shell/state.js');
    if (typeof m.patchState === 'function') {
      statePatch = {
        patch: m.patchState,
        read: async () => {
          let c = m.stateCache?.() || {};
          if (!Object.keys(c).length && typeof m.loadState === 'function') {
            try { c = await m.loadState(); } catch { c = {}; }
          }
          return c.claude || {};
        },
      };
      return statePatch;
    }
  } catch { /* not built yet */ }
  statePatch = {
    patch: async (partial) => { try { localStorage.setItem('os.claude', JSON.stringify(partial.claude || {})); } catch { } },
    read: async () => { try { return JSON.parse(localStorage.getItem('os.claude') || '{}'); } catch { return {}; } },
  };
  return statePatch;
}

async function readClaudeState() {
  const api = await persistApi();
  return (await api.read()) || {};
}

/** Merge into the persisted `claude` state. The CLI owns sessions, model and permissions now. */
async function patchClaude(partial) {
  const api = await persistApi();
  const cur = (await api.read()) || {};
  // keys retired with the stream-json pane
  const { cwd, sessions, model, permissionMode, ...keep } = cur;
  await api.patch({ claude: { ...keep, ...partial } });
}

/** Run fn once the pane exists (it is built on the first mount). */
function whenPane(fn) {
  if (pane) queueMicrotask(() => fn(pane));
  else waiting.push(fn);
}

function flushWaiting() {
  while (waiting.length) { const fn = waiting.shift(); try { fn(pane); } catch (e) { console.warn('[claude]', e); } }
}

/* ------------------------------------------------------------------- build */

function build() {
  const el = document.createElement('div');
  el.className = 'agent-pane';

  const goto = async (path) => { (await shellApi()).navigate?.({ type: 'page', path }); };

  const terminal = createTerminal({
    onStatus: (s) => {
      store.set('claude.status', s);
      statusBar.set('claude', s === 'running' ? 'claude running' : s === 'exited' ? 'claude exited' : null);
      header.refresh();
    },
    onNavigate: goto,
    onRestart: () => commands.run('claude.new'),
  });

  const header = createHeader({
    mode,
    status: () => terminal.status,
    onNew: () => commands.run('claude.new'),
    onClose: () => store.set('claude.open', false),
    onToggleMode: () => setMode(mode() === 'dock' ? 'view' : 'dock'),
  });

  const body = document.createElement('div');
  body.className = 'c-body';
  body.append(terminal.el);

  // Only shown when the CLI is missing: there is nothing to run, so no terminal is started.
  const empty = document.createElement('div');
  empty.className = 'c-empty';
  empty.innerHTML = `<p class="mono-sm">Claude Code is not installed on this machine.</p>
    <pre class="c-pre c-install text-select">npm install -g @anthropic-ai/claude-code</pre>
    <p class="mono-sm faint">Then reopen the app. The pane runs <code>claude</code> from your PATH.</p>`;
  empty.hidden = true;
  body.append(empty);

  el.append(header.el, body);

  function refresh() {
    empty.hidden = installed;
    terminal.el.hidden = !installed;
    header.refresh();
  }
  refresh();

  return { el, terminal, header, refresh };
}

function ensurePane() {
  if (!pane) pane = build();
  return pane;
}

/** Start the CLI on first sight of the pane, in the focused folder (or the vault root). */
function ensureStarted() {
  if (!installed || started || !pane) return;
  started = true;
  pane.terminal.start(store.get('focus') || '');
}

/* ------------------------------------------------------------------ hosting */

/** Park the pane in a detached holder. The pty keeps running; only its parent changes. */
function park() {
  if (!pane) return;
  if (!holder) holder = document.createElement('div');
  holder.append(pane.el);
  pane.el.classList.remove('in-view');
}

/** The agent view is going away. Do nothing if the side panel already took the pane. */
function parkFromView() {
  if (pane && pane.el.parentNode === viewHost) park();
  viewHost = null;
}

/**
 * Fallback for a shell that mounts the side panel only once: after the pane has been in the
 * view, put it back into the dock host here. A no-op when the shell already did it.
 */
function ensureDockHost() {
  if (mode() !== 'dock' || !store.get('claude.open')) return;
  if (pane && pane.el.isConnected) return;
  const host = document.querySelector('.claude-host');
  if (host) mountClaudePane(host);
}

async function setMode(next) {
  const to = next === 'dock' ? 'dock' : 'view';
  store.set('claude.mode', to);
  const shell = await shellApi();
  if (to === 'dock') {
    patchClaude({ mode: to, open: true });
    // give the column back to whatever was on screen before the agent view took it, then
    // let the side panel take the pane (the view unmount parks it first)
    if (isAgentRoute(store.get('route'))) shell.back?.();
    store.set('claude.open', true);
    ensureDockHost();
    setTimeout(() => {
      if (isAgentRoute(store.get('route'))) shell.clearRoute?.();
      ensureDockHost();
    }, 0);
  } else {
    patchClaude({ mode: to });
    shell.navigate?.({ type: 'view', name: VIEW_NAME });
  }
  whenPane((p) => p.header.refresh());
}

/** Bring the pane on screen in whichever mode is current. */
async function showPane() {
  if (mode() === 'dock') {
    store.set('claude.open', true);
    ensureDockHost();
    return;
  }
  if (!isAgentRoute(store.get('route'))) (await shellApi()).navigate?.({ type: 'view', name: VIEW_NAME });
}

/* -------------------------------------------------------------------- boot */

export async function initClaude() {
  if (booted) return;
  booted = true;

  const saved = await readClaudeState();
  store.set('claude.mode', saved.mode === 'dock' ? 'dock' : 'view');
  store.set('claude.open', saved.mode === 'dock' && saved.open !== false);
  store.set('claude.status', 'off');

  try {
    const info = await bridge.claudeInfo();
    installed = !!(info && info.path);
  } catch (e) {
    // an old host without the command is not a reason to refuse to run
    console.warn('[claude] claudeInfo', e);
    installed = true;
  }

  views.register(VIEW_NAME, {
    title: 'Claude',
    icon: 'agent',
    mount(el) {
      ensurePane();
      // being on this view is a statement of mode: the side panel gives the pane back
      if (mode() === 'dock') { store.set('claude.mode', 'view'); patchClaude({ mode: 'view' }); }
      store.set('claude.open', false);
      viewHost = document.createElement('div');
      viewHost.className = 'agent-view';
      viewHost.append(pane.el);
      pane.el.classList.add('in-view');
      el.append(viewHost);
      pane.refresh();
      flushWaiting();
      ensureStarted();
      pane.terminal.fit();
      pane.terminal.focus();
    },
    unmount() { parkFromView(); },
    refresh() { /* the terminal is live; there is nothing to reread from disk */ },
  });

  commands.register({
    id: 'claude.toggle', title: 'Toggle the agent', group: 'claude', shortcut: 'Ctrl+J',
    run: async () => {
      // Ctrl+J is the CLI's newline. The shell binds it on window in the capture phase, so the
      // terminal never sees the keystroke; hand it the line feed here instead of toggling.
      if (pane && pane.terminal.hasFocus() && pane.terminal.running) {
        pane.terminal.write('\n');
        return;
      }
      if (mode() === 'dock') {
        const open = !store.get('claude.open');
        store.set('claude.open', open);
        patchClaude({ mode: 'dock', open });
        if (open) { ensureDockHost(); whenPane((p) => p.terminal.focus()); }
        return;
      }
      const shell = await shellApi();
      if (isAgentRoute(store.get('route'))) shell.back?.();
      else shell.navigate?.({ type: 'view', name: VIEW_NAME });
    },
  });

  commands.register({
    id: 'claude.new', title: 'New Claude session', group: 'claude',
    run: async () => {
      await showPane();
      ensurePane();
      if (!installed) return;          // nothing to run: the pane shows how to install it
      started = true;
      await pane.terminal.restart(store.get('focus') || '');
      pane.terminal.focus();
    },
  });

  commands.register({
    id: 'claude.ask-page', title: 'Ask Claude about this page', group: 'claude',
    when: () => store.get('route')?.type === 'page',
    run: async () => {
      const route = store.get('route');
      const path = route?.type === 'page' ? route.path : '';
      // asking about a page keeps the page on screen: dock rather than take the column
      if (mode() !== 'dock') await setMode('dock');
      else { store.set('claude.open', true); ensureDockHost(); }
      whenPane((p) => {
        ensureStarted();
        p.terminal.write(`About the page \`${path}\`: `);
        p.terminal.focus();
      });
    },
  });

  store.watch('claude.open', (open) => {
    if (open && mode() === 'dock') { ensureDockHost(); whenPane((p) => p.terminal.focus()); }
  });
}

/* ------------------------------------------------- side panel host (dock mode) */

export function mountClaudePane(el) {
  ensurePane();
  pane.el.classList.remove('in-view');
  el.append(pane.el);
  pane.refresh();
  flushWaiting();
  ensureStarted();
  pane.terminal.fit();
  return pane.el;
}

export function unmountClaudePane() {
  // the pane stays built so the running pty survives being hidden
  park();
}
