// File names (docs/KERNEL.md `ose.names`, H12, H13). The one place that says what a name may
// be, what its extension is and which name is free, so the tree, the palette, the editor and
// the router's "Create it" all agree.
//
// A name is literal: the name typed is the name written. Nothing here appends `.md`, strips an
// extension or "cleans" a character away. It only refuses what no file system on Windows or
// macOS can hold, and says why.

import { bridge } from './bridge/index.js';
import { clean, join, baseName } from './paths.js';
import { settings } from './settings-core.js';

// Windows refuses these as a whole name and as the part before the first dot (`con.txt`).
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const FORBIDDEN = /[\\:*?"<>|]/;
// Built from a string so the source holds no control character and no linter trips on one.
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]');
const MAX_SEGMENT = 255;

/**
 * `{ stem, ext }`, the extension without its dot and '' when there is none. A leading dot is
 * part of the stem: `.env` is `{ stem: '.env', ext: '' }`, and `a.tar.gz` is `a.tar` + `gz`.
 * @param {string} name
 * @returns {{stem: string, ext: string}}
 */
export function split(name) {
  const s = String(name ?? '');
  const base = s.slice(s.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return { stem: base, ext: '' };
  return { stem: base.slice(0, i), ext: base.slice(i + 1) };
}

/** Why one segment is not a name, or null when it is one. */
function segmentProblem(seg) {
  if (!seg) return 'a name cannot be empty';
  if (seg === '.' || seg === '..') return `"${seg}" is not a name`;
  const bad = FORBIDDEN.exec(seg);
  if (bad) return `a name cannot contain ${bad[0]}`;
  if (CONTROL.test(seg)) return 'a name cannot contain a control character';
  if (/[. ]$/.test(seg)) return 'a name cannot end with a dot or a space';
  if (RESERVED.test(seg.split('.')[0].trimEnd())) return `"${seg}" is reserved by Windows`;
  if (seg.length > MAX_SEGMENT) return `a name cannot be longer than ${MAX_SEGMENT} characters`;
  return null;
}

/**
 * Is `name` a name a file can have on Windows and macOS? Surrounding whitespace is trimmed and
 * nothing else is touched. With `folders`, `/` separates folders and every segment is checked;
 * without it a `/` is refused.
 * @param {string} name
 * @param {{folders?: boolean}} [opts]
 * @returns {{ok: true, name: string} | {ok: false, reason: string}}
 */
export function check(name, { folders = false } = {}) {
  const s = String(name ?? '').trim();
  if (!s) return { ok: false, reason: 'a name cannot be empty' };
  if (s.includes('/') && !folders) return { ok: false, reason: 'a name cannot contain /' };
  for (const seg of folders ? s.split('/') : [s]) {
    const why = segmentProblem(seg);
    if (why) return { ok: false, reason: seg || !folders ? why : 'a folder name cannot be empty' };
  }
  return { ok: true, name: s };
}

/**
 * The first free vault path for `name` in `folder`: the name itself, then `stem 2.ext`,
 * `stem 3.ext`, … With `dir`, the whole name is the stem, so a folder `v1.2` becomes `v1.2 2`
 * rather than `v1 2.2`. Asks the host; a race with a file that arrives after the answer is
 * settled by the host's exclusive create, not here.
 * @param {string} folder  vault-relative, '' for the root
 * @param {string} name
 * @param {{dir?: boolean}} [opts]
 * @returns {Promise<string>}
 */
export async function free(folder, name, { dir: isDir = false } = {}) {
  const first = join(folder, name);
  if (!(await bridge.exists(first))) return first;
  const last = clean(name).split('/').pop();
  const { stem, ext } = isDir ? { stem: last, ext: '' } : split(last);
  const dir = join(folder, clean(name).split('/').slice(0, -1).join('/'));
  for (let n = 2; n < 10000; n++) {
    const candidate = join(dir, `${stem} ${n}${ext ? '.' + ext : ''}`);
    if (!(await bridge.exists(candidate))) return candidate;
  }
  throw Object.assign(new Error(`no free name for ${name}`), { code: 'exists' });
}

/**
 * The name the chrome shows for a path (W8, H20): the file's real name with its extension,
 * everywhere, the same for every file. Only the machine setting `hideMdExt` strips a `.md`,
 * and only for display. '' for the vault root: the caller says the vault's name there.
 * @param {string} path
 * @returns {string}
 */
export function display(path) {
  const name = baseName(path);
  if (!name) return '';
  if (settings().hideMdExt === true && /\.md$/i.test(name) && name.length > 3) return name.slice(0, -3);
  return name;
}

/**
 * True when the two names have different extensions, compared without case: `a.md` → `a.MD`
 * is not a change, `a.md` → `a.txt` and `a.md` → `a` are.
 * @param {string} a
 * @param {string} b
 */
export function extChanged(a, b) {
  return split(a).ext.toLowerCase() !== split(b).ext.toLowerCase();
}
