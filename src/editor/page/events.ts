// Part of the markdown page (../page.ts). The instance's own events, and the status bar it owns
// while it is the active page.
//
// One page instance is one `ctx` (./ctx.ts): its state, and the functions of every part. This part
// adds its own with `installEvents(ctx)`, and reaches the rest through `ctx`.

import { status } from '../host.ts';
import { activeInstance } from '../instances.ts';
import type { PageCtx } from './ctx.ts';

export function installEvents(ctx: PageCtx) {

  const isActive = () => activeInstance() === ctx.inst;
  /** The shell's status bar belongs to one page at a time: the focused one (K1c). */
  const setStatus = (field, value) => { if (isActive()) status.set(field, value); };

  function emit(event, payload) {
    const set = ctx.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error(`[editor:${event}]`, e); }
    }
  }

  function on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!ctx.listeners.has(event)) ctx.listeners.set(event, new Set());
    ctx.listeners.get(event).add(fn);
    return () => { ctx.listeners.get(event)?.delete(fn); };
  }

  return {
    isActive,
    setStatus,
    emit,
    on,
  };
}
