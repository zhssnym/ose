// The session model: one Claude Code process at a time, translated into a flat list of
// transcript items. Pure of DOM. `handleEvent` is the single entry point for protocol events,
// so the live bridge and the replay harness go through exactly the same code.

import { store, status as statusBar, uid } from '../registry.js';
import { bridge } from '../bridge/index.js';
import { resultText, looseJson, fmtDate } from './protocol.js';

const MAX_SESSIONS = 12;

// The transcript file keeps the CLI's own plumbing as user messages: slash-command wrappers,
// their stdout, and the caveat banner a resumed session starts with. None of it is conversation.
const CLI_NOISE = /^\s*(<(command-name|command-message|command-args|local-command-(caveat|stdout|stderr)|user-prompt-submit-hook|system-reminder)\b|Caveat: The messages below)/i;

function emitter() {
  const set = new Set();
  return { on: (fn) => (set.add(fn), () => set.delete(fn)), emit: (k, v) => { for (const fn of [...set]) { try { fn(k, v); } catch (e) { console.error('[claude]', e); } } } };
}

// state.js may not exist yet (another agent owns the shell); fall back to localStorage.
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
          // the shell loads state before feature modules, but do not depend on the order
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

export const PERMISSION_MODES = [
  { id: 'acceptEdits', label: 'edits' },
  { id: 'bypassPermissions', label: 'full access' },
  { id: 'plan', label: 'plan' },
];

// `opus` is the default; `default` means no --model flag at all, so the CLI picks.
export const MODELS = [
  { id: 'opus', label: 'opus' },
  { id: 'sonnet', label: 'sonnet' },
  { id: 'default', label: 'default' },
];

const KNOWN_MODELS = new Set(MODELS.map(m => m.id));
const normalizeModel = (m) => (KNOWN_MODELS.has(m) ? m : 'opus');

const KNOWN_MODES = new Set(PERMISSION_MODES.map(m => m.id));
// 'default' (ask) was removed: its prompts cannot be answered in the pane, so it denied
// everything past a read. Anything saved under it becomes the normal edits mode.
const normalizeMode = (m) => (KNOWN_MODES.has(m) ? m : 'acceptEdits');

/** Read the persisted `claude` state object (state.json, or localStorage before the shell). */
export async function readClaudeState() {
  const api = await persistApi();
  return (await api.read()) || {};
}

/** Merge into the persisted `claude` state without dropping keys another module owns. */
export async function patchClaude(partial) {
  const api = await persistApi();
  const { cwd, ...cur } = (await api.read()) || {};   // `cwd` retired with the page-folder mode
  await api.patch({ claude: { ...cur, ...partial } });
}

class Session {
  constructor() {
    this.ev = emitter();
    this.items = [];
    this.log = [];             // stderr lines
    this.phase = 'off';        // off | starting | idle | thinking | tool | error
    this.procId = null;        // bridge process id
    this.sessionId = null;     // Claude session id (for --resume)
    this.model = 'opus';       // model preference: 'opus' | 'sonnet' | 'default'
    this.modelId = null;       // what system/init reported (e.g. 'claude-opus-5')
    this.cwd = null;
    this.permissionMode = 'acceptEdits';
    this.sessions = [];        // recent, persisted
    this.info = null;          // claudeInfo()
    this.turnStart = 0;
    this.lastPrompt = '';
    this.lastDuration = null;
    this._byIndex = new Map(); // stream block index -> item (current message)
    this._byToolId = new Map();
    this._msgId = null;
    this._openTools = new Set();
    this._killed = new Set();  // processes we stopped: their late output is not an error
    this._toolGroup = null;    // the `working · N tools · thinking` row of the current turn
    this._pendingThink = [];   // streamed thinking blocks, held out of the row until they have text
    this._resumeNext = null;   // session to --resume when the next process starts
    this._resumedFrom = null;
    this._sawResult = false;
    this._interrupted = false;
    this._unsub = null;
  }

  on(fn) { return this.ev.on(fn); }

