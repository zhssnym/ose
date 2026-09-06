// Dev harness for the Claude pane. Not part of the app build; it exists so the pane can be
// developed and screenshotted against captured fixtures before the bridge grows Claude support.

import { store } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { initClaude, mountClaudePane, session, __pane } from './index.js';

const FIXTURES = [
  ['fixtures/session-1.jsonl', 'read package.json (text + Read)'],
  ['fixtures/session-2-search.jsonl', 'glob + grep'],
  ['fixtures/session-3-edit.jsonl', 'write, edit, bash, failing read'],
  ['fixtures/demo-thinking-error.jsonl', 'thinking, subagent, error result'],
  ['fixtures/demo-thinking-empty.jsonl', 'empty + whitespace thinking (renders nothing), one tool'],
];

const PROMPTS = {
  'fixtures/session-1.jsonl': 'Read App/package.json and tell me the name field in one short sentence',
  'fixtures/session-2-search.jsonl': 'Find the markdown files in Projects and count how often Husna appears in Documents.',
  'fixtures/session-3-edit.jsonl': 'Write Scratchpad/claude-test/note.md, edit it, run git status, then read a file that does not exist.',
  'fixtures/demo-thinking-error.jsonl': 'Plan the September paperwork for Husna and start it.',
  'fixtures/demo-thinking-empty.jsonl': 'What is open in Documents/TASKS.md?',
};

const $ = (id) => document.getElementById(id);
const note = (t) => { $('log').textContent = t; };

let speed = 1;
let cancel = false;

async function boot() {
  try { store.set('root', await bridge.rootInfo()); } catch { store.set('root', { root: 'D:/os', name: 'os' }); }
  await initClaude();
  // the dev bridge reports claudeInfo().path === null until the bridge agent lands it; the
  // harness pretends the CLI is there so replay renders the real pane instead of the empty state.
  if (location.search.includes('missing')) session.info = { path: null };
  else if (!session.installed) session.info = { path: 'claude', version: '2.1.261 (replay)' };
  mountClaudePane($('pane'));

  const sel = $('fix');
  for (const [file, label] of FIXTURES) {
    const o = document.createElement('option');
    o.value = file; o.textContent = label;
    sel.append(o);
  }

  $('play').addEventListener('click', () => replay(sel.value).catch(e => note('replay failed: ' + e.message)));
  $('fast').addEventListener('click', () => { speed = speed === 1 ? 8 : 1; $('fast').textContent = speed === 1 ? 'fast' : 'normal'; });
  $('clear').addEventListener('click', () => { cancel = true; session.clear(); session.setPhase('off'); });
  $('theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('os.theme', next); } catch { }
  });
  $('width').addEventListener('click', () => $('pane').classList.toggle('narrow'));
  $('view').addEventListener('click', () => setView(!viewOn));
  $('expand').addEventListener('click', () => {
    for (const it of session.items) {
      // tools and thinking are both entries of the turn's working row
      if (it.kind === 'tools') { it.open = true; it.userToggled = true; for (const e of it.entries) e.open = true; session.update(it); }
    }
  });
  $('stderr').addEventListener('click', () => {
    session.handleEvent({ type: 'stderr', text: 'node:warning experimental fetch is in use\nclaude: cache warm in 84ms' });
  });
  $('crash').addEventListener('click', () => session.handleEvent({ type: 'exit', code: 1 }));

  if (location.search.includes('replay')) replay(sel.value).catch(e => note('replay failed: ' + e.message));
}

// The pane has two layouts: the 320-400px dock and the full-width agent view. This moves the
// one pane element between them exactly as the app does, so both can be replayed against.
let viewOn = false;
function setView(on) {
  const p = __pane();
  if (!p) return;
  viewOn = on;
  const main = document.querySelector('.h-main');
  let wrap = document.getElementById('av');
  if (on) {
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'av';
      wrap.className = 'agent-view';
      main.append(wrap);
    }
    wrap.append(p.el);
    p.el.classList.add('in-view');
    p.transcript.setScrollHost(main);
    document.querySelector('.h-pane').hidden = true;
  } else {
    mountClaudePane($('pane'));       // also drops the in-view class and the scroll host
    document.querySelector('.h-pane').hidden = false;
    wrap?.remove();
  }
  $('view').textContent = on ? 'dock layout' : 'view layout';
}

async function replay(file) {
  cancel = false;
  session.clear();
  session.setPhase('starting');
  const text = await fetch(new URL(file, import.meta.url)).then(r => r.text());
  const lines = text.trim().split('\n');
  const prompt = PROMPTS[file] || 'replay';
  session.lastPrompt = prompt;
  session.add({ kind: 'user', text: prompt, at: Date.now() });
  session.turnStart = Date.now();
  note(`replaying ${file} (${lines.length} events)`);
  for (const line of lines) {
    if (cancel) return note('cancelled');
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const isDelta = ev.type === 'stream_event' && ev.event?.type === 'content_block_delta';
    await sleep((isDelta ? 26 : 110) / speed);
    session.handleEvent(ev);
  }
  note(`done: ${file}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

boot().catch(e => { note('boot failed: ' + e.message); console.error(e); });
