// Host refusals, as every adapter and the facade throw them. Its own module so that an adapter
// (./tauri.js) can make one without importing the facade that loads it.

/**
 * A host refusal as the rest of the app reads it (docs/HOST.md "Errors"): the host answers
 * `{code, message}` (the dev bridge `[code] message`), and the caller gets an `Error` whose
 * `message` is the message, `.code` the code (`io` when the host gave none, or the transport
 * failed) and `.cmd` the command's name. `String(e)` is the message alone, so a toast that
 * prints `e` says what it always said.
 */
export class HostError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {string} [cmd]
   */
  constructor(message, code = 'io', cmd = '') {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.cmd = cmd;
  }
  toString() { return this.message; }
}

const CODED = /^\s*\[([a-z0-9_]+)\]\s*([\s\S]*)$/;

/**
 * Whatever an adapter rejected with (a `{code, message}` from a typed command, a `[code]`
 * string from the dev bridge, an Error from fetch) as a HostError.
 * @param {string} cmd
 * @param {unknown} raw
 * @returns {HostError}
 */
export function hostError(cmd, raw) {
  if (raw instanceof HostError) return raw;
  if (raw && typeof raw === 'object' && 'code' in raw && typeof raw.code === 'string' && raw.code) {
    const message = 'message' in raw ? String(raw.message ?? '') : '';
    return new HostError(message || raw.code, raw.code, cmd);
  }
  const text = raw && typeof raw === 'object' && 'message' in raw ? String(raw.message) : String(raw ?? 'host error');
  const m = CODED.exec(text);
  return m ? new HostError(m[2] || m[1] || text, m[1], cmd) : new HostError(text, 'io', cmd);
}