  async init() {
    const api = await persistApi();
    const saved = (await api.read()) || {};
    if (saved.permissionMode) this.permissionMode = normalizeMode(saved.permissionMode);
    this.model = normalizeModel(saved.model);
    this.sessions = Array.isArray(saved.sessions) ? saved.sessions.slice(0, MAX_SESSIONS) : [];
    try { this.info = await bridge.claudeInfo(); } catch { this.info = { path: null }; }
    // The bridge can time out spawning `claude --version` while the app is still booting, and
    // one miss would leave the pane claiming Claude Code is not installed. Ask once more.
    if (!this.info || !this.info.path) {
      setTimeout(async () => {
        try {
          const again = await bridge.claudeInfo();
          if (again && again.path) { this.info = again; this.ev.emit('meta'); }
        } catch { /* still not there: the empty state is right */ }
      }, 1500);
    }
    this.setPhase('off');
    this.ev.emit('meta');
    return this.info;
  }

  async persist() {
    await patchClaude({ sessions: this.sessions, permissionMode: this.permissionMode, model: this.model });
  }

  get installed() { return !!this.info && !!this.info.path; }
  get running() { return this.phase === 'thinking' || this.phase === 'tool' || this.phase === 'starting'; }

  setPhase(p) {
    if (this.phase === p) return;
    this.phase = p;
    store.set('claude.status', p === 'starting' ? 'thinking' : p);
    this.pushStatusBar();
    this.ev.emit('phase', p);
  }

  pushStatusBar() {
    const running = [...this._openTools].map(id => this._byToolId.get(id)).filter(Boolean);
    if (this.phase === 'off') statusBar.set('claude', null);
    else if (this.phase === 'error') statusBar.set('claude', 'claude error');
    else if (this.phase === 'tool' && running.length) statusBar.set('claude', `claude: ${running[running.length - 1].toolName}`);
    else if (this.phase === 'thinking' || this.phase === 'starting') statusBar.set('claude', 'claude thinking');
    else statusBar.set('claude', 'claude idle');
  }

  add(item) {
    item.key = item.key || uid();
    this.items.push(item);
    this.ev.emit('add', item);
    return item;
  }

  update(item) { this.ev.emit('update', item); }

  clear() {
    this.items = [];
    this.log = [];
    this._byIndex.clear(); this._byToolId.clear(); this._openTools.clear();
    this._msgId = null; this._sawResult = false; this._toolGroup = null; this._pendingThink = [];
    this.lastDuration = null;
    this.ev.emit('reset');
  }

  // ---- lifecycle -------------------------------------------------------

  // Always the vault root: '' is the root for both the host and the dev bridge. The pane used
  // to follow the folder of the open page; one CLAUDE.md chain (the root one) is the rule now.
  // The vault root, or the focus folder while focus mode is on (that folder's CLAUDE.md then
  // applies). A running session keeps its cwd until the next new session (CONTRACT.md batch 4).
  resolveCwd() { return store.get('focus') || ''; }

  listen() {
    if (this._unsub) return;
    this._unsub = bridge.on('claude', (msg) => {
      if (!msg) return;
      // ignore anything from a process that is not the current one, and everything that trails
      // out of one we killed ourselves (its exit code 1 is our doing, not a failure)
      if (msg.id && this._killed.has(msg.id)) return;
      if (this.procId && msg.id && msg.id !== this.procId) return;
      this.handleEvent(msg.event);
    });
  }

  async start({ resume = null } = {}) {
    this.listen();
    this.setPhase('starting');
    this.cwd = this.resolveCwd();
    try {
      const r = await bridge.claudeStart({
        cwd: this.cwd,
        permissionMode: this.permissionMode,
        ...(resume ? { resume } : {}),
        ...(this.model && this.model !== 'default' ? { model: this.model } : {}),
      });
      this.procId = r?.id ?? null;
      if (resume) { this.sessionId = resume; this._resumedFrom = resume; }
      this.ev.emit('meta');
      return true;
    } catch (e) {
      this.setPhase('error');
      this.add({ kind: 'error', text: `could not start claude: ${e.message || e}`, restart: true });
      return false;
    }
  }

