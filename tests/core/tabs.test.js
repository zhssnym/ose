// @vitest-environment happy-dom
//
// Tabs with a history each (CONTRACT §4.3, M23, M24): the core owns the strip and one column
// shows the active tab's current entry. What is checked here is what keeps typed text alive:
// a page left for another tab is parked (kept alive, never asked), a page left for good is
// asked and closed, a background tab's page is released before its tab goes and a release
// that fails keeps the tab; plus per-tab back and forward, reopening a closed tab with its
// whole history, the last tab falling back to Home, and a trashed file's tab going Home.
//
// Every test gets a fresh core (the router and the tab model keep module state).
//
// Depends on: core (src/core/router.ts, tabs.js, pagehost.js, session.js).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/bridge/index.ts', () => import('./fake-bridge.js'));

let R;       // src/core/router.ts
let T;       // src/core/tabs.ts
let K;       // src/core/registry.ts
let host;    // the fake page host
let main;    // the column

/** A page host that writes down every call; `release` answers `host.releases`. */
function makeHost() {
  const h = {
    log: [],
    leave: true,
    releases: true,
    async open(el, path) {
      h.log.push(['open', path]);
      const d = document.createElement('div');
      d.className = 'page';
      d.textContent = `page ${path}`;
      el.appendChild(d);
    },
    async canLeave(reason) { h.log.push(['canLeave', reason]); return h.leave; },
    stay() { h.log.push(['stay']); },
    async close(opts) { h.log.push(['close', opts && opts.park ? 'park' : 'close']); return true; },
    async release(path) { h.log.push(['release', path]); return h.releases; },
    scrollToLine() { return true; },
    selection() { return null; },
  };
  return h;
}

beforeEach(async () => {
  vi.resetModules();
  const fake = await import('./fake-bridge.js');
  fake.reset({ 'a.md': '# a\n', 'b.md': '# b\n', 'c.md': '# c\n', 'notes/n.md': '# n\n' });
  K = await import('../../src/core/registry.ts');
  R = await import('../../src/core/router.ts');
  T = await import('../../src/core/tabs.ts');
  const P = await import('../../src/core/pagehost.ts');
  document.body.innerHTML = '';
  main = document.createElement('main');
  document.body.appendChild(main);
  R.initRouter(main, { start: false });
  host = makeHost();
  P.setPageHost(host);
});

const page = (path) => ({ type: 'page', path });
const here = () => (R.currentRoute() ? R.currentRoute().path : null);
const keys = () => T.list().map((t) => (t.route ? `${t.route.type}:${t.route.path ?? t.route.name}` : null));
/** The host calls since the mark, without the opens. */
const since = (mark) => host.log.slice(mark).filter(([c]) => c !== 'open');

