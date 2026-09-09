// Dev adapter: talks to dev/bridge-plugin.mjs over fetch, events over SSE.
// The SSE stream survives Vite restarts: EventSource reconnects on its own, and if the browser
// gives up (readyState CLOSED) we rebuild it with a capped backoff. Subscribers are never dropped.

const BASE = '/__bridge/';

// `?novault=1` on the page URL makes the dev bridge answer `rootInfo` with no root, so the
// choose-vault surface can be exercised in a browser (dev/bridge-plugin.mjs). The flag rides
// along on every call; the plugin only reads it where it matters.
const FLAGS = (() => {
  try { return new URLSearchParams(location.search).get('novault') ? '?novault=1' : ''; } catch { return ''; }
})();

export async function create() {
  const subs = new Set();
  let es = null;
  let timer = null;
  let backoff = 500;
  let closed = false;
  let wasOpen = false;

  // Same shape as the Tauri adapter's fanout: subscriber results come back as a flat list.
  // Nothing here awaits them (a browser tab has no `closing` notice), but the contract is one.
  const fanout = (msg) => {
    const out = [];
    for (const fn of [...subs]) {
      try {
        const r = fn(msg);
        if (Array.isArray(r)) out.push(...r); else if (r !== undefined) out.push(r);
      } catch (e) { console.error('[bridge] subscriber threw', e); }
    }
    return out;
  };

  const schedule = () => {
    if (closed || timer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, 10000);
    timer = setTimeout(() => { timer = null; connect(); }, wait);
  };

  const connect = () => {
    if (closed) return;
    try { es?.close(); } catch { }
    es = null;
    let source;
    try {
      source = new EventSource(BASE + 'events');
    } catch (e) {
      console.warn('[bridge] EventSource unavailable:', e?.message || e);
      schedule();
      return;
    }
    es = source;
    source.onopen = () => {
      backoff = 500;
      if (wasOpen) console.info('[bridge] event stream reconnected');
      wasOpen = true;
    };
    source.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch (e) { console.error('[bridge] bad event frame', m.data); return; }
      if (!msg || typeof msg !== 'object' || !msg.event) return;
      if (msg.event === 'bridge') return; // transport-level hello, not an app event
      fanout(msg);
    };
    source.onerror = () => {
      // EventSource retries CONNECTING itself; only step in once it has actually given up.
      if (source.readyState === EventSource.CLOSED) {
        console.warn('[bridge] event stream closed, reconnecting');
        try { source.close(); } catch { }
        if (es === source) es = null;
        schedule();
      }
    };
  };

  connect();

  if (typeof window !== 'undefined') {
    // A tab restored from bfcache or woken from sleep can hold a dead stream; nudge it.
    window.addEventListener('online', () => { if (!es || es.readyState === EventSource.CLOSED) { backoff = 500; connect(); } });
    window.addEventListener('pagehide', () => { /* keep subs, let the browser tear the socket down */ });
  }

  return {
    async call(cmd, args) {
      let r;
      try {
        r = await fetch(BASE + cmd + FLAGS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ args: args || [] }),
        });
      } catch (e) {
        throw new Error(`bridge unreachable (${cmd}): ${e?.message || e}. Is the vite dev server running?`);
      }
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch {
        throw new Error(`bridge returned non-JSON for ${cmd} (HTTP ${r.status}): ${text.slice(0, 200)}`);
      }
      if (!j || j.ok !== true) throw new Error(j?.error || `bridge error (${cmd}, HTTP ${r.status})`);
      return j.result;
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    close() { closed = true; clearTimeout(timer); timer = null; try { es?.close(); } catch { } es = null; },
  };
}
