// @vitest-environment happy-dom
//
// The router's veto and rollback (CONTRACT 4.3, C1) and re-pointing (4.4), with a fake page
// host. A page that says it cannot be left keeps the column, the history, the store and the
// title exactly as they were, and nothing is announced; a `close()` that says no after
// `canLeave` said yes is handed `stay()`. A move re-points every route without a remount.
//
// Every test gets a fresh router (the module keeps its history in module state).
//
// Depends on: core (src/core/router.js).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/bridge/index.js', () => import('./fake-bridge.js'));

let R;       // src/core/router.js
let K;       // src/core/registry.js
let fake;    // the fake bridge
let host;    // the fake page host
let main;    // the column
let events;  // bus events, in order

/** A page host whose answers the test sets: `host.leave` for canLeave, `host.closes` for close. */
function makeHost() {
  const h = {
    leave: true,
    closes: true,
    opened: [],
    asked: 0,
    stays: 0,
    closed: 0,
    scrolled: [],
    async open(el, path, opts) {
      h.opened.push({ path, opts });
      const d = document.createElement('div');
      d.className = 'page';
      d.textContent = `page ${path}`;
      el.appendChild(d);
    },
    async canLeave(reason) {
      h.asked++;
      h.reasons = [...(h.reasons || []), reason];
      const v = typeof h.leave === 'function' ? h.leave() : h.leave;
      if (v instanceof Error) throw v;
      return v;
    },
    stay() { h.stays++; },
    async close() { h.closed++; return h.closes; },
    scrollToLine(line, col) { h.scrolled.push({ line, col }); return true; },
    selection() { return null; },
  };
  return h;
}

beforeEach(async () => {
  vi.resetModules();
  fake = await import('./fake-bridge.js');
  fake.reset({ 'a.md': '# a\n', 'b.md': '# b\n', 'c.md': '# c\n', 'notes/n.md': '# n\n', 'notes/sub/m.md': '# m\n' });
  K = await import('../../src/core/registry.js');
  R = await import('../../src/core/router.js');
  const P = await import('../../src/core/pagehost.js');
  document.body.innerHTML = '';
  main = document.createElement('main');
  document.body.appendChild(main);
  R.initRouter(main, { start: false });
  host = makeHost();
  P.setPageHost(host);
  events = [];
  for (const ev of ['route', 'route:refused', 'route:repointed']) K.bus.on(ev, (d) => events.push([ev, d]));
});

const page = (path, extra = {}) => ({ type: 'page', path, ...extra });
const here = () => R.currentRoute() && R.currentRoute().path;

/** Everything a refused navigation must leave alone. */
function snapshot() {
  return {
    route: here(),
    html: main.innerHTML,
    store: K.store.get('route') && K.store.get('route').path,
    back: R.canBack(),
    forward: R.canForward(),
    reopen: R.canReopenClosed(),
  };
}

describe('navigate', () => {
  it('opens a page and answers true', async () => {
    expect(await R.navigate(page('a.md'))).toBe(true);
    expect(here()).toBe('a.md');
    expect(host.opened.map((o) => o.path)).toEqual(['a.md']);
    expect(events.filter(([e]) => e === 'route')).toHaveLength(1);
  });

  it('a page that cannot be left: false, and nothing changes', async () => {
    await R.navigate(page('a.md'));
    events.length = 0;
    const before = snapshot();
    host.leave = false;
    expect(await R.navigate(page('b.md'))).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(host.closed).toBe(0);
    expect(host.opened.map((o) => o.path)).toEqual(['a.md']);
    expect(events.map(([e]) => e)).toEqual(['route:refused']);
    expect(events[0][1].from.path).toBe('a.md');
    expect(events[0][1].to.path).toBe('b.md');
    expect(host.reasons).toEqual(['navigate']);
  });

  it('the history is exactly what it was: a refused navigation leaves no entry behind', async () => {
    await R.navigate(page('a.md'));
    host.leave = false;
    await R.navigate(page('b.md'));
    host.leave = true;
    expect(R.canBack()).toBe(false);
    expect(await R.navigate(page('c.md'))).toBe(true);
    expect(await R.back()).toBe(true);
    expect(here()).toBe('a.md');
  });

  it('a canLeave that throws is a no', async () => {
    await R.navigate(page('a.md'));
    host.leave = new Error('save threw');
    expect(await R.navigate(page('b.md'))).toBe(false);
    expect(here()).toBe('a.md');
  });

  it('close() answering false after canLeave said yes: stay(), and nothing changes', async () => {
    await R.navigate(page('a.md'));
    const before = snapshot();
    host.closes = false;
    expect(await R.navigate(page('b.md'))).toBe(false);
    expect(host.stays).toBe(1);
    expect(snapshot()).toEqual(before);
  });

  it('the open page with a line is a jump, not a leave', async () => {
    await R.navigate(page('a.md'));
    host.leave = false;
    expect(await R.navigate(page('a.md', { line: 3 }))).toBe(true);
    expect(host.asked).toBe(0);
    expect(host.scrolled).toEqual([{ line: 3, col: undefined }]);
  });

  it('a navigation overtaken by a newer one does nothing; the newer one decides', async () => {
    await R.navigate(page('a.md'));
    let release;
    host.leave = () => new Promise((r) => { release = r; });
    const first = R.navigate(page('b.md'));
    await Promise.resolve();
    host.leave = true;
    const second = R.navigate(page('c.md'));
    release(true);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(here()).toBe('c.md');
    expect(host.opened.map((o) => o.path)).toEqual(['a.md', 'c.md']);
  });
});

