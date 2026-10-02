// Shared core: event bus, store, command registry, view registry, status bar fields.
// Everything else in the core imports from here.

function makeEmitter() {
  const map = new Map();
  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(fn);
      return () => map.get(name)?.delete(fn);
    },
    emit(name, payload?) {
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
// Bumped on every register and unregister. `keys.ts` reads it to know when to rebuild its
// index, because a command's `shortcut` is a real binding (docs/CORE.md
// `ose.commands.register`): registering the command arms the chord and the unsubscribe takes
// it back. The counter is how that happens without the registry — the
// one file in the core that imports nothing — importing the key engine.
let cmdRev = 0;
export const commandsRevision = () => cmdRev;
/** Every registered command, `when` guards ignored. `keys.ts` only. */
export const allCommands = () => [...cmdMap.values()];
export const commands = {
  register(cmd) {
    if (!cmd || !cmd.id || typeof cmd.run !== 'function') throw new Error('commands.register: id and run required');
    const entry = { group: 'app', ...cmd };
    cmdMap.set(cmd.id, entry);
    cmdRev += 1;
    // The unsubscribe drops this registration and not whatever replaced it, so re-registering
    // an id and then releasing the old handle does not leave the palette short a command.
    return () => { if (cmdMap.get(cmd.id) === entry) { cmdMap.delete(cmd.id); cmdRev += 1; } };
  },
  list: () => [...cmdMap.values()].filter(c => !c.when || c.when()),
  get: (id) => cmdMap.get(id),
  /**
   * Run a command and answer what its `run` answers (a promise stays a promise, so a caller
   * can await a save). With an explicit target (the row a context menu was opened on) and an
   * `applies(target)` on the command, that decides, not `when()`: `when` reads where the
   * keyboard focus is, and a right-click does not move it (H21, on macOS a click does not
   * either), so the menu's Rename used to do nothing on any row that was not focused.
   * Without `applies`, `when` gets the same arguments, so a guard that can read a target does.
   */
  run(id, ...args) {
    const c = cmdMap.get(id);
    if (!c) { console.warn('unknown command', id); return; }
    const target = args[0];
    if (target !== undefined && target !== null && typeof c.applies === 'function') {
      if (!c.applies(target)) return;
    } else if (c.when && !c.when(...args)) return;
    return c.run(...args);
  },
};

/**
 * A name is one owner's for as long as it is registered: the first registration of a name wins.
 * A second registration of a view called `home` or `day` used to take the home page or the Day
 * view from whoever held it; now it keeps nothing and the console says so. The unsubscribe of
 * the first registration frees the name again.
 */
function taken(map, key, what) {
  if (!map.has(key)) return false;
  console.warn(`[${what}] ${key} is already registered: the second registration keeps nothing`);
  return true;
}

const noop = () => {};

const viewMap = new Map();
export const views = {
  /**
   * `register(name, { title, mount(el, route), unmount?, refresh?, ...extra })`. Every extra
   * field is kept as it was given (`section`, `order`, `icon`, …): the core reads none of
   * them, and whoever draws a list of views does. Answers an unsubscribe.
   */
  register(name, def) {
    if (taken(viewMap, name, 'views')) return noop;
    const entry = { name, ...def };
    viewMap.set(name, entry);
    return () => { if (viewMap.get(name) === entry) viewMap.delete(name); };
  },
  get: (name) => viewMap.get(name),
  list: () => [...viewMap.values()],
};

// `focus` is the core's own (./focus.js): while the app is narrowed to a folder, the bar says so.
const STATUS_ORDER = ['mode', 'focus', 'doc', 'save'];
const statusData = new Map();
const statusWatchers = makeEmitter();
export const status = {
  /**
   * `set(field, text)` as it always was, and `set(field, { text, kind, onClick, title,
   * choices, value, onChoose })` for a field that says something is wrong, that can be
   * pressed, or that offers a choice (docs/CORE.md, §4.5 of the wave-3 contract: the editing
   * mode). A field keeps only what it was given; `all()` still answers `{ key, text }` for every
   * reader that wants the string, with the rest beside it for the ones that draw them.
   * `choices` is `[{ value, label }]`; the shell draws the field as a menu of them, the current
   * `value` checked, and a pick calls `onChoose(value)`.
   */
  set(key: string, value: string | null | undefined | import('./types.ts').StatusField) {
    const obj: import('./types.ts').StatusField = value && typeof value === 'object' ? value : { text: value };
    const text = obj.text == null ? '' : String(obj.text);
    if (!text) { statusData.delete(key); statusWatchers.emit('change', status.all()); return; }
    const entry: import('./types.ts').StatusEntry = { text, kind: obj.kind || null, onClick: typeof obj.onClick === 'function' ? obj.onClick : null };
    if (typeof obj.title === 'string' && obj.title) entry.title = obj.title;
    if (Array.isArray(obj.choices)) {
      entry.choices = obj.choices
        .filter((c) => c && typeof c.value === 'string')
        .map((c) => ({ value: c.value, label: typeof c.label === 'string' && c.label ? c.label : c.value }));
      entry.value = typeof obj.value === 'string' ? obj.value : null;
      entry.onChoose = typeof obj.onChoose === 'function' ? obj.onChoose : null;
    }
    statusData.set(key, entry);
    statusWatchers.emit('change', status.all());
  },
  clear(key) { status.set(key, null); },
  /**
   * The bar's own order first, then every other field in the order it was first set, so a
   * built-in module's `ose.status.set('week', …)` is a field the bar draws, instead of one that
   * is stored and never listed; the shell's four keep their fixed places on the left.
   */
  all: () => [
    ...STATUS_ORDER.filter(k => statusData.has(k)),
    ...[...statusData.keys()].filter(k => !STATUS_ORDER.includes(k)),
  ].map(k => ({ key: k, ...statusData.get(k) })),
  watch: (fn) => statusWatchers.on('change', fn),
};

// small shared helpers
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export { esc } from '../ui/html.ts';
