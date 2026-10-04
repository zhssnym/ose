// The core (src/core/core.ts) for the headless tests (vitest.config.js).
//
// The editor sources read `ose` at module top level (host.js: `ose.bus`, `ose.ready`, …) and
// only call into it from a view, a command or a save, none of which a serialiser test reaches.
// So `ose` is an object any property of which is another such object, callable, answering
// another one: every reading succeeds and nothing happens. `then` is the one hole, so an `ose`
// value is never mistaken for a promise. A test that needs a real core imports its modules
// from src/core directly.

const deep = () => new Proxy(function stub() {}, {
  get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()),
  apply: () => deep(),
});

export const ose = deep();
// The two pickers' names the editor's host imports beside `ose`.
export const pageItems = () => [];
export const pickPage = async () => null;
export default ose;