describe('tabs', () => {
  it('each tab has its own back and forward', async () => {
    await R.navigate(page('a.md'));
    await R.navigate(page('b.md'));
    const first = T.active().id;
    const { id: second } = await T.open(page('c.md'));
    await R.navigate(page('notes/n.md'));
    expect(keys()).toEqual(['page:b.md', 'page:notes/n.md']);

    expect(await R.back()).toBe(true);
    expect(here()).toBe('c.md');
    expect(R.canForward()).toBe(true);

    await T.activate(first);
    expect(here()).toBe('b.md');
    expect(R.canBack()).toBe(true);
    expect(R.canForward()).toBe(false);
    await R.back();
    expect(here()).toBe('a.md');

    await T.activate(second);
    expect(here()).toBe('c.md');
    expect(T.active()).toMatchObject({ id: second, canBack: false, canForward: true });
  });

  it('switching tabs parks the page: it is never asked, and nothing is released', async () => {
    await R.navigate(page('a.md'));
    const first = T.active().id;
    let mark = host.log.length;
    await T.open(page('b.md'));
    expect(since(mark)).toEqual([['close', 'park']]);
    mark = host.log.length;
    await T.activate(first);
    expect(since(mark)).toEqual([['close', 'park']]);
    expect(here()).toBe('a.md');
  });

  it('leaving a page inside its tab asks it, unless another tab still shows that file', async () => {
    await R.navigate(page('a.md'));
    let mark = host.log.length;
    await R.navigate(page('b.md'));
    expect(since(mark)).toEqual([['canLeave', 'navigate'], ['close', 'close']]);

    // b.md in a second tab too: navigating away from it there only parks it.
    await T.open(page('b.md'), { reuse: false });
    expect(T.list()).toHaveLength(2);
    mark = host.log.length;
    await R.navigate(page('c.md'));
    expect(since(mark)).toEqual([['close', 'park']]);
  });

  it('a page that refuses to be left keeps its tab and its history', async () => {
    await R.navigate(page('a.md'));
    host.leave = false;
    expect(await R.navigate(page('b.md'))).toBe(false);
    expect(here()).toBe('a.md');
    expect(R.canBack()).toBe(false);
    expect(keys()).toEqual(['page:a.md']);
    expect(await R.clearRoute()).toBe(false);
    expect(keys()).toEqual(['page:a.md']);
  });

  it('closing a background tab releases its page; a failed release keeps the tab', async () => {
    await R.navigate(page('a.md'));
    const { id: bg } = await T.open(page('b.md'), { activate: false });
    host.releases = false;
    expect(await T.close(bg)).toBe(false);
    expect(keys()).toEqual(['page:a.md', 'page:b.md']);
    expect(host.log.at(-1)).toEqual(['release', 'b.md']);
    host.releases = true;
    expect(await T.close(bg)).toBe(true);
    expect(keys()).toEqual(['page:a.md']);
    expect(here()).toBe('a.md');
  });

  it('a background tab on a file another tab shows is closed without a release', async () => {
    await R.navigate(page('a.md'));
    const { id: bg } = await T.open(page('a.md'), { activate: false, reuse: false });
    const mark = host.log.length;
    expect(await T.close(bg)).toBe(true);
    expect(since(mark)).toEqual([]);
  });

  it('open reuses a tab already on that route, unless told not to', async () => {
    await R.navigate(page('a.md'));
    const first = T.active().id;
    await T.open(page('b.md'));
    const r = await T.open(page('a.md'));
    expect(r.id).toBe(first);
    expect(T.list()).toHaveLength(2);
    await R.navigate(page('c.md'), { tab: 'new' });
    expect(T.list()).toHaveLength(3);
    expect(here()).toBe('c.md');
  });

  it('a reopened tab comes back with its whole history, where it was', async () => {
    await R.navigate(page('a.md'));
    await T.open(page('b.md'));
    await R.navigate(page('c.md'));
    const id = T.active().id;
    await T.close(id);
    expect(keys()).toEqual(['page:a.md']);
    expect(await T.reopenClosed()).toBe(true);
    expect(keys()).toEqual(['page:a.md', 'page:c.md']);
    expect(here()).toBe('c.md');
    await R.back();
    expect(here()).toBe('b.md');
  });

  it('closing the last tab goes Home, so the strip is never empty', async () => {
    K.views.register('home', { title: 'Home', mount(el) { el.textContent = 'home'; } });
    R.setHome({ type: 'view', name: 'home' });
    await R.navigate(page('a.md'));
    expect(await R.clearRoute()).toBe(true);
    expect(T.list()).toHaveLength(1);
    expect(R.currentRoute()).toMatchObject({ type: 'view', name: 'home' });
  });

  it('moving a tab changes the strip order and mounts nothing', async () => {
    await R.navigate(page('a.md'));
    await T.open(page('b.md'));
    const mark = host.log.length;
    T.move(T.active().id, 0);
    expect(keys()).toEqual(['page:b.md', 'page:a.md']);
    expect(host.log.length).toBe(mark);
  });

  it('a trashed file\'s tab goes Home; history is left alone', async () => {
    R.setHome({ type: 'view', name: 'home' });
    await R.navigate(page('a.md'));
    await R.navigate(page('notes/n.md'));
    K.bus.emit('paths:trashed', { paths: ['notes/n.md'], items: [] });
    await vi.waitFor(() => expect(R.currentRoute()).toMatchObject({ type: 'view', name: 'home' }));
    expect(R.canBack()).toBe(true);
  });

  it('tells the bus and the subscribers with a snapshot', async () => {
    const seen = [];
    const off = T.on((d) => seen.push(d));
    await R.navigate(page('a.md'));
    await T.open(page('b.md'));
    off();
    const last = seen.at(-1);
    expect(last.tabs.map((t) => t.route.path)).toEqual(['a.md', 'b.md']);
    expect(last.active).toBe(T.active().id);
    expect(typeof last.reason).toBe('string');
  });
});

describe('session', () => {
  it('a snapshot restores the same tabs, their histories and the active one, mounting one page', async () => {
    const S = await import('../../src/core/session.ts');
    await R.navigate(page('a.md'));
    await R.navigate(page('b.md'));
    await T.open(page('c.md'));
    await T.open({ type: 'folder', path: 'notes' });
    await T.activate(T.list()[1].id);
    const snap = S.snapshot();
    expect(snap).toMatchObject({ v: 1, active: 1 });
    expect(snap.tabs.map((t) => t.stack.length)).toEqual([2, 1, 1]);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);

    // A fresh core, as after a restart.
    vi.resetModules();
    const fake = await import('./fake-bridge.js');
    fake.reset({ 'a.md': '# a\n', 'b.md': '# b\n', 'c.md': '# c\n', 'notes/n.md': '# n\n' });
    R = await import('../../src/core/router.ts');
    T = await import('../../src/core/tabs.ts');
    const P = await import('../../src/core/pagehost.ts');
    const S2 = await import('../../src/core/session.ts');
    main.innerHTML = '';
    R.initRouter(main, { start: false });
    host = makeHost();
    P.setPageHost(host);

    expect(await S2.restore(snap)).toBe(true);
    expect(keys()).toEqual(['page:b.md', 'page:c.md', 'folder:notes']);
    expect(here()).toBe('c.md');
    expect(host.log.filter(([c]) => c === 'open')).toEqual([['open', 'c.md']]);
    await T.activate(T.list()[0].id);
    expect(R.canBack()).toBe(true);
    await R.back();
    expect(here()).toBe('a.md');
  });

  it('nothing usable restores nothing', async () => {
    const S = await import('../../src/core/session.ts');
    expect(await S.restore({ v: 1, at: 0, active: 0, tabs: [] })).toBe(false);
    expect(await S.restore({ v: 99 })).toBe(false);
  });
});
