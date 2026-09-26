// Vault path helpers. Paths are relative to the root, forward slashes, no leading slash.
//
// The shell's own copy of the kernel's `paths.js`: pure string functions with no state, which
// the sidebar, the title bar and the palette all need. Keep it in step with
// `src/kernel/paths.js`. There is no list of hidden names here any more: what is hidden is the
// host's one rule (dotfiles and the OS hidden attribute, `Entry.hidden`), and what is never
// listed at all (`.ose`, `.git`, the exe) never reaches the shell (docs/HOST.md).
import { ose } from 'ose:kernel';

export const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
export const baseName = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i < 0 ? c : c.slice(i + 1); };
export const dirName = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i < 0 ? '' : c.slice(0, i); };
export const extOf = (p) => { const b = baseName(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase(); };
export const isMd = (p) => extOf(p) === 'md';
export const join = (...parts) => parts.map(clean).filter(Boolean).join('/');
export const segments = (p) => clean(p).split('/').filter(Boolean);

/**
 * The name the chrome shows for a path (W8, H20): the real file name with its extension,
 * `.md` stripped only when the machine setting `hideMdExt` asks (`ose.names.display`). The
 * same rule for every file, in the tree, the tabs, the title bar and the palette.
 * @param {string} p a vault path
 * @returns {string}
 */
export const titleOf = (p) => {
  try {
    if (ose.names && typeof ose.names.display === 'function') return ose.names.display(clean(p));
  } catch { /* the plain name below */ }
  return baseName(p);
};
