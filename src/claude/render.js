// Transcript rendering. One DOM node per transcript item, rebuilt in place on update.
// Markdown goes through marked and is sanitised with DOMPurify before it touches the page.

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { esc, store } from '../registry.js';
import { toolRow, isPagePath, fmtClock, fmtDuration, vaultRel } from './protocol.js';

marked.setOptions({ gfm: true, breaks: false });

const RESULT_LINES = 60;
const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

const root = () => store.get('root')?.root || '';

/* One mono character, cycling. Every spinner on screen shares one interval, and the interval
   only exists while something is running. Reduced motion gets a still glyph. */
const SPIN = ['|', '/', '-', '\\'];
const spinners = new Set();
let spinTimer = 0;
let spinFrame = 0;
const still = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function tickSpinners() {
  spinFrame = (spinFrame + 1) % SPIN.length;
  for (const n of [...spinners]) {
    if (!n.isConnected) { spinners.delete(n); continue; }
    n.textContent = SPIN[spinFrame];
  }
  if (!spinners.size) { clearInterval(spinTimer); spinTimer = 0; }
}

function spinner() {
  const n = el('span', 'c-spin', SPIN[spinFrame]);
  n.setAttribute('aria-hidden', 'true');
  if (still()) { n.textContent = SPIN[0]; return n; }
  spinners.add(n);
  if (!spinTimer) spinTimer = setInterval(tickSpinners, 120);
  return n;
}

