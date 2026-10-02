// The one window hose left: a vault another launch asked this window to switch to. Moving and
// resizing the window are the platform's and the title bar's (titlebar.js): nothing here
// draws or drives them.
//
// One file knows; everybody else calls it.

import { ose } from 'ose:core';

/**
 * A second launch named another folder (docs/HOST.md "Identity: vaults, roots, epochs, tabs"). The host does not
 * adopt it on its own: it asks, with `{root, name}`, and the shell switches the way Change
 * vault does, after the open page has been saved (C5). Kept until windows per vault (X6, gate
 * G3) take over, when a second launch opens a window of its own and the host stops asking; a
 * core that has dropped the hose by then answers a no-op unsubscribe here.
 */
export function onVaultChangeRequested(fn) {
  const v = ose.vault;
  if (!v || typeof v.onChangeRequested !== 'function') return () => {};
  return v.onChangeRequested((d) => { if (d && d.root) fn(d); });
}
