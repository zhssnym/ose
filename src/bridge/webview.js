// WebView2 adapter: postMessage RPC to the .NET host. See CONTRACT.md "Host protocol".
export async function create() {
  const wv = window.chrome.webview;
  const pending = new Map();
  const subs = new Set();
  let seq = 0;
  wv.addEventListener('message', (e) => {
    let msg = e.data;
    // Host normally uses postWebMessageAsJson; tolerate postWebMessageAsString too.
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch { return; } }
    if (!msg || typeof msg !== 'object') return;
    if (msg.event) {
      for (const fn of [...subs]) { try { fn(msg); } catch (err) { console.error('[bridge] subscriber threw', err); } }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'host error'));
  });
  return {
    call(cmd, args) {
      const id = ++seq;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); wv.postMessage({ id, cmd, args }); });
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    // The retired .NET host has no `winSetTitle`; the document title is the whole of it here
    // (S13), and this adapter is reference only anyway.
    win: {
      setTitle: (text) => { try { document.title = String(text ?? ''); } catch { /* none */ } },
    },
  };
}
