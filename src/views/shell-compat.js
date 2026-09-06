// Thin, defensive wrappers around the parts of the shell the views need.
// `shell/state.js` may not be loaded yet, so it is imported dynamically and every call falls
// back to localStorage. Nothing here throws.

import { status } from '../registry.js';

// The shell is loaded dynamically so a half-written shell module cannot take the views down;
// in the app it is already in memory by the time a view can be clicked.
let shellMod;
async function shell() {
  if (shellMod !== undefined) return shellMod;
  try {
    const m = await import('../shell/index.js');
    shellMod = (m && typeof m.navigate === 'function') ? m : null;
  } catch (e) { console.warn('[views] shell/index.js unavailable', e); shellMod = null; }
  return shellMod;
}

export function navigate(route) {
  shell().then((m) => { try { m?.navigate(route); } catch (e) { console.warn('[views] navigate failed', e); } });
}

/**
 * A transient message in the status bar. Views only ever hold the 'doc' slot, and only while a
 * view is on screen (the editor owns it when a page is), and they always give it back.
 */
let flashTimer = null;
export function flash(text) {
  status.set('doc', text);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => status.set('doc', null), 6000);
}

const LS = 'os.views.state';
const lsRead = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
const lsWrite = (o) => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch { /* private mode */ } };

let stateMod;                 // shell/state.js once resolved, or null when absent
async function shellState() {
  if (stateMod !== undefined) return stateMod;
  try {
    const m = await import('../shell/state.js');
    stateMod = (m && typeof m.patchState === 'function') ? m : null;
  } catch { stateMod = null; }
  return stateMod;
}

let cache = null;             // last known { views: {...} } for this session
async function read() {
  if (cache) return cache;
  const m = await shellState();
  if (m && typeof m.stateCache === 'function') {
    const s = m.stateCache();
    if (s && typeof s === 'object') {
      // App/state.json wins; the localStorage mirror only seeds a state file that has no views yet
      if (!s.views) { const mirror = lsRead(); if (Object.keys(mirror).length) s.views = mirror; }
      cache = s;
      return cache;
    }
  }
  cache = { views: lsRead() };
  return cache;
}

/** Persisted preferences for one view, e.g. `getViewState('week')` -> { q: 'Q2' }. */
export async function getViewState(name) {
  const s = await read();
  return { ...((s.views || {})[name] || {}) };
}

/** Shallow-merge a patch into `views.<name>`, keeping every other module's keys. */
export async function setViewState(name, patch) {
  const s = await read();
  const views = { ...(s.views || {}) };
  views[name] = { ...(views[name] || {}), ...patch };
  s.views = views;
  cache = s;
  lsWrite(views); // mirror, so a preference survives even before the shell's state file loads
  const m = await shellState();
  if (m) { try { await m.patchState({ views }); } catch (e) { console.warn('[views] patchState failed', e); } }
}
