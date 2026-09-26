// `ose:md` for the headless tests (vitest.config.js). Nothing under src/editor imports it
// today; the alias exists so a module that starts to does not reach for the real kernel.
export {};
