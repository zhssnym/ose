// Part of the sidebar (./sidebar.js). What every part of the sidebar shares: the core's hoses it
// leans on, and its state.

import { ose } from 'ose:core';
import { hasIcon } from 'ose:ui';
import * as pins from './pins.js';

/** What the parts of sidebar.js share and change: each was a `let` of the one file. */
export const state = {
  /** @type {any} */ el: null,
  /** @type {any} */ scrollEl: null,
  /** @type {any} */ headEl: null,
  /** @type {any} */ tree: null,
  /** @type {Set<any>} */ expanded: new Set(),
  // The root row is open unless the person folded it.
  /** @type {boolean} */ rootOpen: true,
  // The one row that is a tab stop (D2). A key, not an element: rows are rebuilt on every render.
  /** @type {any} */ roving: null,
  // Set by a rename, a move or a new file so the next render puts focus on that row (B4).
  /** @type {any} */ focusAfterRender: null,
  // The multi-selection (C17): tree paths, never pins. Empty means the focused row is
  // the only target, as before; two or more and the tree commands act on all of them. `anchor`
  // is the row a Shift-range grows from, set by every plain click or arrow.
  /** @type {Set<any>} */ selected: new Set(),
  /** @type {any} */ anchor: null,
  // Set while the tree itself tells the pins it changed: it draws right after, once.
  /** @type {boolean} */ quietPins: false,
  // Show hidden items as the tree was last read with, so a settings change that flips it reads
  // the tree again and one that does not leaves it be.
  /** @type {any} */ readHidden: null,
};

export const { bus, commands, debounce, files, links, route } = ose;

// The core's hoses this file leans on, named the way the batch-12 shell named them, so the
// code below reads as it always did. Everything here is `ose` and nothing else.
export const navigate = (r, opts) => route.navigate(r, opts);
export const currentRoute = () => route.current();
export const shortcutFor = (id) => ose.keys.shortcutFor(id);
export const getFocus = () => ose.focus.get();
export const setFocus = (path) => ose.focus.set(path);
export const exitFocus = () => ose.focus.exit();
export const isUnderFocus = (path) => ose.focus.isUnder(path);
export const relativeHref = (from, to) => links.href(from, to);
export const rewriteInboundMany = (pairs) => links.rewriteMoved(pairs);
export const findInbound = (path) => links.inbound(path);
/** What a caught error says: its message, or the thing itself when it has none. */
export const messageOf = (e) => (e && typeof e === 'object' && 'message' in e && e.message ? e.message : e);

/** An icon from the set, or `fallback` while the core does not carry that name yet. */
export const ic = (name, fallback) => (hasIcon(name) ? name : fallback);

// Per-machine UI state (`ose.local`, W5): the tree's open folders beside the layout's open
// switch and width. Every folder's sort is shell/folder.js's (`sortSpec`, `setSortSpec`).
// Every write is read-modify-write of the whole slot, so the layout's writes to `sidebar.open`
// and this file's to `sidebar.expanded` never clobber each other. Never the vault's
// `.ose/state.json`: UI state is per machine and never lands in a synced file.
export const slot = (key) => ose.local(key);
/** The pins are told the tree changed (missing or back), without a second draw. */
export function pinsRefresh() { state.quietPins = true; try { pins.refresh(); } finally { state.quietPins = false; } }

export const showHidden = () => !!(ose.settings.get() || {}).showHidden;