describe('back and forward', () => {
  beforeEach(async () => {
    await R.navigate(page('a.md'));
    await R.navigate(page('b.md'));
  });

  it('back refused: false, still on the page, history intact', async () => {
    host.leave = false;
    const before = snapshot();
    expect(await R.back()).toBe(false);
    expect(snapshot()).toEqual(before);
    host.leave = true;
    expect(await R.back()).toBe(true);
    expect(here()).toBe('a.md');
    expect(await R.forward()).toBe(true);
    expect(here()).toBe('b.md');
  });

  it('forward refused: false, and the index is rolled back', async () => {
    await R.back();
    host.leave = false;
    const before = snapshot();
    expect(await R.forward()).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(R.canForward()).toBe(true);
    host.leave = true;
    expect(await R.forward()).toBe(true);
    expect(here()).toBe('b.md');
  });

  it('nothing behind: false without asking', async () => {
    await R.back();
    expect(await R.back()).toBe(false);
  });
});

describe('close (clearRoute)', () => {
  it('refused: the page stays and nothing is offered for reopening', async () => {
    await R.navigate(page('a.md'));
    host.leave = false;
    const before = snapshot();
    expect(await R.clearRoute()).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(R.canReopenClosed()).toBe(false);
  });

  it('allowed: the column is empty and the page can be reopened', async () => {
    await R.navigate(page('a.md'));
    expect(await R.clearRoute()).toBe(true);
    expect(R.currentRoute()).toBe(null);
    expect(R.canReopenClosed()).toBe(true);
    expect(await R.reopenClosed()).toBe(true);
    expect(here()).toBe('a.md');
  });
});

describe('repoint', () => {
  it('the page on screen follows its file: no remount, no route event', async () => {
    await R.navigate(page('notes/sub/m.md'));
    events.length = 0;
    R.repoint([{ from: 'notes', to: 'papers' }]);
    expect(here()).toBe('papers/sub/m.md');
    expect(K.store.get('route').path).toBe('papers/sub/m.md');
    expect(host.opened).toHaveLength(1);
    expect(host.closed).toBe(0);
    expect(events.map(([e]) => e)).toEqual(['route:repointed']);
    expect(events[0][1].moves).toEqual([{ from: 'notes', to: 'papers' }]);
    expect(events[0][1].current.path).toBe('papers/sub/m.md');
  });

  it('history, closed pages and recent files follow too', async () => {
    await R.navigate(page('notes/n.md'));
    await R.navigate(page('a.md'));
    R.repoint([{ from: 'notes/n.md', to: 'notes/renamed.md' }]);
    expect(R.recentFiles()).toContain('notes/renamed.md');
    expect(R.recentFiles()).not.toContain('notes/n.md');
    fake.reset({ 'a.md': '', 'notes/renamed.md': '' });
    expect(await R.back()).toBe(true);
    expect(here()).toBe('notes/renamed.md');
    expect(await R.clearRoute()).toBe(true);
    R.repoint([{ from: 'notes', to: 'x' }]);
    fake.reset({ 'x/renamed.md': '' });
    expect(await R.reopenClosed()).toBe(true);
    expect(here()).toBe('x/renamed.md');
  });

  it('a path that only starts like the folder is left alone', async () => {
    await R.navigate(page('notes-old.md'));
    R.repoint([{ from: 'notes', to: 'papers' }]);
    expect(here()).toBe('notes-old.md');
  });
});
