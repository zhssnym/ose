// The vault's asset origin, which the page needs synchronously, before the adapter is up.

import { assetPath } from '../paths.ts';

/** The platform before the host has said: from the user agent. */
export const guessPlatform = () => {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  return /Mac/.test(ua) ? 'macos' : /Windows/.test(ua) ? 'windows' : 'linux';
};

// Tauri serves custom protocols over http://<scheme>.localhost on Windows and <scheme>:// elsewhere.
export function vaultUrl(path: string, platform: string) {
  const p = assetPath(path);
  return platform === 'windows' ? `http://vault.localhost/${p}` : `vault://localhost/${p}`;
}