  async send(text) {
    const body = String(text || '').trim();
    if (!body) return;
    this.lastPrompt = body;
    this.add({ kind: 'user', text: body, at: Date.now() });
    this.turnStart = Date.now();
    this._sawResult = false;
    if (!this.procId) {
      const resume = this._resumeNext;
      this._resumeNext = null;
      const ok = await this.start({ resume });
      if (!ok) return;
    }
    this.setPhase('thinking');
    try {
      await bridge.claudeSend(this.procId, body);
    } catch (e) {
      this.setPhase('error');
      this.add({ kind: 'error', text: `send failed: ${e.message || e}`, restart: true });
    }
  }

  async interrupt() {
    if (!this.procId || !this.running) return;
    this._interrupted = true;
    try { await bridge.claudeInterrupt(this.procId); } catch (e) { this.add({ kind: 'note', text: `interrupt failed: ${e.message || e}` }); }
    this.add({ kind: 'note', text: 'interrupted' });
    this.closeOpenTools('error');
    this.endTurn();
    this.setPhase('idle');
  }

  async stop() {
    const id = this.procId;
    if (id) {
      this._killed.add(id);
      try { await bridge.claudeStop(id); } catch { }
    }
    this.procId = null;
    this.closeOpenTools('error');
    this.endTurn();
    this.setPhase('off');
    this.ev.emit('meta');
  }

  async newSession() {
    await this.stop();
    this.sessionId = null;
    this._resumeNext = null;
    this._resumedFrom = null;
    this.clear();
    this.setPhase('off');
    this.ev.emit('meta');
  }

  /**
   * Show an earlier session's history and continue it. The process is not started here:
   * `--resume` is handed to the next `send`, exactly like a fresh session, so the composer stays
   * live and no process sits idle waiting for a message that may never come.
   */
  async resume(sessionId) {
    await this.stop();
    this.clear();
    this.sessionId = sessionId;
    this._resumeNext = sessionId;
    this._resumedFrom = sessionId;
    await this.loadHistory(sessionId);
    this.add({ kind: 'divider', text: `resumed · ${fmtDate(Date.now())}` });
    this.setPhase('off');
    this.ev.emit('meta');
  }

