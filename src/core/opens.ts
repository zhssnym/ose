// What the operating system asks the app to open (§5.3 of the wave-3 contract): a file
// double-clicked in Explorer or Finder, or named on the command line, which the OS hands to the
// Rust host (src-tauri/src/main.rs, windows.rs `open_path`). The host turns each one into an
// OpenRequest (`{ path, outside, kind, line? }`, `path` a vault path or `abs:`), and either
// queues it for a window that is still booting or sends it to a running one as the `open`
// event.
//
// This file takes them. A booting window takes its queue (`takeOpens`) once the router has put
// its first surface up, after session restore, so the restored tabs come first and the files
// the OS asked for open over them, each in a tab of its own; the last one comes forward. A
// running window does the same with each `open` event. A request for a folder opens the folder.
// Nothing here writes a file.

import { bus } from './registry.ts';
import { bridge } from './bridge/index.ts';
import { openTab } from './router.ts';
import { logLine } from './log.ts';
import { toast } from '../ui/toast.ts';
import { baseName, isOutside, outsideLabel } from './paths.ts';

export type OpenRequest = import('./bridge/commands.ts').OpenRequest;

let started = false;
/** requests are opened one batch after the other, in the order they came */
let chain: Promise<void> = Promise.resolve();

/**
 * A request as the route it opens: a folder route for a folder, a page route otherwise, with
 * the line when the request named one. Null when it is not a request.
 */
export function routeOf(r: unknown): import('./types.ts').Route | null {
  if (!r || typeof r !== 'object') return null;
  const req = (r as Partial<OpenRequest>);
  if (typeof req.path !== 'string' || !req.path) return null;
  if (req.kind === 'dir') return { type: 'folder', path: req.path };
  const route: import('./types.ts').Route = { type: 'page', path: req.path };
  if (typeof req.line === 'number' && Number.isInteger(req.line) && req.line > 0) route.line = req.line;
  return route;
}

/**
 * Open a batch: every request in a tab of its own (a tab that already shows the file is reused),
 * the last one brought forward. Answers how many were opened.
 */
export function openRequests(requests: unknown[]): Promise<number> {
  const routes: import('./types.ts').Route[] = [];
  for (const q of Array.isArray(requests) ? requests : []) { const r = routeOf(q); if (r) routes.push(r); }
  const run = chain.then(async () => {
    let opened = 0;
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      if (!route || route.type === 'view') continue;
      const last = i === routes.length - 1;
      try {
        const r = await openTab(route, { activate: last, reuse: true });
        if (r && r.id) opened++;
        const where = route.type === 'folder' ? route.path || '/' : (isOutside(route.path) ? outsideLabel(route.path) : route.path);
        logLine(`opens ${route.type} ${where}`);
      } catch (e) {
        console.error('[opens]', e);
        toast(`Could not open ${baseName(route.path) || 'the file'}: ${(e && (e as Error).message) || e}`, 'err', 0);
      }
    }
    return opened;
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/** The queue the host kept for this window while it booted. */
async function takeQueued() {
  let list: any[] = [];
  try {
    list = await bridge.takeOpens();
  } catch (e) {
    logLine(`opens: takeOpens failed: ${(e && (e as { code?: string }).code) || 'io'} ${(e && (e as Error).message) || e}`, 'warn');
    return;
  }
  if (Array.isArray(list) && list.length) await openRequests(list);
}

/**
 * Start taking what the OS asks for: called once by the core at boot. The queue is taken
 * after the first route change (the restored session or Home), so nothing the OS asked for is
 * drawn under a surface that replaces it a moment later.
 */
export function initOpens() {
  if (started) return;
  started = true;
  bridge.on('open', (d) => {
    const requests = d && typeof d === 'object' && Array.isArray(d.requests) ? d.requests : [];
    if (requests.length) void openRequests(requests);
  });
  const off = bus.on('route', () => {
    off();
    void takeQueued();
  });
}
