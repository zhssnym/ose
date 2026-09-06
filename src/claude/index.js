// The Claude pane. A conversation with Claude Code running on the vault, not a terminal.
// One long-lived pane element lives in two places: the `agent` view in the main column
// (claude.mode === 'view', the default) and the shell's right side panel (claude.mode ===
// 'dock'). It is moved between them, never rebuilt, so a running session survives.
// Entry points used by the shell: initClaude(), mountClaudePane(el), unmountClaudePane().

import { commands, store, views } from '../registry.js';
import { session, readClaudeState, patchClaude } from './session.js';
import { createTranscript } from './render.js';
import { createComposer } from './composer.js';
import { createHeader } from './header.js';
import './claude.css';

export const VIEW_NAME = 'agent';

let pane = null;      // built once, kept alive across mount/unmount
let booted = false;
let holder = null;    // detached parent: where the pane waits when nothing hosts it
let viewHost = null;  // the .agent-view wrapper while the agent view is on screen
const waiting = [];   // actions queued before the pane was mounted anywhere

const mode = () => (store.get('claude.mode') === 'dock' ? 'dock' : 'view');
const isAgentRoute = (r) => !!r && r.type === 'view' && r.name === VIEW_NAME;

// The shell imports this module, so resolve its exports lazily instead of importing it back.
const shellApi = () => import('../shell/index.js').catch((e) => {
  console.warn('[claude] shell unavailable', e);
  return {};
});

/** Run fn once the pane exists (it is built on the first mount). */
function whenPane(fn) {
  if (pane) queueMicrotask(() => fn(pane));
  else waiting.push(fn);
}

function flushWaiting() {
  while (waiting.length) { const fn = waiting.shift(); try { fn(pane); } catch (e) { console.warn('[claude]', e); } }
}

function build() {
  const el = document.createElement('div');
  el.className = 'agent-pane';

  const goto = async (path) => { (await shellApi()).navigate?.({ type: 'page', path }); };
  const transcript = createTranscript({ onNavigate: goto });

  const composer = createComposer({
    onSend: (text) => session.send(text),
    onInterrupt: () => session.interrupt(),
    lastPrompt: () => session.lastPrompt,
  });

  const header = createHeader({
    session,
    mode,
    onNew: () => commands.run('claude.new'),
    onClose: () => store.set('claude.open', false),
    onResume: (id) => session.resume(id),
    onToggleMode: () => setMode(mode() === 'dock' ? 'view' : 'dock'),
  });

  const body = document.createElement('div');
  body.className = 'c-body';
  body.append(transcript.el);
  // the jump button rides with the composer, so it works in both modes (sticky in the view)
  composer.el.append(transcript.jump);

  // stderr strip
  const log = document.createElement('div');
  log.className = 'c-log';
  log.hidden = true;
  const logHead = document.createElement('button');
  logHead.className = 'c-log-head mono-sm';
  logHead.type = 'button';
  const logBody = document.createElement('pre');
  logBody.className = 'c-log-body c-pre text-select';
  log.append(logHead, logBody);
  logHead.addEventListener('click', () => toggleLog());
  let logOpen = false;
  function toggleLog() {
    logOpen = !logOpen;
    log.hidden = !session.log.length;
    log.classList.toggle('open', logOpen);
    renderLog();
  }
  function renderLog() {
    log.hidden = !session.log.length;
    logHead.textContent = `${logOpen ? '▾' : '▸'} log · ${session.log.length}`;
    logBody.hidden = !logOpen;
    if (logOpen) { logBody.textContent = session.log.map(l => l.text).join('\n'); logBody.scrollTop = logBody.scrollHeight; }
  }

  el.append(header.el, body, log, composer.el);

  function emptyState() {
    const box = document.createElement('div');
    box.className = 'c-empty';
    if (!session.installed) {
      box.innerHTML = `<p class="mono-sm">Claude Code is not installed on this machine.</p>
        <pre class="c-pre c-install text-select">npm install -g @anthropic-ai/claude-code</pre>
        <p class="mono-sm faint">Then reopen the app. The pane runs <code>claude</code> from your PATH.</p>`;
    } else {
      box.innerHTML = `<p class="mono-sm">Ask Claude about this vault.</p>
        <p class="mono-sm faint">It reads and edits files in the vault root, under the CLAUDE.md rules of each folder.</p>`;
    }
    return box;
  }

  function refreshEmpty() {
    if (!session.items.length) transcript.setEmpty(emptyState());
  }

  function refresh() {
    header.refresh();
    composer.setDisabled(session.phase === 'starting' || !session.installed,
      session.installed ? 'starting claude…' : 'claude code not found on this machine');
    composer.setRunning(session.phase === 'thinking' || session.phase === 'tool');
    renderLog();
  }

  session.on((kind, payload) => {
    if (kind === 'add') {
      if (session.items.length === 1) transcript.setEmpty(null); // drop the empty state
      if (payload.kind === 'error' && payload.restart) payload.onRestart = () => commands.run('claude.new');
      transcript.add(payload);
      refresh();
    } else if (kind === 'update') {
      transcript.update(payload);
    } else if (kind === 'reset') {
      transcript.reset();
      refreshEmpty();
      refresh();
    } else if (kind === 'log') {
      renderLog();
      header.refresh();
    } else {
      refresh();
      refreshEmpty();   // 'meta' can carry a late claudeInfo: redraw the empty state
    }
  });

  refreshEmpty();
  refresh();

  return { el, composer, transcript, refresh, refreshEmpty };
}

