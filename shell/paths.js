// Vault path helpers. Paths are relative to the root, forward slashes, no leading slash.
//
// The shell's own copy of the kernel's `paths.js`: pure string functions with no state, which
// the sidebar, the title bar and the palette all need. Keep it in step with
// `src/kernel/paths.js`. There is no list of hidden names here any more: what is hidden is the
// host's one rule (dotfiles and the OS hidden attribute, `Entry.hidden`), and what is never
// listed at all (`.ose`, `.git`, the exe) never reaches the shell (docs/HOST.md).
//
// One other form exists (X7): a file outside the vault is `abs:` and its absolute path with
// forward slashes (`abs:D:/Notes/todo.md`, `abs:/Users/h/a.md`). `clean` keeps the prefix, and
// `isOutside` tells the two apart. The few helpers every surface used to keep a copy of
// (`vaultName`, `errorOf`, `keyOf`) live here too, so there is one of each.
import { ose } from 'ose:kernel';

export const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
export const baseName = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i < 0 ? c : c.slice(i + 1); };
export const dirName = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i < 0 ? '' : c.slice(0, i); };
export const extOf = (p) => { const b = baseName(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase(); };
export const isMd = (p) => extOf(p) === 'md';
export const join = (...parts) => parts.map(clean).filter(Boolean).join('/');
export const segments = (p) => clean(p).split('/').filter(Boolean);

/** The prefix of a path outside the vault (X7). */
export const ABS = 'abs:';

/**
 * True for an `abs:` path: a file outside the vault, opened in a tab marked so.
 * @param {unknown} p
 * @returns {boolean}
 */
export const isOutside = (p) => typeof p === 'string' && p.startsWith(ABS);

/**
 * What the chrome shows for an `abs:` path: the absolute path without the prefix. A vault
 * path comes back as it was.
 * @param {string} p
 * @returns {string}
 */
export const outsideLabel = (p) => (isOutside(p) ? p.slice(ABS.length) : p);

/**
 * The vault's name as the chrome says it, or `fallback` while the kernel has none.
 * @param {string} [fallback]
 * @returns {string}
 */
export const vaultName = (fallback = 'Vault') => (ose.vault && ose.vault.name) || fallback;

/**
 * A `[code] message` string, or an Error with a code, as `{ code, message }`. The code is the
 * error's own when it carries one (`HostError`), else the bracketed prefix of its message, else
 * null; the message never keeps the prefix.
 * @param {unknown} e
 * @returns {{code: string|null, message: string}}
 */
export function errorOf(e) {
  const text = String((e && typeof e === 'object' && 'message' in e ? e.message : e) ?? '');
  const m = /^\[(\w+)\]\s*(.*)$/s.exec(text);
  const own = e && typeof e === 'object' && e.code ? String(e.code) : null;
  return { code: own || (m ? m[1] : null), message: m ? m[2] : text };
}

/**
 * One string per place, the way the kernel's router keys a route: `view:<name>` for a view,
 * `<type>:<path>` for a page or a folder. Two routes to the same place have the same key.
 * @param {{type: string, name?: string, path?: string}|null|undefined} r
 * @returns {string}
 */
export const keyOf = (r) => (!r ? '' : r.type === 'view' ? 'view:' + r.name : `${r.type}:${clean(r.path)}`);

/**
 * The name the chrome shows for a path (W8, H20): the real file name with its extension,
 * `.md` stripped only when the machine setting `hideMdExt` asks (`ose.names.display`). The
 * same rule for every file, in the tree, the tabs, the title bar and the palette.
 * @param {string} p a vault path
 * @returns {string}
 */
export const titleOf = (p) => {
  try { return ose.names.display(clean(p)); } catch { /* the plain name below */ }
  return baseName(p);
};
