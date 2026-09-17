// `ose.run` (docs/KERNEL.md): start a program, stream its lines, wait for it, kill it.
//
// The host does the spawning (K1a). `bridge.run(id, cmd, args, opts)` resolves `{ id, pid }`
// **the moment the process has started**, and nothing else: every byte of output arrives as
// the bridge event `run` `{ id, stream, line }`, closed by `{ id, done: true, code, timedOut }`.
// So the promise `ose.run` answers is the one built here, out of the `done` event, and the
// stdout and stderr it carries are the streamed lines joined with `\n` — the host never
// buffers them.
//
// The id is minted here so `onLine` is subscribed before the call leaves, and so
// `ose.run.kill(id)` can reach a process whose promise has not settled.
//
// From K1a, and what this file leans on:
//   - `done` is emitted after both reader threads hit EOF, so no line can arrive after it;
//   - a line carries no trailing newline and no CR, and a final partial line is emitted
//     before `done`;
//   - `code` is null when the process was killed (`runKill`, or the timeout) and the exit code
//     otherwise; `timedOut` is true only for the timeout, never for a `runKill`.
//
// Never a shell: `cmd` is a program name and `args` an array. `cwd` is vault-relative and the
// host refuses one outside the vault. There is no allow list: a plugin is the vault owner's own
// code and may run any program (docs/PLUGINS.md).

import { bridge } from './bridge/index.js';
import { uid } from './registry.js';

const DEFAULT_TIMEOUT = 60000;

// id -> { onLine, stdout, stderr, finish(result), fail(error) }
const live = new Map();
let subscribed = false;

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  bridge.on('run', (d) => {
    if (!d || !d.id) return;
    const proc = live.get(d.id);
    if (!proc) return;
    if (d.done) {
      live.delete(d.id);
      proc.finish({
        // KERNEL.md: `code` is null when the process was killed, and the timeout is a kill.
        // The dev bridge already answers null; the Tauri host answers the exit code the OS
        // gave the killed process (1 on Windows), so a plugin branching on `code === null`
        // behaved differently in dev and in the window (QA-K defect 7). The kernel is what
        // turns the host's stream into this one promise, so it is where the two are made to
        // agree — and the host should stop reporting a code for a kill as well.
        code: d.timedOut || !Number.isInteger(d.code) ? null : d.code,
        stdout: proc.stdout.join('\n'),
        stderr: proc.stderr.join('\n'),
        timedOut: !!d.timedOut,
      });
      return;
    }
    const line = String(d.line ?? '');
    const stream = d.stream === 'stderr' ? 'stderr' : 'stdout';
    proc[stream].push(line);
    if (proc.onLine) { try { proc.onLine(line, stream); } catch (e) { console.error('[run] onLine', e); } }
  });
}

/**
 * run(cmd, args, opts) -> Promise<{ code, stdout, stderr, timedOut }>, settled on `done`.
 * opts: { cwd, timeout, env, input, onLine(line, stream), onStart(id, pid) }
 */
export function run(cmd, args = [], opts = {}) {
  subscribe();
  const id = opts.id || uid();

  let finish;
  let fail;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  live.set(id, {
    onLine: typeof opts.onLine === 'function' ? opts.onLine : null,
    stdout: [], stderr: [], finish, fail,
  });

  const hostOpts = {
    cwd: opts.cwd,
    timeout: Number.isFinite(opts.timeout) ? opts.timeout : DEFAULT_TIMEOUT,
    env: opts.env,
    input: opts.input,
  };
  for (const k of Object.keys(hostOpts)) if (hostOpts[k] === undefined) delete hostOpts[k];

  // The start is its own promise: a refusal (a cwd outside the vault, a program the host
  // cannot spawn) rejects here and there will never be a `done` to wait for.
  bridge.run(id, String(cmd), (args || []).map(String), hostOpts)
    .then((started) => {
      if (typeof opts.onStart === 'function') {
        try { opts.onStart(id, started && started.pid); } catch (e) { console.error('[run] onStart', e); }
      }
    })
    .catch((e) => { live.delete(id); fail(e); });

  return done;
}

run.kill = (id) => bridge.runKill(id);

/** Every process this page started that has not reported done: killed on unload and on quit. */
export function killAll() {
  for (const id of [...live.keys()]) { try { void bridge.runKill(id); } catch { /* going away */ } }
  live.clear();
}

/** Whether this page is still waiting on a process with that id. */
export function isLive(id) { return live.has(id); }
