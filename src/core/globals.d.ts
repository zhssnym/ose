// Names the core reads that no module declares: the build stamp Vite defines
// (vite.config.js `define`), and the debugging handles put on `window`. Referenced from the
// files that read them (`/// <reference path>`), for checkJs.

declare const __OSE_VERSION__: string | undefined;
declare const __OSE_SHA__: string | undefined;
declare const __OSE_SHORT__: string | undefined;
declare const __OSE_DATE__: string | undefined;

interface Window {
  /** Debugging handles only. */
  __ose?: unknown;
  __bridge?: unknown;
}

interface Navigator {
  /** Chromium's User-Agent Client Hints. */
  userAgentData?: { platform?: string };
}