/* ------------------------------------------------------------------ hosting */

function ensurePane() {
  if (!pane) pane = build();
  return pane;
}

/** Park the pane in a detached holder. It keeps running; only its parent changes. */
function park() {
  if (!pane) return;
  if (!holder) holder = document.createElement('div');
  holder.append(pane.el);
  pane.el.classList.remove('in-view');
  pane.transcript.setScrollHost(null);
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

/* ------------------------------------------------------------------ boot */

export async function initClaude() {
  if (booted) return;
  booted = true;

  const saved = await readClaudeState();
  store.set('claude.mode', saved.mode === 'dock' ? 'dock' : 'view');
  store.set('claude.open', saved.mode === 'dock' && saved.open !== false);

  await session.init();

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
      pane.transcript.setScrollHost(el);
      pane.refresh();
      flushWaiting();
      pane.composer.focus();
    },
    unmount() { parkFromView(); },
    refresh() { /* the transcript is live; there is nothing to reread from disk */ },
  });

  commands.register({
    id: 'claude.toggle', title: 'Toggle the agent', group: 'claude', shortcut: 'Ctrl+J',
    run: async () => {
      if (mode() === 'dock') {
        const open = !store.get('claude.open');
        store.set('claude.open', open);
        patchClaude({ mode: 'dock', open });
        if (open) { ensureDockHost(); whenPane(p => p.composer.focus()); }
        return;
      }
      const shell = await shellApi();
      if (isAgentRoute(store.get('route'))) shell.back?.();
      else shell.navigate?.({ type: 'view', name: VIEW_NAME });
    },
  });
  commands.register({
    id: 'claude.new', title: 'New Claude session', group: 'claude',
    run: async () => { await session.newSession(); await showPane(); whenPane(p => p.composer.focus()); },
  });
  commands.register({
    id: 'claude.interrupt', title: 'Interrupt Claude', group: 'claude', hint: 'Esc',
    when: () => session.running, run: () => session.interrupt(),
  });
  commands.register({
    id: 'claude.stop', title: 'Stop the Claude process', group: 'claude',
    when: () => !!session.procId, run: () => session.stop(),
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
      whenPane(p => p.composer.prefill(`About the open page \`${path}\`: `));
    },
  });

  store.watch('claude.open', (open) => {
    if (open && mode() === 'dock') { ensureDockHost(); whenPane(p => p.composer.focus()); }
  });
  if (!store.get('claude.status')) store.set('claude.status', 'off');
}

/* ------------------------------------------------- side panel host (dock mode) */

export function mountClaudePane(el) {
  ensurePane();
  pane.el.classList.remove('in-view');
  pane.transcript.setScrollHost(null);
  el.append(pane.el);
  pane.refresh();
  flushWaiting();
  return pane.el;
}

export function unmountClaudePane() {
  // the pane stays built so a running session survives being hidden
  park();
}

// exposed for the dev harness in this folder only
export function __pane() { return pane; }
export { session };
