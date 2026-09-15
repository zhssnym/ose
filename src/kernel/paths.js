// Vault path helpers. Paths are relative to the root, forward slashes, no leading slash.
export const clean = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * `clean`, with `.` and `..` collapsed and every empty segment dropped: the form a path has to
 * be in before anyone may compare it with a folder.
 *
 * `clean` only straightens the separators, so `data/x/../../CLAUDE.md` still *starts with*
 * `data/x/` and walks straight through a `startsWith` guard — which is how a module escaped its
 * `data` sandbox and read and wrote the whole vault (QA-K defect 1). Every guard normalises
 * first now.
 *
 * A `..` that would climb above the root is dropped rather than kept: the vault root is the top
 * of this world, `..` above it means nothing, and the host's own `vault::resolve` does the same.
 * `resolve('x/../../CLAUDE.md')` is therefore `CLAUDE.md` — a path outside every module's
 * `data`, which is exactly what the guard must see so it can refuse it.
 */
export const resolve = (p) => {
  const out = [];
  for (const seg of clean(p).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
};

export const baseName = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i < 0 ? c : c.slice(i + 1); };
export const dirName = (p) => { const c = clean(p); const i = c.lastIndexOf('/'); return i < 0 ? '' : c.slice(0, i); };
export const extOf = (p) => { const b = baseName(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase(); };
export const isMd = (p) => extOf(p) === 'md';
export const stripMd = (name) => String(name).replace(/\.md$/i, '');
export const titleOf = (p) => stripMd(baseName(p));
export const join = (...parts) => parts.map(clean).filter(Boolean).join('/');
export const segments = (p) => clean(p).split('/').filter(Boolean);

// Segments never shown in the tree or search (CONTRACT.md "Paths"). _Archive is shown, last.
const HIDDEN = new Set(['.git', '.obsidian', '.claude', '.vscode', '.trash', 'node_modules', 'App', 'dist', 'dist-host', 'os.exe', 'os.pdb']);
export const isHiddenName = (name) => !name || name.startsWith('.') || HIDDEN.has(name);
