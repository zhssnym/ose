// Updates (release.yml): the latest GitHub release's `latest.json`, its signature checked
// against the public key in tauri.conf.json. A found update downloads in the background;
// installing it restarts the app, so it waits for the user's word and goes through the leave
// gate first, like any other way out of the window. The core draws nothing: the shell asks.

import { getVersion } from '@tauri-apps/api/app';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { leaveWindow, stayWindow } from './leave.ts';

export type Ready = { version: string; restart: () => Promise<boolean>; };
export type Checked =
  | { status: 'none' }
  | ({ status: 'ready' } & Ready)
  | { status: 'error'; message: string };

/** The version of the app that is running, as the installer stamped it. */
export async function appVersion(): Promise<string> {
  try { return await getVersion(); } catch { return ''; }
}

/** Check, and download what is found. Never throws: a failure is `{status: 'error'}`. */
export async function checkForUpdate(): Promise<Checked> {
  let u;
  try { u = await check(); } catch (e) { return { status: 'error', message: messageOf(e) }; }
  if (!u) return { status: 'none' };
  try { await u.download(); } catch (e) { return { status: 'error', message: messageOf(e) }; }
  const found = u;
  return {
    status: 'ready',
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

/** A downloaded update, ready to install, or null (none, or no way to check). Never throws. */
export async function updateReady(): Promise<Ready | null> {
  const r = await checkForUpdate();
  if (r.status === 'error') console.warn('[update] check', r.message);
  return r.status === 'ready' ? r : null;
}

const messageOf = (e: unknown) => String((e && typeof e === 'object' && 'message' in e ? (e as Error).message : e) || 'unknown error');
