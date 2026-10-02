// Updates (release.yml): the latest GitHub release's `latest.json`, its signature checked
// against the public key in tauri.conf.json. Found, the update downloads in the background;
// installing it restarts the app, so it waits for the user's word and goes through the leave
// gate first, like any other way out of the window. The core draws nothing: the shell asks.

import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { leaveWindow, stayWindow } from './leave.ts';

export type Ready = { version: string; restart: () => Promise<boolean>; };

/**
 * A downloaded update, ready to install, or null (none, or no way to check: offline, a dev
 * build, no key). Never throws.
 */
export async function updateReady(): Promise<Ready | null> {
  let u;
  try { u = await check(); } catch (e) { console.warn('[update] check', e); return null; }
  if (!u) return null;
  try { await u.download(); } catch (e) { console.warn('[update] download', e); return null; }
  const found = u;
  return {
    version: found.version,
    /** Leave (pages saved), install, restart. False: the window stays, nothing installed. */
    async restart() {
      if (!await leaveWindow('reload')) return false;
      try {
        await found.install();
        await relaunch();
        return true;
      } catch (e) {
        console.error('[update] install', e);
        stayWindow();
        return false;
      }
    },
  };
}
