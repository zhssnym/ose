// @vitest-environment happy-dom
//
// The leave gate (CONTRACT 4.1, C5) and the toasts it speaks through (4.6, H8). Everything that
// throws the window away asks `leaveWindow` first; one `false` or one rejection keeps the
// window, says so in a sticky error toast with [Show] (and [Close anyway] on close), and emits
// `window:refused`. A leave in flight is shared by every caller.
//
// Every test gets fresh core modules (the gate keeps its handlers in module state).
//
// Depends on: core (src/core/leave.js, dialog.js toast).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/bridge/index.js', () => import('./fake-bridge.js'));

let L;       // src/core/leave.js
let K;       // src/core/registry.js
let D;       // src/core/dialog.js
let events;
let ran;

beforeEach(async () => {
  vi.resetModules();
  const fake = await import('./fake-bridge.js');
  fake.reset();
  K = await import('../../src/core/registry.js');
  L = await import('../../src/core/leave.js');
  D = await import('../../src/core/dialog.js');
  document.body.innerHTML = '';
  events = [];
  for (const ev of ['window:refused', 'window:leaving', 'window:stay']) K.bus.on(ev, (d) => events.push([ev, d]));
  ran = [];
  for (const id of ['page.show-problem', 'app.close-anyway']) {
    K.commands.register({ id, title: id, run: () => { ran.push(id); } });
  }
});
afterEach(() => { vi.useRealTimers(); });

const toasts = () => [...document.querySelectorAll('.toast')];
const buttons = (t) => [...t.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);

describe('leaveWindow', () => {
  it('no handler: the window may go', async () => {
    expect(await L.leaveWindow('reload')).toBe(true);
    expect(events).toEqual([['window:leaving', { reason: 'reload' }]]);
  });

  it('every handler is asked, with the reason, and awaited', async () => {
    const seen = [];
    L.onLeave(async ({ reason }) => { await new Promise((r) => setTimeout(r, 20)); seen.push(['slow', reason]); return true; });
    L.onLeave(({ reason }) => { seen.push(['fast', reason]); return true; });
    expect(await L.leaveWindow('vault-change')).toBe(true);
    expect(seen).toEqual([['fast', 'vault-change'], ['slow', 'vault-change']]);
  });

  it('one false keeps the window, and says so with Show', async () => {
    L.onLeave(() => true);
    L.onLeave(async () => false);
    expect(await L.leaveWindow('reload')).toBe(false);
    expect(events.map(([e]) => e)).toEqual(['window:stay', 'window:refused']);
    expect(events[1][1]).toEqual({ reason: 'reload' });
    const [t] = toasts();
    expect(t.textContent).toContain('Not reloaded: a page could not be saved.');
    expect(t.getAttribute('role')).toBe('alert');
    expect(buttons(t)).toContain('Show');
    expect(buttons(t)).not.toContain('Close anyway');
    [...t.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show').click();
    await Promise.resolve();
    expect(ran).toEqual(['page.show-problem']);
  });

  it('a rejection is a no', async () => {
    L.onLeave(() => Promise.reject(new Error('save failed')));
    expect(await L.leaveWindow('vault-change')).toBe(false);
    expect(toasts()[0].textContent).toContain('Not switched');
  });

  it('a handler that throws is a no', async () => {
    L.onLeave(() => { throw new Error('boom'); });
    expect(await L.leaveWindow('reload')).toBe(false);
  });

  it('on close the refusal offers Close anyway', async () => {
    L.onLeave(() => false);
    expect(await L.leaveWindow('close')).toBe(false);
    const [t] = toasts();
    expect(t.textContent).toContain('Not closed');
    expect(buttons(t)).toEqual(expect.arrayContaining(['Show', 'Close anyway']));
    [...t.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close anyway').click();
    await Promise.resolve();
    expect(ran).toEqual(['app.close-anyway']);
  });

  it('a second call while one is in flight answers the same promise', async () => {
    let release;
    let asked = 0;
    L.onLeave(() => { asked++; return new Promise((r) => { release = r; }); });
    const a = L.leaveWindow('reload');
    const b = L.leaveWindow('reload');
    expect(b).toBe(a);
    release(true);
    expect(await a).toBe(true);
    expect(asked).toBe(1);
  });

  it('an unsubscribed handler is not asked', async () => {
    const off = L.onLeave(() => false);
    off();
    expect(await L.leaveWindow('reload')).toBe(true);
  });

  it('a slow save gets a sticky "still saving" notice after 3 s, gone when it settles', async () => {
    vi.useFakeTimers();
    let release;
    L.onLeave(() => new Promise((r) => { release = r; }));
    const p = L.leaveWindow('close');
    await vi.advanceTimersByTimeAsync(2900);
    expect(document.body.textContent).not.toContain('Still saving');
    await vi.advanceTimersByTimeAsync(200);
    expect(document.body.textContent).toContain('Still saving');
    release(true);
    expect(await p).toBe(true);
    expect(document.body.textContent).not.toContain('Still saving');
  });

  it('stayWindow says so on the bus', () => {
    L.stayWindow();
    expect(events).toEqual([['window:stay', undefined]]);
  });
});

describe('toast', () => {
  it('sticky (ms 0): no timer, a close button, the kill function removes it', async () => {
    vi.useFakeTimers();
    const kill = D.toast('Not saved', 'err', 0);
    await vi.advanceTimersByTimeAsync(60_000);
    const [t] = toasts();
    expect(t).toBeTruthy();
    expect(t.getAttribute('role')).toBe('alert');
    expect(t.querySelector('button[aria-label="Dismiss"]')).toBeTruthy();
    t.click();
    expect(toasts()).toHaveLength(1);
    kill();
    expect(toasts()).toHaveLength(0);
  });

  it('actions are buttons that run and close it', async () => {
    const hits = [];
    D.toast('Could not move', 'err', 0, { actions: [{ label: 'Retry', run: () => hits.push('retry') }] });
    const b = toasts()[0].querySelector('button.toast-act');
    expect(b.textContent).toBe('Retry');
    b.click();
    await Promise.resolve();
    expect(hits).toEqual(['retry']);
    expect(toasts()).toHaveLength(0);
  });

  it('a timed info toast goes by itself and is not an alert', async () => {
    vi.useFakeTimers();
    D.toast('saved', 'info', 1000);
    expect(toasts()[0].getAttribute('role')).not.toBe('alert');
    await vi.advanceTimersByTimeAsync(1500);
    expect(toasts()).toHaveLength(0);
  });
});