  /**
   * Read the CLI's own transcript file for a session and replay it as transcript items:
   * user text, assistant text, tool calls and non-empty thinking folded into their turn's row.
   */
  async loadHistory(sessionId) {
    let lines = [];
    try { lines = await bridge.claudeTranscript(sessionId); }
    catch (e) {
      this.add({ kind: 'note', text: `history unavailable: ${e.message || e}` });
      return;
    }
    if (!Array.isArray(lines) || !lines.length) return;

    const out = [];
    const byTool = new Map();
    let group = null;

    for (const entry of lines) {
      if (!entry || typeof entry !== 'object' || entry.isMeta) continue;
      const msg = entry.message || {};
      const role = msg.role || (entry.type === 'user' ? 'user' : 'assistant');
      const at = Date.parse(entry.timestamp || '') || undefined;
      const raw = msg.content;
      const blocks = Array.isArray(raw)
        ? raw
        : typeof raw === 'string' && raw.trim() ? [{ type: 'text', text: raw }] : [];

      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (role === 'user') {
          if (b.type === 'text') {
            const text = String(b.text ?? '').trim();
            if (!text || CLI_NOISE.test(text)) continue;
            group = null;
            out.push({ kind: 'user', text, at });
          } else if (b.type === 'tool_result') {
            const it = byTool.get(b.tool_use_id);
            if (!it) continue;
            it.result = resultText(b.content);
            it.isError = b.is_error === true;
            it.state = it.isError ? 'error' : 'done';
          }
        } else if (b.type === 'text') {
          const text = String(b.text ?? '');
          if (!text.trim()) continue;
          group = null;
          out.push({ kind: 'text', text, streaming: false, finalised: true });
        } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          // same rule as live: empty (or redacted, which carries no text) renders nothing
          const text = String(b.thinking ?? b.text ?? '');
          if (!text.trim()) continue;
          if (!group) { group = { kind: 'tools', entries: [], open: false, running: false }; out.push(group); }
          group.entries.push({ key: uid(), kind: 'thinking', text, streaming: false, finalised: true, open: false, group });
        } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          if (!group) { group = { kind: 'tools', entries: [], open: false, running: false }; out.push(group); }
          const it = {
            key: uid(), kind: 'tool', id: b.id || uid(), toolName: b.name || 'Tool',
            input: b.input || {}, state: 'done', result: null, isError: false, group,
          };
          group.entries.push(it);
          byTool.set(it.id, it);
        }
        // every other block type: not part of the record we show
      }
    }
    // added only once the tool results have been folded in, so nothing renders twice
    for (const item of out) this.add(item);
  }

  async setPermissionMode(mode) {
    const next = normalizeMode(mode);
    if (next === this.permissionMode) return;
    this.permissionMode = next;
    await this.persist();
    await this.restartForSetting(`permission · ${PERMISSION_MODES.find(m => m.id === next)?.label || next}`);
    this.ev.emit('meta');
  }

  async setModel(model) {
    const next = normalizeModel(model);
    if (next === this.model) return;
    this.model = next;
    await this.persist();
    await this.restartForSetting(`model · ${next}`);
    this.ev.emit('meta');
  }

  /** Rename a remembered session: the title shown in the sessions menu. */
  async renameSession(sessionId, title) {
    const s = this.sessions.find(x => x.sessionId === sessionId);
    if (!s) return;
    const clean = String(title || '').trim();
    if (!clean) return;
    s.title = clean;
    await this.persist();
    this.ev.emit('meta');
  }

  /**
   * Model and permission mode are process arguments, so a change only takes effect on a new
   * process. Retire the running one; the next message starts a fresh one that resumes the same
   * conversation.
   */
  async restartForSetting(label) {
    if (!this.procId) return;
    const resume = this.sessionId;
    await this.stop();
    this._resumeNext = resume;
    this.add({ kind: 'note', text: `${label} · applies from the next message` });
  }

  closeOpenTools(state) {
    for (const id of [...this._openTools]) {
      const it = this._byToolId.get(id);
      if (it && it.state === 'running') { it.state = state; this.updateTool(it); }
    }
    this._openTools.clear();
  }

  rememberSession() {
    if (!this.sessionId) return;
    // resuming forks a new session id: keep the name the old one already had
    const parent = this._resumedFrom ? this.sessions.find(s => s.sessionId === this._resumedFrom) : null;
    const title = parent?.title
      || (this.items.find(i => i.kind === 'user')?.text || 'session').replace(/\s+/g, ' ').slice(0, 60);
    const existing = this.sessions.find(s => s.sessionId === this.sessionId);
    if (existing) { existing.at = Date.now(); existing.title = existing.title || title; }
    else this.sessions.unshift({ sessionId: this.sessionId, title, cwd: this.cwd, at: Date.now() });
    this.sessions = this.sessions.slice(0, MAX_SESSIONS);
    this.persist();
    this.ev.emit('meta');
  }

  // ---- protocol --------------------------------------------------------

  handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    try { this.route(ev); } catch (e) { console.error('[claude] event', e, ev); }
  }

  route(ev) {
    const sub = !!ev.parent_tool_use_id;
    switch (ev.type) {
      case 'system': return this.onSystem(ev);
      case 'stream_event': return this.onStream(ev.event || {}, sub, ev);
      case 'assistant': return this.onAssistant(ev, sub);
      case 'user': return this.onUser(ev);
      case 'result': return this.onResult(ev);
      case 'stderr': return this.onStderr(ev);
      case 'exit': return this.onExit(ev);
      case 'control_response': case 'rate_limit_event': return;
      default: return;
    }
  }

  onSystem(ev) {
    if (ev.subtype === 'init') {
      this.sessionId = ev.session_id || this.sessionId;
      this.modelId = ev.model || this.modelId;   // what the CLI actually loaded, not the preference
      if (ev.cwd) this.cwd = ev.cwd;
      if (ev.permissionMode) this.permissionMode = ev.permissionMode;
      this.tools = ev.tools || [];
      if (this.phase === 'starting') this.setPhase('idle');
      this.ev.emit('meta');
    }
    // system/status and system/task_summary are progress noise; the header already says thinking.
  }

  onStream(e, sub, wrap) {
    switch (e.type) {
      case 'message_start': {
        this._msgId = e.message?.id || uid();
        this._byIndex.clear();
        this._pendingThink = [];
        if (this.phase !== 'tool') this.setPhase('thinking');
        return;
      }
      case 'content_block_start': {
        const b = e.content_block || {};
        if (b.type === 'text') {
          this.foldTools();
          const it = this.add({ kind: 'text', text: '', streaming: true, msgId: this._msgId, sub });
          this._byIndex.set(e.index, it);
        } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          // held back: it only becomes an entry once it has text (CONTRACT.md batch 5)
          const it = { key: uid(), kind: 'thinking', text: '', streaming: true, open: false, sub, group: null };
          this._pendingThink.push(it);
          this._byIndex.set(e.index, it);
        } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          const it = this.addTool(b.id, b.name, b.input || {}, sub);
          it.partial = '';
          this._byIndex.set(e.index, it);
        }
        return;
      }
      case 'content_block_delta': {
        const it = this._byIndex.get(e.index);
        if (!it) return;
        const d = e.delta || {};
        if (d.type === 'text_delta' || d.type === 'thinking_delta') {
          it.text += d.text ?? d.thinking ?? '';
          if (it.kind === 'thinking') this.showThinking(it);
          else this.update(it);
        } else if (d.type === 'input_json_delta') {
          it.partial = (it.partial || '') + (d.partial_json || '');
          const parsed = looseJson(it.partial);
          if (parsed) { it.input = parsed; this.updateTool(it); }
        }
        return;
      }
      case 'content_block_stop': {
        const it = this._byIndex.get(e.index);
        if (!it) return;
        if (it.kind === 'thinking') { it.streaming = false; this.showThinking(it); }
        else if (it.kind === 'text') { it.streaming = false; this.update(it); }
        return;
      }
      case 'message_stop': { this._byIndex.clear(); this._pendingThink = []; return; }
      default: return;
    }
  }

  /**
   * Put an entry — a tool call or a non-empty thinking block — into the `working` row of the
   * current turn, creating the row with that entry already inside it (so it is never drawn
   * empty). `entries` holds both kinds, in arrival order.
   */
  pushEntry(it) {
    let g = this._toolGroup;
    if (g) {
      it.group = g;
      g.entries.push(it);
      g.running = true;
      if (!g.userToggled) g.open = true;
      this.update(g);
      return g;
    }
    g = { kind: 'tools', entries: [it], open: true, running: true };
    it.group = g;
    this._toolGroup = this.add(g);
    return g;
  }

  /** A tool row lives inside its group, so redrawing it means redrawing the group. */
  updateTool(it) { this.update(it.group || it); }

  /**
   * Thinking is only ever an entry in the turn's working row, and only when it has text: empty
   * or whitespace-only blocks (redacted thinking among them) produce nothing at all.
   */
  showThinking(it) {
    const has = !!it.text.trim();
    if (!it.group) {
      if (!has) return;                       // still empty: nothing on screen yet, nothing to draw
      this.pushEntry(it);
      return;
    }
    if (!has) {                               // text was replaced by an empty final block
      it.group.entries = it.group.entries.filter(e => e !== it);
      const g = it.group;
      it.group = null;
      this.update(g);
      return;
    }
    this.update(it.group);
  }

  /** Fold the group shut when a turn's text arrives and nothing is still running. */
  foldTools() {
    const g = this._toolGroup;
    if (!g || this._openTools.size) return;
    g.running = false;
    if (!g.userToggled) g.open = false;
    this.update(g);
  }

  addTool(id, name, input, sub) {
    let it = id ? this._byToolId.get(id) : null;
    if (it) { it.input = input && Object.keys(input).length ? input : it.input; this.updateTool(it); return it; }
    it = {
      key: uid(), kind: 'tool', id: id || uid(), toolName: name || 'Tool',
      input: input || {}, state: 'running', result: null, isError: false, sub, group: null,
    };
    this.pushEntry(it);
    this._byToolId.set(it.id, it);
    this._openTools.add(it.id);
    this.setPhase('tool');
    return it;
  }

  onAssistant(ev, sub) {
    const msg = ev.message || {};
    const msgId = msg.id || this._msgId;
    for (const b of msg.content || []) {
      if (b.type === 'text') {
        // finalise the streamed block if we have one, otherwise create it (no partial messages)
        const open = this.items.find(i => i.kind === 'text' && i.msgId === msgId && !i.finalised);
        if (open) { open.text = b.text ?? open.text; open.streaming = false; open.finalised = true; this.update(open); }
        else if ((b.text || '').trim()) { this.foldTools(); this.add({ kind: 'text', text: b.text, streaming: false, finalised: true, msgId, sub }); }
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        // finalise the streamed block if we have one, otherwise create it; either way it is an
        // entry in the working row, and an empty one is not shown at all
        const open = this._pendingThink.find(i => !i.finalised);
        const text = String(b.thinking ?? b.text ?? '');
        if (open) { open.text = text || open.text; open.streaming = false; open.finalised = true; this.showThinking(open); }
        else if (text.trim()) this.showThinking({ key: uid(), kind: 'thinking', text, streaming: false, finalised: true, open: false, sub, group: null });
      } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        const it = this.addTool(b.id, b.name, b.input || {}, sub);
        it.toolName = b.name || it.toolName;
        it.input = b.input || it.input;
        it.partial = null;
        this.updateTool(it);
      }
    }
    this.pushStatusBar();
  }

  onUser(ev) {
    const content = ev.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue;
      const it = this._byToolId.get(b.tool_use_id);
      if (!it) continue;                       // stale or from a session we cleared
      it.result = resultText(b.content);
      it.isError = b.is_error === true;
      it.state = it.isError ? 'error' : 'done';
      this._openTools.delete(it.id);
      this.updateTool(it);
    }
    if (!this._openTools.size && this.phase === 'tool') this.setPhase('thinking');
    this.pushStatusBar();
  }

  onResult(ev) {
    this._sawResult = true;
    this.sessionId = ev.session_id || this.sessionId;
    this.closeOpenTools('done');
    this.endTurn();
    const interrupted = this._interrupted;
    this._interrupted = false;
    const dur = typeof ev.duration_ms === 'number' ? ev.duration_ms : (Date.now() - this.turnStart);
    this.lastDuration = dur;
    this.add({
      kind: 'result',
      ok: ev.is_error !== true && ev.subtype === 'success',
      interrupted,
      subtype: ev.subtype || (ev.is_error ? 'error' : 'success'),
      durationMs: dur,
      turns: ev.num_turns ?? null,
      text: ev.is_error && !interrupted ? (typeof ev.result === 'string' ? ev.result : ev.subtype) : '',
    });
    this.setPhase(ev.is_error === true && !interrupted ? 'error' : 'idle');
    this.rememberSession();
    this.pushStatusBar();
  }

  /** The turn is over: the tools row stops spinning and the next turn opens its own. */
  endTurn() {
    const g = this._toolGroup;
    this._toolGroup = null;
    if (!g) return;
    g.running = false;
    if (!g.userToggled) g.open = false;
    this.update(g);
  }

  onStderr(ev) {
    const text = String(ev.text ?? '').replace(/\r/g, '');
    if (!text.trim()) return;
    for (const line of text.split('\n')) if (line.trim()) this.log.push({ at: Date.now(), text: line });
    if (this.log.length > 400) this.log = this.log.slice(-400);
    this.ev.emit('log');
  }

  onExit(ev) {
    const code = ev.code;
    this.procId = null;
    this.closeOpenTools('error');
    if (code !== 0 || !this._sawResult) {
      this.add({ kind: 'error', text: code === 0 ? 'claude exited before finishing the turn' : `claude exited with code ${code}`, restart: true });
      this.setPhase('error');
    } else {
      this.setPhase('off');
    }
    this.ev.emit('meta');
  }
}

export const session = new Session();
