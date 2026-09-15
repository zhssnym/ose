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
  // Answers an unsubscribe (docs/KERNEL.md), so a module's view goes with the rest of its
  // registrations on unload. Registering the same name twice still replaces, as it always did.
  register(name, def) {
    viewMap.set(name, { name, ...def });
    return () => { if (viewMap.get(name) && viewMap.get(name).mount === def.mount) viewMap.delete(name); };
  },
  get: (name) => viewMap.get(name),
  list: () => [...viewMap.values()],
};

/**
 * Tiles (docs/KERNEL.md `ose.tiles`): a card a module contributes to whichever view asks for
 * tiles; the stock Day view does. `render(el)` is called once when the view mounts and may
 * answer `{ refresh?, unmount? }`; `refresh(id)` calls one tile's refresh, `refresh()` calls
 * every mounted one. The kernel holds the list and the live handles, and nothing else: which
 * view draws them, and where, is the rice's business.
 */
const tileMap = new Map();
const tileLive = new Map();   // id -> the handle render() answered, while it is on screen
export const tiles = {
  register(def) {
    if (!def || !def.id || typeof def.render !== 'function') throw new Error('tiles.register: id and render required');
    tileMap.set(def.id, { order: 100, title: def.id, ...def });
    return () => { tiles.forget(def.id); tileMap.delete(def.id); };
  },
  get: (id) => tileMap.get(id),
  list: () => [...tileMap.values()].sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id))),
  /** The view calls this as it mounts a tile, so `refresh` can reach the handle later. */
  mounted(id, handle) { if (handle) tileLive.set(id, handle); else tileLive.delete(id); },
  forget(id) { const h = tileLive.get(id); tileLive.delete(id); if (h && typeof h.unmount === 'function') { try { h.unmount(); } catch (e) { console.error(`[tile:${id}]`, e); } } },
  refresh(id) {
    const ids = id === undefined ? [...tileLive.keys()] : [id];
    for (const key of ids) {
      const h = tileLive.get(key);
      if (h && typeof h.refresh === 'function') { try { h.refresh(); } catch (e) { console.error(`[tile:${key}]`, e); } }
    }
  },
};

const STATUS_ORDER = ['mode', 'path', 'doc', 'save', 'watch'];
const statusData = new Map();
const statusWatchers = makeEmitter();
export const status = {
  /**
   * `set(field, text)` as it always was, and `set(field, { text, kind, onClick })` for a field
   * that says something is wrong or that can be pressed (docs/KERNEL.md). A field keeps only
   * what it was given; `all()` still answers `{ key, text }` for every reader that wants the
   * string, with `kind` and `onClick` beside it for the ones that draw them.
   */
  set(key, value) {
    const obj = value && typeof value === 'object' ? value : { text: value };
    const text = obj.text == null ? '' : String(obj.text);
    if (!text) statusData.delete(key);
    else statusData.set(key, { text, kind: obj.kind || null, onClick: typeof obj.onClick === 'function' ? obj.onClick : null });
    statusWatchers.emit('change', status.all());
  },
  clear(key) { status.set(key, null); },
  all: () => STATUS_ORDER.filter(k => statusData.has(k)).map(k => ({ key: k, ...statusData.get(k) })),
  watch: (fn) => statusWatchers.on('change', fn),
};

// small shared helpers
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
