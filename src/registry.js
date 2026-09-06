// Shared kernel: event bus, store, command registry, view registry, status bar fields.
// Every module imports from here. Additive changes only; see CONTRACT.md.

function makeEmitter() {
  const map = new Map();
  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(fn);
      return () => map.get(name)?.delete(fn);
    },
    emit(name, payload) {
      const set = map.get(name);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (e) { console.error(`[bus:${name}]`, e); }
      }
    },
  };
}

export const bus = makeEmitter();

const storeData = new Map();
const storeWatchers = makeEmitter();
export const store = {
  get: (k) => storeData.get(k),
  set(k, v) {
    if (storeData.get(k) === v) return;
    storeData.set(k, v);
    storeWatchers.emit(k, v);
  },
  watch: (k, fn) => storeWatchers.on(k, fn),
};

const cmdMap = new Map();
export const commands = {
  register(cmd) {
    if (!cmd || !cmd.id || typeof cmd.run !== 'function') throw new Error('commands.register: id and run required');
    cmdMap.set(cmd.id, { group: 'app', ...cmd });
    return () => cmdMap.delete(cmd.id);
  },
  list: () => [...cmdMap.values()].filter(c => !c.when || c.when()),
  get: (id) => cmdMap.get(id),
  run(id, ...args) {
    const c = cmdMap.get(id);
    if (!c) { console.warn('unknown command', id); return; }
    if (c.when && !c.when()) return;
    return c.run(...args);
  },
};

const viewMap = new Map();
export const views = {
  register(name, def) { viewMap.set(name, { name, ...def }); },
  get: (name) => viewMap.get(name),
  list: () => [...viewMap.values()],
};

const STATUS_ORDER = ['mode', 'path', 'doc', 'save', 'watch', 'claude'];
const statusData = new Map();
const statusWatchers = makeEmitter();
export const status = {
  set(key, text) {
    if (text == null || text === '') statusData.delete(key); else statusData.set(key, String(text));
    statusWatchers.emit('change', status.all());
  },
  all: () => STATUS_ORDER.filter(k => statusData.has(k)).map(k => ({ key: k, text: statusData.get(k) })),
  watch: (fn) => statusWatchers.on('change', fn),
};

// small shared helpers
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