function md(text) {
  let html;
  try { html = marked.parse(String(text ?? '')); }
  catch { html = `<p>${esc(text)}</p>`; }
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target'] });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** A block of plain text, clipped to `max` lines with a "show all" toggle. */
function clipped(text, max = RESULT_LINES, cls = 'c-pre') {
  const wrap = el('div', 'c-clip');
  const lines = String(text ?? '').replace(/\s+$/, '').split('\n');
  const pre = el('pre', cls);
  const short = lines.slice(0, max).join('\n');
  pre.textContent = lines.length > max ? short : lines.join('\n');
  wrap.append(pre);
  if (lines.length > max) {
    let open = false;
    const btn = el('button', 'c-more mono-sm', `show all ${lines.length} lines`);
    btn.addEventListener('click', () => {
      open = !open;
      pre.textContent = open ? lines.join('\n') : short;
      btn.textContent = open ? 'show less' : `show all ${lines.length} lines`;
    });
    wrap.append(btn);
  }
  return wrap;
}

function diffBlock(oldStr, newStr) {
  const wrap = el('div', 'c-diff');
  const side = (txt, kind, sign) => {
    for (const line of String(txt ?? '').split('\n')) {
      const row = el('div', `c-diff-line ${kind}`);
      row.append(el('span', 'c-diff-sign', sign), el('span', 'c-diff-text', line));
      wrap.append(row);
    }
  };
  side(oldStr, 'del', '-');
  side(newStr, 'ins', '+');
  return wrap;
}

function jsonBlock(obj) {
  let text;
  try { text = JSON.stringify(obj, null, 2); } catch { text = String(obj); }
  return clipped(text, RESULT_LINES, 'c-pre c-json');
}

/** Detail body for an expanded tool row. */
function toolDetail(item, onNavigate) {
  const box = el('div', 'c-tool-detail');
  const i = item.input || {};
  const name = item.toolName;
  const field = (label, node) => { box.append(el('div', 'c-field-label label', label)); box.append(node); };

  if (name === 'Edit' && (i.old_string != null || i.new_string != null)) {
    field(i.replace_all ? 'diff (all occurrences)' : 'diff', diffBlock(i.old_string, i.new_string));
  } else if (name === 'Write') {
    field('content', clipped(i.content ?? '', RESULT_LINES));
  } else if (name === 'Bash') {
    field('command', clipped(i.command ?? '', 20, 'c-pre c-cmd'));
    if (i.description) field('why', el('div', 'c-note-text', i.description));
  } else if (name === 'Read') {
    const p = vaultRel(i.file_path, root());
    const line = el('div', 'c-kv mono-sm');
    line.append(el('span', '', p || '?'));
    if (i.offset || i.limit) line.append(el('span', 'faint', ` lines ${i.offset || 1}${i.limit ? ' to ' + ((i.offset || 1) + i.limit - 1) : '+'}`));
    field('path', line);
  } else if (Object.keys(i).length) {
    field('input', jsonBlock(i));
  }

  if (item.result != null && String(item.result).length) {
    field(item.isError ? 'error' : 'result', clipped(item.result, RESULT_LINES, `c-pre${item.isError ? ' c-pre-err' : ''}`));
  } else if (item.state === 'running') {
    box.append(el('div', 'c-field-label label', 'running…'));
  }

  // make any vault path in the detail clickable through the row header only; keep detail plain
  void onNavigate;
  return box;
}

function renderTool(item, node, onNavigate) {
  node.className = `c-tool state-${item.state}${item.sub ? ' sub' : ''}${item.open ? ' open' : ''}`;
  node.innerHTML = '';
  node.dataset.tool = item.id;
  const head = el('button', 'c-tool-head');
  head.type = 'button';
  const { label, arg, path } = toolRow(item.toolName, item.input, root());
  const glyph = el('span', 'c-glyph');
  glyph.setAttribute('aria-hidden', 'true');
  const chev = el('span', 'c-chev');
  chev.innerHTML = CHEVRON;
  const name = el('span', 'c-tool-name', label);
  const argEl = el('span', 'c-tool-arg', arg || '');
  head.append(chev, glyph, name, argEl);
  head.setAttribute('aria-expanded', item.open ? 'true' : 'false');
  head.title = `${item.toolName} ${arg}`.trim();
  head.addEventListener('click', () => {
    item.open = !item.open;
    renderTool(item, node, onNavigate);
  });
  node.append(head);

  if (path && isPagePath(path)) {
    argEl.classList.add('c-link');
    argEl.addEventListener('click', (e) => { e.stopPropagation(); onNavigate?.(path); });
    argEl.title = `open ${path}`;
  }
  if (item.open) node.append(toolDetail(item, onNavigate));
  return node;
}

/** One thinking block, always an entry inside a turn's working row. Collapsed by default. */
function renderThinking(item, node) {
  node.className = `c-think${item.open ? ' open' : ''}${item.sub ? ' sub' : ''}`;
  node.innerHTML = '';
  const head = el('button', 'c-think-head');
  head.type = 'button';
  const chev = el('span', 'c-chev');
  chev.innerHTML = CHEVRON;
  const gap = el('span', 'c-think-gap');          // lines the label up with the tool rows' glyph
  gap.setAttribute('aria-hidden', 'true');
  head.append(chev, gap, el('span', 'c-think-name', item.streaming ? 'thinking…' : 'thinking'));
  head.setAttribute('aria-expanded', item.open ? 'true' : 'false');
  head.addEventListener('click', () => { item.open = !item.open; renderThinking(item, node); });
  node.append(head);
  if (item.open) node.append(clipped(item.text, 200, 'c-pre c-think-body'));
  return node;
}

/**
 * One turn's work, folded into a single row: its tool calls and its thinking, in arrival order.
 * The label counts what is inside — `working · 2 tools · thinking` while it runs, the same
 * without the prefix once it is done. Expanded while running, collapsed when the turn's text
 * arrives; clicking toggles it and then it stays where the user put it.
 */
function renderTools(item, node, onNavigate) {
  const entries = item.entries || [];
  const tools = entries.filter(e => e.kind === 'tool');
  const thinking = entries.some(e => e.kind === 'thinking');
  const failed = tools.filter(t => t.state === 'error').length;
  node.className = `c-tools${item.open ? ' open' : ''}${item.running ? ' running' : ''}`;
  node.innerHTML = '';

  const head = el('button', 'c-tools-head mono-sm');
  head.type = 'button';
  const chev = el('span', 'c-chev');
  chev.innerHTML = CHEVRON;
  head.append(chev);
  if (item.running) head.append(spinner());
  const parts = [];
  if (tools.length) parts.push(`${tools.length} tool${tools.length === 1 ? '' : 's'}`);
  if (thinking) parts.push('thinking');
  const what = parts.join(' · ');
  head.append(el('span', 'c-tools-label', item.running ? (what ? `working · ${what}` : 'working') : (what || 'working')));
  if (failed) head.append(el('span', 'c-tools-failed', `· ${failed} failed`));
  head.setAttribute('aria-expanded', item.open ? 'true' : 'false');
  head.addEventListener('click', () => {
    item.open = !item.open;
    item.userToggled = true;
    renderTools(item, node, onNavigate);
  });
  node.append(head);

  if (!item.open) return node;
  const body = el('div', 'c-tools-body');
  for (const e of entries) {
    body.append(e.kind === 'thinking'
      ? renderThinking(e, document.createElement('div'))
      : renderTool(e, document.createElement('div'), onNavigate));
  }
  node.append(body);
  return node;
}

function renderItem(item, node, onNavigate) {
  switch (item.kind) {
    case 'user': {
      node.className = 'c-user text-select';
      node.innerHTML = '';
      const t = el('div', 'c-user-text');
      t.textContent = item.text;
      node.append(t, el('div', 'c-user-time mono-sm', fmtClock(item.at)));
      return node;
    }
    case 'text': {
      node.className = `c-text text-select${item.streaming ? ' streaming' : ''}${item.sub ? ' sub' : ''}`;
      node.innerHTML = md(item.text);
      return node;
    }
    // thinking is never a row of its own; it only reaches this switch through a group's body
    case 'thinking': return renderThinking(item, node);
    case 'tool': return renderTool(item, node, onNavigate);
    case 'tools': return renderTools(item, node, onNavigate);
    case 'divider': {
      node.className = 'c-divider mono-sm';
      node.innerHTML = '';
      node.append(el('span', 'c-divider-text', item.text || ''));
      return node;
    }
    case 'result': {
      node.className = `c-result mono-sm${item.ok || item.interrupted ? '' : ' err'}`;
      const bits = [item.interrupted ? 'stopped' : item.ok ? 'done' : (item.subtype || 'error')];
      if (item.durationMs != null) bits.push(fmtDuration(item.durationMs));
      node.textContent = bits.join(' · ') + (item.text ? ` — ${item.text}` : '');
      return node;
    }
    case 'error': {
      node.className = 'c-error';
      node.innerHTML = '';
      const t = el('div', 'c-error-text mono-sm text-select', item.text);
      node.append(t);
      if (item.restart) {
        const b = el('button', 'btn sm', 'start new session');
        b.addEventListener('click', () => item.onRestart?.());
        node.append(b);
      }
      return node;
    }
    case 'note':
    default: {
      node.className = 'c-note mono-sm';
      node.textContent = item.text || '';
      return node;
    }
  }
}

export function createTranscript({ onNavigate } = {}) {
  const scroll = el('div', 'c-scroll');
  const thread = el('div', 'c-thread');
  scroll.append(thread);
  const nodes = new Map();
  let stick = true;
  let raf = 0;
  const pending = new Set();

  // The element that actually scrolls. In the pane it is our own box; in the agent view the
  // transcript flows in the shell's main scroller, so the follow logic reads that instead.
  let host = scroll;
  const atBottom = () => host.scrollHeight - host.scrollTop - host.clientHeight < 32;
  const toBottom = () => { host.scrollTop = host.scrollHeight; };
  const onScroll = () => { stick = atBottom(); jump.hidden = stick; };
  scroll.addEventListener('scroll', onScroll, { passive: true });

  const jump = el('button', 'c-jump mono-sm', 'jump to latest');
  jump.hidden = true;
  jump.addEventListener('click', () => { stick = true; jump.hidden = true; toBottom(); });

  const flush = () => {
    raf = 0;
    for (const item of pending) {
      const node = nodes.get(item.key);
      if (node) renderItem(item, node, onNavigate);
    }
    pending.clear();
    if (stick) toBottom();
  };
  const schedule = (item) => {
    pending.add(item);
    if (!raf) raf = requestAnimationFrame(flush);
  };

  // internal link clicks inside rendered markdown
  scroll.addEventListener('click', async (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^[a-z]+:\/\//i.test(href) || href.startsWith('mailto:')) {
      const { bridge } = await import('../bridge/index.js');
      bridge.openExternal(href).catch(() => { });
    } else if (isPagePath(href)) {
      onNavigate?.(href.replace(/^\.?\//, ''));
    }
  });

  return {
    el: scroll,
    jump,
    add(item) {
      const node = el('div');
      nodes.set(item.key, node);
      thread.append(renderItem(item, node, onNavigate));
      if (stick) toBottom();
      else jump.hidden = false;
    },
    update(item) { schedule(item); },
    reset() { nodes.clear(); thread.innerHTML = ''; stick = true; jump.hidden = true; },
    setEmpty(node) { thread.innerHTML = ''; nodes.clear(); if (node) thread.append(node); },
    get thread() { return thread; },
    scrollToBottom() { stick = true; jump.hidden = true; toBottom(); },
    /** Follow another scroller (the main column in the agent view); null returns to our own. */
    setScrollHost(next) {
      const el2 = next || scroll;
      if (el2 === host) return;
      host.removeEventListener('scroll', onScroll);
      host = el2;
      host.addEventListener('scroll', onScroll, { passive: true });
      stick = true;
      jump.hidden = true;
      requestAnimationFrame(toBottom);
    },
  };
}
